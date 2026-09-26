import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { KodaXBaseProvider, registerModelProvider } from '@kodax-ai/llm';
import type { KodaXProviderConfig, KodaXStreamResult } from '@kodax-ai/llm';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

it('audit: default workflow mode disagrees with product view and explicit Edits', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-audit-workflow-default-'));
  const target = path.join(homeDir, 'workflow-write.txt');
  class Provider extends KodaXBaseProvider {
    readonly name = 'audit-workflow-default';
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_AUDIT_WORKFLOW_KEY', model: 'audit', supportsThinking: false };
    async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
      const hasResult = args[0].some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'));
      return hasResult ? { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' }
        : { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: randomUUID(), name: 'write', input: { path: target, content: 'written' } }], stopReason: 'tool_use' };
    }
  }
  const unregister = registerModelProvider('audit-workflow-default', () => new Provider());
  vi.stubEnv('KODAX_AUDIT_WORKFLOW_KEY', 'test-only');
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'audit-workflow-default' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt });
  if (!lock) throw new Error('Missing isolated Host lock.');
  const endpointPath = process.platform === 'win32' ? `\\\\.\\pipe\\kodax-audit-workflow-${randomUUID()}` : path.join(homeDir, 'host.sock');
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint: { kind: process.platform === 'win32' ? 'pipe' : 'unix', path: endpointPath } });
  const client = await connectKodaXClient({ homeDir, endpoint: endpointPath });
  try {
    const session = await client.sessions.create({ projectPath: homeDir });
    await client.sessions.updateSettings(session.id, { provider: 'audit-workflow-default', agentMode: 'sa' });
    let displayedMode: string | undefined;
    const observation = await client.sessions.observe(session.id, view => { displayedMode = view.settings.permissionMode; });
    expect(displayedMode).toBe('accept-edits');
    observation.close();
    const start = () => client.workflows.start({ sessionId: session.id, projectRoot: homeDir, source: {
      kind: 'inline', manifest: { name: 'audit-default', description: 'Write one temporary fixture file.', readOnly: false, maxAgents: 2, maxConcurrency: 1, phases: ['implement'], patterns: ['fan-out-and-synthesize'] },
      source: 'async function run(wf) { const result = await wf.runAgent({ name: "writer", prompt: "Write the requested temporary fixture file once.", readOnly: false }); return { synthesis: result.finalText }; }',
    } });
    const first = await start();
    if (first.kind !== 'started') throw new Error(first.reason);
    await expect.poll(async () => (await client.interactions.list({ sessionId: session.id })).some(request => request.kind === 'permission' && request.options.toolName === 'write'), { timeout: 20000 }).toBe(true);
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const request of await client.interactions.list({ sessionId: session.id })) await client.interactions.respond(request.requestId, { kind: 'cancel' });
    await client.runs.await(first.runId);
    await client.sessions.updateSettings(session.id, { permissionMode: 'accept-edits' });
    const second = await start();
    if (second.kind !== 'started') throw new Error(second.reason);
    await expect.poll(async () => readFile(target, 'utf8').catch(() => ''), { timeout: 20000 }).toBe('written');
    expect(await client.interactions.list({ sessionId: session.id })).toEqual([]);
    await client.runs.await(second.runId);
  } finally {
    for (const run of await runtime.runs.list()) if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(run.phase)) await runtime.runs.abort(run.runId);
    await client.disconnect(); await host.close(); await runtime.close();
    unregister(); vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3 });
  }
}, 60000);
