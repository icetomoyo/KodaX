import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TransformStream } from 'node:stream/web';
import { expect, it, vi } from 'vitest';
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream, type RequestPermissionRequest, type SessionNotification } from '@agentclientprotocol/sdk';
import { KodaXBaseProvider, registerModelProvider, clearRuntimeModelProviders, type KodaXMessage, type KodaXStreamResult,
  type KodaXToolDefinition, type KodaXReasoningRequest } from '@kodax-ai/llm';
import type { KodaXProductClient } from '@kodax-ai/coding/client-contract';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

const launcher = vi.hoisted(() => ({ ensure: vi.fn<() => Promise<KodaXProductClient>>() }));
vi.mock('./sdk-client.js', async importOriginal => ({
  ...await importOriginal<typeof import('./sdk-client.js')>(), ensureKodaXClient: launcher.ensure,
}));
import { connectKodaXClient } from './sdk-client.js';
import { KodaXAcpServer } from './acp_server.js';

it('delivers complete plan approval and preserves Host mode and effort across ACP prompts', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-acp-contract-'));
  const plan = `Plan\n${'完整实施和验证步骤。'.repeat(3000)}\nEND OF PLAN`;
  let firstTurn = true;
  const reasoningRequests: (boolean | KodaXReasoningRequest | undefined)[] = [];
  class Provider extends KodaXBaseProvider {
    readonly name = 'acp-contract';
    readonly supportsThinking = true;
    protected readonly config = { apiKeyEnv: 'KODAX_ACP_CONTRACT_KEY', model: 'fixture', supportsThinking: true };
    async stream(_messages: KodaXMessage[], _tools: KodaXToolDefinition[], _system: string,
      reasoning?: boolean | KodaXReasoningRequest): Promise<KodaXStreamResult> {
      if (_tools.some(tool => tool.name === 'commit_episode_learning_review')) {
        return { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'review',
          name: 'commit_episode_learning_review', input: { memoryPlan: { actions: [], warnings: [] },
            capabilityDecision: { disposition: 'discard' } } }], stopReason: 'tool_use' };
      }
      reasoningRequests.push(reasoning);
      if (firstTurn) {
        firstTurn = false;
        return { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'plan', name: 'exit_plan_mode', input: { plan } }], stopReason: 'tool_use' };
      }
      return { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  vi.stubEnv('KODAX_ACP_CONTRACT_KEY', 'fixture');
  registerModelProvider('acp-contract', () => new Provider());
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'acp-contract' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt });
  if (!lock) throw new Error('Cannot lock isolated ACP Host');
  const endpoint = process.platform === 'win32' ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-acp-contract-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  const product = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
  const other = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
  await other.config.patch({ agentMode: 'sa' });
  launcher.ensure.mockResolvedValue(product);
  const server = new KodaXAcpServer({ homeDir, provider: 'acp-contract', permissionMode: 'plan', planModeEffort: 'medium', logLevel: 'off' });
  const requests = new TransformStream<Uint8Array, Uint8Array>();
  const responses = new TransformStream<Uint8Array, Uint8Array>();
  const approvals: RequestPermissionRequest[] = [];
  const updates: SessionNotification[] = [];
  let planEffort: string | undefined;
  server.attach(requests.readable, responses.writable);
  const acp = new ClientSideConnection(() => ({ sessionUpdate: async update => { updates.push(update); },
    requestPermission: async request => {
      approvals.push(request);
      const observation = await other.sessions.observe(request.sessionId, view => { planEffort = view.settings.effort; });
      observation.close();
      return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
    },
  }), ndJsonStream(requests.writable, responses.readable));
  try {
    await acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await acp.newSession({ cwd: homeDir, mcpServers: [] });
    await acp.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Prepare plan.' }] });
    expect(approvals[0]?.toolCall.rawInput).toEqual({ plan });
    expect(approvals[0]?.toolCall.content).toContainEqual({ type: 'content', content: { type: 'text', text: plan } });
    expect(planEffort).toBe('medium');
    expect(reasoningRequests[0]).toMatchObject({ effort: 'medium' });
    expect(await other.sessions.getSettings(session.sessionId)).toMatchObject({ permissionMode: 'accept-edits' });
    expect(updates).toContainEqual({ sessionId: session.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: 'accept-edits' } });
    await acp.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Continue.' }] });
    expect(await other.sessions.getSettings(session.sessionId)).toMatchObject({ permissionMode: 'accept-edits' });
    expect(reasoningRequests.at(-1)).not.toMatchObject({ effort: 'medium' });
    await acp.setSessionMode({ sessionId: session.sessionId, modeId: 'plan' });
    await other.sessions.updateSettings(session.sessionId, { effort: 'high' });
    await acp.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Respect explicit effort.' }] });
    expect(reasoningRequests.at(-1)).toMatchObject({ effort: 'high' });
    await other.sessions.updateSettings(session.sessionId, { effort: null });
    await acp.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Use plan default again.' }] });
    expect(reasoningRequests.at(-1)).toMatchObject({ effort: 'medium' });
    await other.sessions.updateSettings(session.sessionId, { planModeEffort: null });
    await acp.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Clear plan default.' }] });
    expect(reasoningRequests.at(-1)).not.toMatchObject({ effort: 'medium' });
    await other.sessions.updateSettings(session.sessionId, { permissionMode: 'full-access', effort: 'none' });
    await acp.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Continue with shared settings.' }] });
    expect(await other.sessions.getSettings(session.sessionId)).toMatchObject({ permissionMode: 'full-access', effort: 'none' });
    expect(updates).toContainEqual({ sessionId: session.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: 'full-access' } });
  } finally {
    await server.dispose(); await other.disconnect(); await host.close(); await runtime.close();
    clearRuntimeModelProviders(); vi.unstubAllEnvs(); launcher.ensure.mockReset();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5 });
  }
}, 30_000);
