import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FileSessionStorage } from '@kodax-ai/repl';
import { KodaXBaseProvider, registerModelProvider,
  type KodaXProviderConfig, type KodaXStreamResult } from '@kodax-ai/llm';
import { createKodaXRuntime } from './sdk-runtime.js';
import { createRuntimeDaemonDispatcher } from './runtime-daemon/server.js';
import { createRuntimeDaemonRequest } from './runtime-daemon/protocol.js';
import { createRuntimeDaemonClient } from './runtime-daemon/client.js';
import { createRuntimeDaemonSocketServer, createRuntimeDaemonSocketClientTransport,
  defaultRuntimeDaemonEndpoint } from './runtime-daemon/transport.js';

async function fixture(sharedDaemonHost: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-stop-admission-'));
  const sessionsDir = path.join(root, 'sessions');
  const providerName = 'runtime-stop-admission-provider';
  let entered!: () => void;
  let release!: () => void;
  let releaseNext: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let gate = new Promise<void>((resolve) => { release = resolve; });
  class StopProvider extends KodaXBaseProvider {
    readonly name = providerName;
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = {
      apiKeyEnv: 'KODAX_STOP_TEST_KEY', model: 'stop-test', supportsThinking: false,
    };
    async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
      signal = args[5];
      entered();
      await gate;
      signal?.throwIfAborted();
      return { textBlocks: [{ type: 'text', text: 'finished' }], toolBlocks: [], thinkingBlocks: [] };
    }
  }
  vi.stubEnv('KODAX_STOP_TEST_KEY', 'offline-test');
  vi.stubEnv('KODAX_HOME', path.join(root, '.kodax'));
  const unregister = registerModelProvider(providerName, () => new StopProvider());
  const runtime = await createKodaXRuntime({ homeDir: root, sessionsDir,
    sharedDaemonHost, defaultProvider: providerName });
  const session = await runtime.sessions.create({ title: 'Stop while saving', projectPath: root });
  const run = await runtime.runs.start({ sessionId: session.id, prompt: 'wait for stop',
    mode: 'managed_task', options: { model: 'stop-test', lsp: false } });
  await started;
  const key = createHash('sha256').update(session.id, 'utf8').digest('hex');
  const lock = path.join(sessionsDir, '.write-locks', `${key}.lock`);
  return { root, sessionsDir, runtime, session, run, release, signal: () => signal,
    pauseNextRun() {
      const started = new Promise<void>((resolve) => { entered = resolve; });
      gate = new Promise<void>((resolve) => { releaseNext = resolve; });
      return { started, release: () => releaseNext?.() };
    },
    async hold() {
      await mkdir(path.dirname(lock), { recursive: true });
      await writeFile(lock, `${process.pid} stop-admission-test\n`, { flag: 'wx' });
    },
    async unlock() { await rm(lock, { force: true }); },
    async close() {
      await rm(lock, { force: true });
      release();
      releaseNext?.();
      await run.result;
      await runtime.close();
      unregister();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

it.each([false, true])('accepts and repeats Stop under a real Session write lock (shared=%s)', async (shared) => {
  const f = await fixture(shared);
  try {
    await f.hold();
    // Positive control: this is the real storage lock, not a mocked read failure.
    await expect(new FileSessionStorage({ sessionsDir: f.sessionsDir }).read(f.session.id))
      .rejects.toMatchObject({ code: 'data_changed' });
    await expect(f.runtime.runs.get(f.run.runId)).resolves.toMatchObject({ sessionId: f.session.id });
    const receipt = await f.runtime.runs.abort(f.run.runId);
    expect(receipt).toMatchObject({ accepted: true, state: 'unknown', outcome: 'unknown' });
    expect(f.signal()?.aborted).toBe(true);
    await expect(f.runtime.runs.abort(f.run.runId)).resolves.toEqual({ ...receipt, accepted: false });
    await f.unlock();
    f.release();
    await expect(f.run.result).resolves.toMatchObject({ stop: { state: 'confirmed', outcome: 'interrupted' } });
    // A terminal transition between the client's get and abort must stay readable.
    await f.hold();
    await expect(f.runtime.runs.get(f.run.runId)).resolves.toMatchObject({ phase: 'interrupted' });
    await expect(f.runtime.runs.abort(f.run.runId)).resolves.toMatchObject({ accepted: false, state: 'confirmed' });
  } finally { await f.close(); }
});

it.each([false, true])('rejects an unaccepted Stop bound to a completed Run without stopping its successor (shared=%s)', async (shared) => {
  const f = await fixture(shared);
  let later: Awaited<ReturnType<typeof f.runtime.runs.start>> | undefined;
  try {
    const input = { sessionId: f.session.id, expectedRunId: f.run.runId, requestId: 'lost-before-admission' };
    // The first transport attempt never arrived, so this request has no receipt.
    f.release();
    await expect(f.run.result).resolves.toMatchObject({ phase: 'completed' });
    const next = f.pauseNextRun();
    later = await f.runtime.runs.start({ sessionId: f.session.id, prompt: 'later explicit input',
      mode: 'managed_task', options: { model: 'stop-test', lsp: false } });
    await next.started;
    const queued = await f.runtime.runs.start({ sessionId: f.session.id, prompt: 'later queued input',
      mode: 'managed_task', options: { model: 'stop-test', lsp: false } });
    await f.hold();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(f.runtime.sessions.cancel(input)).rejects.toMatchObject({
        code: 'conflict', denialSource: 'stale_run', retryable: false,
      });
    }
    expect(f.signal()?.aborted).toBe(false);
    await expect(f.runtime.runs.get(queued.runId)).resolves.toMatchObject({ phase: 'queued' });
    await f.unlock();
    next.release();
    await expect(later.result).resolves.toMatchObject({ phase: 'completed' });
    await expect(queued.result).resolves.toMatchObject({ phase: 'completed' });
  } finally { await f.close(); await later?.result; }
});

it('retains natural completion when Stop loses the terminal race under a real write lock', async () => {
  const f = await fixture(true);
  try {
    f.release();
    await expect(f.run.result).resolves.toMatchObject({ phase: 'completed' });
    await f.hold();
    await expect(f.runtime.runs.get(f.run.runId)).resolves.toMatchObject({ phase: 'completed' });
    await expect(f.runtime.runs.abort(f.run.runId)).resolves.toMatchObject({
      accepted: false, state: 'confirmed', outcome: 'completed', phase: 'completed',
    });
    expect(f.signal()?.aborted).toBe(false);
  } finally { await f.close(); }
});

it('rejects a first Session Stop when its queued target terminates during admission', async () => {
  const f = await fixture(true);
  try {
    const target = await f.runtime.runs.start({ sessionId: f.session.id, prompt: 'queued target',
      mode: 'managed_task', options: { model: 'stop-test', lsp: false } });
    // Start Session Stop first; the single-Run abort settles its target while
    // Session Stop yields for the admitted identity check.
    const stopped = expect(f.runtime.sessions.cancel({ sessionId: f.session.id,
      expectedRunId: target.runId, requestId: 'terminal-during-admission' }))
      .rejects.toMatchObject({ code: 'conflict', denialSource: 'stale_run' });
    await expect(f.runtime.runs.abort(target.runId)).resolves.toMatchObject({
      accepted: true, state: 'confirmed', phase: 'cancelled',
    });
    await stopped;
    await expect(target.result).resolves.toMatchObject({ phase: 'cancelled' });
    expect(f.signal()?.aborted).toBe(false);
    f.release();
    await expect(f.run.result).resolves.toMatchObject({ phase: 'completed' });
  } finally { await f.close(); }
});

it.each(['hydrated', 'persisted-only'] as const)('rejects another live owner for a %s Run before reading locked Session history', async (record) => {
  const f = await fixture(true);
  const observer = await createKodaXRuntime({ homeDir: f.root, sessionsDir: f.sessionsDir, sharedDaemonHost: true });
  try {
    // The second Run did not exist when the observer hydrated its Run records.
    const target = record === 'hydrated' ? f.run : await f.runtime.runs.start({
      sessionId: f.session.id, prompt: 'queued after observer started', mode: 'managed_task',
      options: { model: 'stop-test', lsp: false },
    });
    await f.hold();
    await expect(observer.runs.abort(target.runId)).rejects.toMatchObject({ code: 'conflict' });
    await expect(observer.sessions.cancel({ sessionId: f.session.id, expectedRunId: target.runId, requestId: 'foreign-owner' }))
      .rejects.toMatchObject({ code: 'conflict', denialSource: 'run_ownership' });
    expect(f.signal()?.aborted).toBe(false);
  } finally { await observer.close(); await f.close(); }
});

it('preserves shared daemon profile and run-control scope checks with a real locked Run', async () => {
  const f = await fixture(true);
  const wrongProfile = createRuntimeDaemonDispatcher({ runtime: f.runtime });
  const observer = createRuntimeDaemonDispatcher({ runtime: f.runtime, grantedScopes: ['session:observe'] });
  const control = createRuntimeDaemonDispatcher({ runtime: f.runtime });
  try {
    await f.hold();
    await expect(wrongProfile.handle(createRuntimeDaemonRequest('wrong-profile', 'initialize', { profile: 'partner' })))
      .resolves.toMatchObject({ kind: 'error', error: { code: 'conflict' } });
    await observer.handle(createRuntimeDaemonRequest('observer-init', 'initialize', { profile: 'default' }));
    await expect(observer.handle(createRuntimeDaemonRequest('observer-stop', 'run.abort', { runId: f.run.runId })))
      .resolves.toMatchObject({ kind: 'error', error: { code: 'unauthorized' } });
    await expect(observer.handle(createRuntimeDaemonRequest('observer-session-stop', 'session.cancel', {
      sessionId: f.session.id, expectedRunId: f.run.runId, requestId: 'wrong-scope',
    }))).resolves.toMatchObject({ kind: 'error', error: { code: 'unauthorized' } });
    expect(f.signal()?.aborted).toBe(false);
    await control.handle(createRuntimeDaemonRequest('control-init', 'initialize', { profile: 'default' }));
    await expect(control.handle(createRuntimeDaemonRequest('control-stop', 'run.abort', { runId: f.run.runId })))
      .resolves.toMatchObject({ kind: 'response', result: { accepted: true, state: 'unknown' } });
    expect(f.signal()?.aborted).toBe(true);
  } finally { wrongProfile.close(); observer.close(); control.close(); await f.close(); }
});

it('atomically stops a bound Session frontier under a write lock without consuming later Runs', async () => {
  const f = await fixture(true);
  try {
    const queued = await f.runtime.runs.start({ sessionId: f.session.id,
      prompt: 'must never execute', mode: 'managed_task', options: { model: 'stop-test', lsp: false } });
    const input = { sessionId: f.session.id, expectedRunId: f.run.runId, requestId: 'stop-frontier' };
    await f.hold();
    await expect(f.runtime.sessions.cancel({ ...input, sessionId: 'wrong-session' }))
      .rejects.toMatchObject({ code: 'conflict', denialSource: 'session_binding' });
    expect(f.signal()?.aborted).toBe(false);
    const stopped = await f.runtime.sessions.cancel(input);
    expect(stopped.receipts).toEqual([
      expect.objectContaining({ runId: queued.runId, accepted: true, state: 'confirmed', outcome: 'cancelled' }),
      expect.objectContaining({ runId: f.run.runId, accepted: true, state: 'unknown' }),
    ]);
    expect(f.signal()?.aborted).toBe(true);
    await expect(queued.result).resolves.toMatchObject({ phase: 'cancelled' });
    await f.unlock();
    const later = await f.runtime.runs.start({ sessionId: f.session.id,
      prompt: 'new explicit input', mode: 'managed_task', options: { model: 'stop-test', lsp: false } });
    const repeated = await f.runtime.sessions.cancel(input);
    expect(repeated.frontier).toBe(stopped.frontier);
    expect(repeated.receipts.map((receipt) => receipt.runId)).not.toContain(later.runId);
    expect(repeated.receipts.every((receipt) => !receipt.accepted)).toBe(true);
    f.release();
    await expect(later.result).resolves.toMatchObject({ phase: 'completed' });
  } finally { await f.close(); }
});

it('keeps a partially delivered Stop fenced when an older successful request is replayed', async () => {
  const f = await fixture(true);
  let controlLock: string | undefined;
  try {
    const old = { sessionId: f.session.id, expectedRunId: f.run.runId, requestId: 'old-stop' };
    await f.runtime.sessions.cancel(old);
    const queued = await f.runtime.runs.start({ sessionId: f.session.id, prompt: 'must stay fenced',
      mode: 'managed_task', options: { model: 'stop-test', lsp: false } });
    controlLock = path.join(f.root, '.kodax', 'runtime', 'profiles', 'default', 'runs', queued.runId, 'status.json.lock');
    await writeFile(controlLock, JSON.stringify({ pid: process.pid, token: 'held-stop-test' }), { flag: 'wx' });
    const current = { ...old, requestId: 'current-stop' };
    await expect(f.runtime.sessions.cancel(current)).rejects.toThrow();
    await rm(controlLock);
    await f.runtime.sessions.cancel(old);
    f.release();
    await f.run.result;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await f.runtime.runs.get(queued.runId)).phase).toBe('queued');
    await f.runtime.sessions.cancel(current);
    await expect(queued.result).resolves.toMatchObject({ phase: 'cancelled' });
  } finally { if (controlLock) await rm(controlLock, { force: true }); await f.close(); }
});

it('transports Session Stop binding failures and receipts through the real shared dispatcher', async () => {
  const f = await fixture(true);
  const dispatcher = createRuntimeDaemonDispatcher({ runtime: f.runtime });
  try {
    await dispatcher.handle(createRuntimeDaemonRequest('init-session-stop', 'initialize', { profile: 'default' }));
    await f.hold();
    const input = { sessionId: f.session.id, expectedRunId: f.run.runId, requestId: 'daemon-stop' };
    await expect(dispatcher.handle(createRuntimeDaemonRequest('wrong-session-stop', 'session.cancel', {
      ...input, sessionId: 'not-this-session',
    }))).resolves.toMatchObject({ kind: 'error', error: { code: 'conflict', data: { denialSource: 'session_binding' } } });
    await expect(dispatcher.handle(createRuntimeDaemonRequest('session-stop', 'session.cancel', input)))
      .resolves.toMatchObject({ kind: 'response', result: { requestId: input.requestId,
        receipts: [expect.objectContaining({ runId: f.run.runId, accepted: true })] } });
    expect(f.signal()?.aborted).toBe(true);
  } finally { dispatcher.close(); await f.close(); }
});

it('accepts locked Session Stop over a real socket and replays its frontier after Runtime restart', async () => {
  const f = await fixture(true);
  const server = await createRuntimeDaemonSocketServer({
    endpoint: defaultRuntimeDaemonEndpoint('stop-integration', f.root),
    createDispatcher: (notify, disconnect) => createRuntimeDaemonDispatcher({ runtime: f.runtime, notify, disconnect }),
  });
  const transport = await createRuntimeDaemonSocketClientTransport(server.endpoint);
  await transport.request('initialize', { profile: 'default' });
  const client = createRuntimeDaemonClient({ identity: f.runtime.identity, transport, capabilities: f.runtime.capabilities });
  const input = { sessionId: f.session.id, expectedRunId: f.run.runId, requestId: 'restart-replay' };
  try {
    await f.hold();
    const receipt = await client.sessions.cancel(input);
    expect(receipt.receipts[0]).toMatchObject({ runId: f.run.runId, accepted: true });
    expect(f.signal()?.aborted).toBe(true);
    await f.unlock();
    f.release();
    await f.run.result;
    const next = f.pauseNextRun();
    const later = await f.runtime.runs.start({ sessionId: f.session.id, prompt: 'after accepted Stop settled',
      mode: 'managed_task', options: { model: 'stop-test', lsp: false } });
    await next.started;
    await f.hold();
    await expect(client.sessions.cancel(input)).resolves.toMatchObject({ frontier: receipt.frontier,
      receipts: [expect.objectContaining({ runId: f.run.runId, accepted: false, outcome: 'interrupted' })] });
    await expect(client.sessions.cancel({ ...input, requestId: 'unaccepted-after-settlement' }))
      .rejects.toMatchObject({ code: 'conflict', data: {
        denialSource: 'stale_run', retryable: false, operation: 'sessions.cancel',
      } });
    expect(f.signal()?.aborted).toBe(false);
    await f.unlock();
    next.release();
    await expect(later.result).resolves.toMatchObject({ phase: 'completed' });
    await f.runtime.close();
    const restarted = await createKodaXRuntime({ homeDir: f.root, sessionsDir: f.sessionsDir, sharedDaemonHost: true });
    try {
      await f.hold();
      await expect(restarted.sessions.cancel(input)).resolves.toMatchObject({ frontier: receipt.frontier,
        receipts: [expect.objectContaining({ accepted: false, state: 'confirmed', outcome: 'interrupted' })] });
      await expect(restarted.sessions.cancel({ ...input, expectedRunId: 'another-run' }))
        .rejects.toMatchObject({ code: 'conflict', denialSource: 'session_binding' });
    } finally { await f.unlock(); await restarted.close(); }
  } finally { await client.close(); await server.close(); await f.close(); }
});
