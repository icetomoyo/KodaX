import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TransformStream } from 'node:stream/web';
import { expect, it, vi } from 'vitest';
import type { KodaXMessage, KodaXToolDefinition, KodaXReasoningRequest, KodaXProviderStreamOptions, KodaXStreamResult } from '@kodax-ai/llm';
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream, type SessionNotification } from '@agentclientprotocol/sdk';

vi.mock('@kodax-ai/agent', async (importOriginal) => ({
  ...await importOriginal<typeof import('@kodax-ai/agent')>(),
  isCurrentProcessWindowsJobContained: () => true,
}));

it('runs default ACP prompts in the existing shared Host and only detaches on disposal', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-acp-shared-'));
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('USERPROFILE', homeDir);
  vi.stubEnv('KODAX_HOME', path.join(homeDir, '.kodax'));
  vi.stubEnv('KODAX_ACP_TEST_KEY', 'local-test-key');
  const llm = await import('@kodax-ai/llm');
  let hold = false;
  let providerStarted = false;
  let markHeldProviderEntered = () => {};
  const heldProviderEntered = new Promise<void>(resolve => { markHeldProviderEntered = resolve; });
  let callTool = false;
  let callMcp = false;
  const { createMcpTestServerFixture } = await import('@kodax-ai/agent');
  const fixture = await createMcpTestServerFixture(homeDir);
  class Provider extends llm.KodaXBaseProvider {
    readonly name = 'acp-local';
    readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'KODAX_ACP_TEST_KEY', model: 'acp-local', supportsThinking: false };
    async stream(_messages: KodaXMessage[], _tools: KodaXToolDefinition[], _system: string,
      _reasoning?: boolean | KodaXReasoningRequest, options?: KodaXProviderStreamOptions): Promise<KodaXStreamResult> {
      if (_tools.some(tool => tool.name === 'commit_episode_learning_review')) {
        return { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'review', name: 'commit_episode_learning_review', input: { memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard' } } }], stopReason: 'tool_use' };
      }
      providerStarted = true;
      if (hold) { markHeldProviderEntered(); options?.onTextDelta?.('Waiting for Host interaction.'); }
      if (hold) await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener('abort', abort, { once: true });
      });
      if (callMcp) {
        callMcp = false;
        return { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'private-mcp', name: 'mcp_call', input: { id: fixture.toolId, args: { text: 'ACP private MCP' } } }], stopReason: 'tool_use' };
      }
      if (callTool) {
        callTool = false;
        return { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'read-probe', name: 'read', input: { path: probePath } }], stopReason: 'tool_use' };
      }
      options?.onTextDelta?.('Hel');
      await new Promise(resolve => setTimeout(resolve, 150));
      options?.onTextDelta?.('lo from shared Host.');
      return { textBlocks: [{ type: 'text', text: 'Hello from shared Host.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  llm.registerModelProvider('acp-local', () => new Provider());
  const { createKodaXRuntime } = await import('./sdk-runtime.js');
  const { startRuntimeDaemonHost } = await import('./runtime-daemon/host.js');
  const { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } = await import('./runtime-daemon/state.js');
  const { defaultRuntimeDaemonEndpoint } = await import('./runtime-daemon/transport.js');
  const { KodaXAcpServer } = await import('./acp_server.js');
  const probePath = path.join(homeDir, 'probe.txt');
  await (await import('node:fs/promises')).writeFile(probePath, 'ACP tool output');
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'acp-local' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Isolated ACP Host lock unavailable.');
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, ownsA2AConfigReconciler: true, endpoint: defaultRuntimeDaemonEndpoint('default', homeDir) });
  // ACP flags belong to the calling process; an already running Host has its own environment.
  vi.stubEnv('KODAX_REPO_INTELLIGENCE', 'light');
  vi.stubEnv('KODAX_REPO_INTELLIGENCE_TRACE', '1');
  const server = new KodaXAcpServer({ homeDir, provider: 'acp-local', permissionMode: 'full-access', logLevel: 'off' });
  vi.stubEnv('KODAX_REPO_INTELLIGENCE', 'off');
  vi.stubEnv('KODAX_REPO_INTELLIGENCE_TRACE', '0');
  const request = new TransformStream<Uint8Array, Uint8Array>();
  const response = new TransformStream<Uint8Array, Uint8Array>();
  const notifications: SessionNotification[] = [];
  let permissionRequests = 0;
  let holdDialog = false;
  const serverConnection = server.attach(request.readable, response.writable);
  const client = new ClientSideConnection(() => ({
    sessionUpdate: async (notification) => { notifications.push(notification); },
    requestPermission: async () => {
      permissionRequests++;
      if (holdDialog) return new Promise(() => {});
      return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
    },
  }), ndJsonStream(request.writable, response.readable));
  try {
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await client.newSession({ cwd: homeDir, mcpServers: [] });
    const result = await client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Say hello.' }] });
    expect(result.stopReason).toBe('end_turn');
    expect(await runtime.sessions.getSettings(session.sessionId)).toMatchObject({
      repoIntelligenceMode: 'light', repoIntelligenceTrace: true,
    });
    expect((await runtime.sessions.list()).map(item => item.id)).toContain(session.sessionId);
    expect((await runtime.runs.list({ sessionId: session.sessionId })).map(run => run.phase)).toEqual(['completed']);
    const text = notifications.flatMap(({ update }) => update.sessionUpdate === 'agent_message_chunk'
      && update.content.type === 'text' ? [update.content.text] : []).join('');
    expect(text).toBe('Hello from shared Host.');
    notifications.length = 0;
    callTool = true;
    await client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Read the probe.' }] });
    expect(notifications.filter(({ update }) => update.sessionUpdate === 'agent_message_chunk')
      .flatMap(({ update }) => 'content' in update && update.content && 'text' in update.content ? [update.content.text] : []).join('')).toBe('Hello from shared Host.');
    expect(notifications).toContainEqual(expect.objectContaining({ update: expect.objectContaining({
      sessionUpdate: 'tool_call', toolCallId: 'read-probe', rawInput: { path: probePath }, kind: 'read',
    }) }));
    expect(notifications).toContainEqual(expect.objectContaining({ update: expect.objectContaining({
      sessionUpdate: 'tool_call_update', toolCallId: 'read-probe', status: 'completed', rawOutput: expect.stringContaining('ACP tool output'),
    }) }));
    const mcpSession = await client.newSession({ cwd: homeDir, mcpServers: [{ name: fixture.serverId,
      command: process.execPath, args: [fixture.scriptPath], env: [] }] });
    notifications.length = 0;
    callMcp = true;
    await client.prompt({ sessionId: mcpSession.sessionId, prompt: [{ type: 'text', text: 'Use the private MCP.' }] });
    expect(notifications).toContainEqual(expect.objectContaining({ update: expect.objectContaining({
      sessionUpdate: 'tool_call_update', toolCallId: 'private-mcp', status: 'completed', rawOutput: expect.stringContaining('ACP private MCP'),
    }) }));
    expect(await runtime.mcp.listServers()).not.toHaveProperty(fixture.serverId);
    hold = true;
    providerStarted = false;
    const heldPrompt = client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Wait for approval.' }] });
    await heldProviderEntered;
    expect(providerStarted).toBe(true);
    const active = (await runtime.runs.list({ sessionId: session.sessionId })).find(run => run.phase === 'running');
    expect(active).toBeDefined();
    let queuedSettled = false;
    const queuedPrompt = client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Queued request must not execute.' }] })
      .then(result => { queuedSettled = true; return result; });
    const permission = runtime.permissions.request({ sessionId: session.sessionId, runId: active!.runId,
      toolCallId: 'approve-probe', toolName: 'bash', inputPreview: '{"command":"echo approved"}' });
    await expect(permission).resolves.toMatchObject({ type: 'allow_once' });
    expect(permissionRequests).toBe(1);
    expect(queuedSettled).toBe(false);
    holdDialog = true;
    const stale = runtime.permissions.request({ sessionId: session.sessionId, runId: active!.runId,
      toolCallId: 'stale-probe', toolName: 'bash', inputPreview: '{"command":"echo stale"}' });
    await expect.poll(() => permissionRequests).toBe(2);
    await client.cancel({ sessionId: session.sessionId });
    await expect(stale).resolves.toMatchObject({ type: 'reject' });
    await expect(heldPrompt).resolves.toMatchObject({ stopReason: 'cancelled' });
    await expect(queuedPrompt).resolves.toMatchObject({ stopReason: 'cancelled' });
    expect(['cancelled', 'interrupted']).toContain((await runtime.runs.get(active!.runId)).phase);
    vi.spyOn(serverConnection, 'sessionUpdate').mockRejectedValueOnce(new Error('Fixture notification transport failed'));
    const failedDelivery = await client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Fail notification delivery.' }] });
    expect(failedDelivery.stopReason).toBe('end_turn');
    await expect.poll(async () => (await runtime.runs.list({ sessionId: session.sessionId }))
      .every(run => run.phase !== 'running' && run.phase !== 'queued')).toBe(true);
    expect(notifications).toContainEqual(expect.objectContaining({ update: expect.objectContaining({
      content: { type: 'text', text: expect.stringContaining('Fixture notification transport failed') },
    }) }));
    await server.dispose();
    expect(await runtime.sessions.load(session.sessionId)).toBeTruthy();
  } finally {
    await server.dispose();
    await host.close();
    await runtime.close();
    llm.clearRuntimeModelProviders();
    vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60_000);
