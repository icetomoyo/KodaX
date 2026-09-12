import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, clearRuntimeModelProviders,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult } from '@kodax-ai/llm';
import { connectKodaXClient } from './sdk-client.js';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';
import { runOneShotClientTask } from './one-shot-task.js';

it('rejects only its accepted one-shot permission even when the permission predates the submit receipt', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-one-shot-permission-'));
  const marker = path.join(homeDir, '.kodax', 'must-not-write.txt');
  const requests: KodaXMessage[][] = [];
  class Provider extends KodaXBaseProvider {
    readonly name = 'one-shot-permission-test';
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { model: this.name, apiKeyEnv: 'KODAX_ONE_SHOT_PERMISSION_KEY', supportsThinking: false };
    async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
      requests.push(structuredClone(messages));
      return messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'))
        ? { textBlocks: [{ type: 'text', text: 'Permission was rejected.' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' }
        : { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{ type: 'tool_use', id: randomUUID(),
          name: 'write', input: { path: marker, content: 'must not write' } }] };
    }
  }
  vi.stubEnv('KODAX_ONE_SHOT_PERMISSION_KEY', 'test-only');
  registerModelProvider('one-shot-permission-test', () => new Provider());
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'one-shot-permission-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt });
  if (!lock) throw new Error('Could not lock one-shot Host');
  const endpoint = process.platform === 'win32' ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-one-shot-permission-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  const client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
  const controller = new AbortController();
  let foreignRunId: string | undefined;
  let pending: ReturnType<typeof runOneShotClientTask> | undefined;
  const closed = vi.fn();
  let observedBeforeReceipt = false;
  try {
    const session = await client.sessions.create({ projectPath: homeDir });
    const foreign = await client.sessions.create({ projectPath: homeDir });
    for (const id of [session.id, foreign.id]) await client.sessions.updateSettings(id, { agentMode: 'sa', permissionMode: 'accept-edits' });
    foreignRunId = (await client.inputs.submit({ sessionId: foreign.id, inputId: 'foreign', text: 'Foreign write.' })).runId;
    const scopedClient = { ...client,
      sessions: { ...client.sessions, observe: async (...args: Parameters<typeof client.sessions.observe>) => {
        const observation = await client.sessions.observe(args[0], view => {
          if (view.interactions.some(item => item.kind === 'permission')) observedBeforeReceipt = true;
          args[1](view);
        }, args[2]);
        return { ...observation, close: () => { closed(); observation.close(); } };
      } },
      inputs: { ...client.inputs, submit: async (...args: Parameters<typeof client.inputs.submit>) => {
        const accepted = await client.inputs.submit(...args);
        await expect.poll(async () => (await client.interactions.list({ sessionId: session.id })).some(item => item.kind === 'permission'),
          { timeout: 15_000 }).toBe(true);
        // The one-shot observation must receive the pending view before admission returns.
        await new Promise(resolve => setTimeout(resolve, 200));
        return accepted;
      } },
    };
    pending = runOneShotClientTask({ client: scopedClient, runtime, abortSignal: controller.signal,
      options: { provider: 'one-shot-permission-test', agentMode: 'sa', session: { id: session.id } }, prompt: 'Own write.' });
    let finished = false;
    void pending.then(() => { finished = true; });
    await expect.poll(() => finished, { timeout: 5_000 }).toBe(true);
    expect(observedBeforeReceipt).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    expect((await client.interactions.list({ sessionId: foreign.id })).some(item => item.kind === 'permission')).toBe(true);
    expect(await client.sessions.getSettings(session.id)).toMatchObject({ permissionMode: 'accept-edits' });
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(requests)).toContain('non-interactive');
  } finally {
    controller.abort();
    if (foreignRunId) await client.runs.stop(foreignRunId);
    if (pending) await Promise.allSettled([pending]);
    await client.disconnect(); await host.close(); await runtime.close();
    clearRuntimeModelProviders(); vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);
