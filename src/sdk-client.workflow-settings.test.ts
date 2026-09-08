import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createMcpTestServerFixture } from '@kodax-ai/agent';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { KodaXBaseProvider, registerModelProvider, clearRuntimeModelProviders } from '@kodax-ai/llm';
import type { KodaXProviderConfig, KodaXProviderStreamOptions, KodaXReasoningRequest, KodaXStreamResult, KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';
import { createKodaXRuntime, connectKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

it('inherits Session model, MCP, credential scope and Plan policy in real Workflow children', async () => {
  const requests: Array<{ provider: string; model?: string; effort?: string; credential: string; credentialChild: boolean }> = [];
  const writeAttempts: string[] = [];
  const toolResults: string[] = [];
  const forbiddenWritePath = path.join(process.cwd(), `.workflow-plan-${randomUUID()}.txt`);
  class Provider extends KodaXBaseProvider {
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_WORKFLOW_SETTINGS_TEST', model: 'default-model', supportsThinking: false };
    constructor(readonly name: string) { super(); }
    async stream(_messages: KodaXMessage[], _tools: KodaXToolDefinition[], _system: string, _reasoning?: boolean | KodaXReasoningRequest, options?: KodaXProviderStreamOptions): Promise<KodaXStreamResult> {
      requests.push({ provider: this.name, model: options?.modelOverride, effort: typeof _reasoning === 'object' ? _reasoning.effort : undefined, credential: this.getApiKey(), credentialChild: JSON.stringify(_messages).includes('CREDENTIAL-CHILD') });
      for (const message of _messages) {
        if (Array.isArray(message.content)) for (const block of message.content) {
          if (block.type === 'tool_result') toolResults.push(JSON.stringify(block.content));
        }
      }
      if (JSON.stringify(_messages).includes('MCP-CHILD') && !_messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result'))) {
        return { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'private-mcp', name: 'mcp_call', input: { id: fixture.toolId.replace(':demo:', ':private:'), args: { text: 'workflow inheritance' } } }], stopReason: 'tool_use' };
      }
      if (JSON.stringify(_messages).includes('PLAN-WRITE') && !_messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result'))) {
        writeAttempts.push('write');
        return { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'plan-write', name: 'write', input: { path: forbiddenWritePath, content: 'forbidden' } }], stopReason: 'tool_use' };
      }
      return { textBlocks: [{ type: 'text', text: 'The requested inspection is complete.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  registerModelProvider('workflow-default', () => new Provider('workflow-default'));
  registerModelProvider('workflow-session', () => new Provider('workflow-session'));
  vi.stubEnv('KODAX_WORKFLOW_SETTINGS_TEST', 'test-only');
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-workflow-settings-'));
  const fixture = await createMcpTestServerFixture(homeDir);
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'workflow-default' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt });
  if (!lock) throw new Error('Missing Workflow Host lock.');
  const endpointPath = process.platform === 'win32' ? `\\\\.\\pipe\\kodax-workflow-settings-${randomUUID()}` : path.join(homeDir, 'host.sock');
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint: { kind: process.platform === 'win32' ? 'pipe' : 'unix', path: endpointPath } });
  const client = await connectKodaXClient({ homeDir, endpoint: endpointPath });
  try {
    const session = await client.sessions.create({ projectPath: homeDir, mcpServers: { private: fixture.servers[fixture.serverId]! } });
    await client.sessions.updateSettings(session.id, { provider: 'workflow-session', model: 'session-model', effort: 'high', permissionMode: 'full-access' });
    const started = await client.workflows.start({ sessionId: session.id, projectRoot: homeDir, source: {
      kind: 'inline',
      manifest: { name: 'session-settings', description: 'Verify inherited settings.', readOnly: true, phases: ['investigate'], maxAgents: 2, maxConcurrency: 1, patterns: ['fan-out-and-synthesize'] },
      source: 'async function run(wf) { const result = await wf.runAgent({ name: "reader", prompt: "MCP-CHILD: Inspect the request with the private MCP tool.", readOnly: true }); return { synthesis: result.finalText }; }',
    } });
    expect(started.kind).toBe('started');
    if (started.kind !== 'started') throw new Error(started.reason);
    await expect.poll(async () => (await client.workflows.get(started.runId))?.status, { timeout: 20_000 }).toBe('completed');
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.provider === 'workflow-session' && request.model === 'session-model')).toBe(true);
    expect(requests[0]?.effort).toBe('high');
    expect(toolResults.join('\n')).toContain('echo:workflow inheritance');
    const lowLevelClient = await connectKodaXRuntime({ homeDir, endpoint: endpointPath, autoStart: false });
    try {
      const credentialRequests: unknown[] = [];
      const lease = await lowLevelClient.credentials.registerScoped({ providers: ['workflow-session'] }, async (request) => {
        credentialRequests.push(request);
        return 'workflow-fixture-credential';
      });
      const before = requests.length;
      const bound = await lowLevelClient.workflows.start({ sessionId: session.id, projectRoot: homeDir,
        credential: { leaseId: lease.id, mode: 'scoped', providers: ['workflow-session'] },
        source: { kind: 'inline', manifest: { name: 'credential-workflow', description: 'Verify credential scope.', readOnly: true, maxAgents: 2, maxConcurrency: 1, phases: ['investigate'], patterns: ['fan-out-and-synthesize'] },
          source: 'async function run(wf) { const result = await wf.runAgent({ name: "reader", prompt: "CREDENTIAL-CHILD: Inspect the request.", readOnly: true }); return { synthesis: result.finalText }; }' },
      });
      if (bound.kind !== 'started') throw new Error(bound.reason);
      const outcome = await lowLevelClient.runs.await(bound.runId);
      expect(outcome.phase, JSON.stringify(outcome)).toBe('completed');
      const childRequests = requests.slice(before).filter((request) => request.credentialChild);
      expect(childRequests.length).toBeGreaterThan(0);
      expect(childRequests.every((request) => request.credential === 'workflow-fixture-credential')).toBe(true);
      expect(credentialRequests).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: session.id, target: expect.objectContaining({ kind: 'actor_turn', parentRunId: bound.runId }) })]));
      await lowLevelClient.credentials.revoke(lease.id);
    } finally { await lowLevelClient.close(); }
    await client.sessions.updateSettings(session.id, { permissionMode: 'plan' });
    const plan = await client.workflows.start({ sessionId: session.id, projectRoot: homeDir,
      source: { kind: 'inline', manifest: { name: 'plan-workflow', description: 'Verify Plan policy.', readOnly: false, maxAgents: 2, maxConcurrency: 1, phases: ['implement'], patterns: ['fan-out-and-synthesize'] },
        source: 'async function run(wf) { const result = await wf.runAgent({ name: "writer", prompt: "PLAN-WRITE: write the requested file.", readOnly: false }); return { synthesis: result.finalText }; }' },
    });
    if (plan.kind !== 'started') throw new Error(plan.reason);
    await runtime.runs.await(plan.runId);
    expect(writeAttempts.length).toBeGreaterThan(0);
    expect(toolResults.join('\n')).toContain('Plan mode');
    await expect(readFile(forbiddenWritePath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await client.disconnect();
    await host.close();
    await runtime.close();
    clearRuntimeModelProviders();
    vi.unstubAllEnvs();
    await rm(forbiddenWritePath, { force: true });
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);
