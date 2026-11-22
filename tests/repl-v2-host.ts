/**
 * A real Host with a scripted model, for the tests of the REPL's v2 adapter.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { vi } from 'vitest';
import { awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { KodaXBaseProvider, registerModelProvider, type KodaXProviderConfig, type KodaXStreamResult } from '@kodax-ai/llm';
import type { InkClientPlane } from '@kodax-ai/repl';

import { createKodaXRuntime } from './runtime-fixture.js';
import { connectHostRpc } from '../src/host-protocol/client.js';
import { createKodaXHostClient, createRequestId, type KodaXHostClient } from '../src/host-protocol/host-client.js';
import { startRuntimeDaemonHost } from '../src/runtime-daemon/host.js';
import { dialRuntimeDaemonHostRpc, type RuntimeDaemonEndpoint } from '../src/runtime-daemon/transport.js';
import { readRuntimeDaemonToken, resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from '../src/runtime-daemon/state.js';
import { createReplClientPlane } from '../src/repl-host/plane.js';

export const MODEL = 'repl-v2-model';
/** Longer than a view sends of one item, so the rest must be read. */
export const LONG_REPLY = `${'a long reply '.repeat(1_200)}END`;

type ModelMode = 'answer' | 'ask' | 'hold';

const cleanup: Array<() => Promise<void> | void> = [];

/** Closes every Host `replHost` started; run it after each test. */
export async function disposeReplHosts(): Promise<void> {
  for (const task of cleanup.splice(0).reverse()) await task();
}

interface ScriptedModel {
  readonly provider: () => KodaXBaseProvider;
  readonly releaseAll: () => void;
}

function scriptedModel(mode: ModelMode): ScriptedModel {
  const held = new Set<() => void>();
  class ScriptedProvider extends KodaXBaseProvider {
    readonly name = MODEL;
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_REPL_V2_KEY', model: MODEL, supportsThinking: false };
    async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
      const [messages, tools, , , , signal] = args;
      if (tools.some(tool => tool.name === 'commit_episode_learning_review')) {
        return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{
          type: 'tool_use', id: 'review', name: 'commit_episode_learning_review',
          input: { memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard' } },
        }] };
      }
      if (mode === 'hold') {
        await new Promise<void>((resolve, reject) => {
          const release = (): void => { held.delete(release); resolve(); };
          held.add(release);
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener('abort', () => { held.delete(release); reject(signal.reason); }, { once: true });
        });
      }
      const last = messages.at(-1)?.content;
      const answered = Array.isArray(last) && last.some(block => block.type === 'tool_result');
      if (mode === 'ask' && !answered) {
        return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{
          type: 'tool_use', id: 'ask-1', name: 'ask_user_question',
          input: { question: 'Which colour?', options: [{ label: 'Red', value: 'red' }, { label: 'Blue', value: 'blue' }] },
        }] };
      }
      return { textBlocks: [{ type: 'text', text: LONG_REPLY }], toolBlocks: [], thinkingBlocks: [] };
    }
  }
  return { provider: () => new ScriptedProvider(), releaseAll: () => { for (const release of [...held]) release(); } };
}

export async function replHost(mode: ModelMode) {
  const homeDir = await realpath(await mkdtemp(path.join(tmpdir(), 'kodax-repl-v2-')));
  cleanup.push(() => rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const model = scriptedModel(mode);
  vi.stubEnv('KODAX_REPL_V2_KEY', 'offline-test');
  vi.stubEnv('KODAX_HOME', path.join(homeDir, '.kodax'));
  const unregister = registerModelProvider(MODEL, () => model.provider());
  cleanup.push(async () => {
    model.releaseAll();
    await awaitLatestCodingMemoryReviewDrain(5_000);
    unregister();
    vi.unstubAllEnvs();
  });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: MODEL });
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('The test Host could not take its home.');
  const endpoint: RuntimeDaemonEndpoint = process.platform === 'win32'
    ? { kind: 'pipe', path: `\\\\.\\pipe\\kodax-repl-v2-${randomUUID()}` }
    : { kind: 'unix', path: path.join(homeDir, 'host.sock') };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  cleanup.push(() => host.close());
  const token = readRuntimeDaemonToken(paths);
  if (token === undefined) throw new Error('The test Host published no token.');
  const client: KodaXHostClient<'local'> = await createKodaXHostClient<'local'>({
    open: () => connectHostRpc(dialRuntimeDaemonHostRpc(host.endpoint), {
      client: { name: 'repl-v2', version: '1.0.0', instanceId: `repl-v2-${randomUUID()}` },
      auth: { scheme: 'ipc', token },
    }),
  });
  cleanup.push(() => client.close());
  const { session } = await client.call('session.create', { requestId: createRequestId(), title: 'REPL', projectRoot: homeDir });
  return { client, model, homeDir, sessionId: session.id, plane: createReplClientPlane(client, async () => undefined) };
}

/** Follows the Session until `done` holds for a view. */
export async function viewWhere(plane: InkClientPlane, sessionId: string, done: (view: ClientSessionView) => boolean) {
  let close: () => void = () => undefined;
  const found = new Promise<ClientSessionView>((resolve) => {
    void plane.observe(sessionId, (view) => { if (done(view)) resolve(view); }).then((closer) => { close = closer; });
  });
  try { return await found; } finally { close(); }
}
