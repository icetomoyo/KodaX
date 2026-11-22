// A Host quiesces its Runtime before it closes the client transport, so the
// clients still connected learn how their Runs ended. These tests pin the
// Runtime half of that order.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSessionLineage } from '@kodax-ai/agent';
import type { KodaXOptions, KodaXResult } from '@kodax-ai/coding';
import type { KodaXMessage } from '@kodax-ai/llm';
import { createKodaXRuntime, type RuntimeEvent } from '../tests/runtime-fixture.js';
import { quiesceRuntimeForHostClose } from './runtime-host-close.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { readRuntimeDaemonToken, resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';
import { createRuntimeDaemonSocketClientTransport } from './runtime-daemon/transport.js';

const codingMock = vi.hoisted(() => ({ runManagedTask: vi.fn() }));

vi.mock('@kodax-ai/coding', async importOriginal => ({
  ...await importOriginal<typeof import('@kodax-ai/coding')>(),
  runManagedTask: codingMock.runManagedTask,
}));

type Runtime = Awaited<ReturnType<typeof createKodaXRuntime>>;

let homeDir: string;
const runtimes: Runtime[] = [];

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'kodax-host-close-'));
  codingMock.runManagedTask.mockReset();
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function openRuntime(): Promise<Runtime> {
  const runtime = await createKodaXRuntime({ homeDir, sessionsDir: join(homeDir, 'sessions'), defaultProvider: 'mock-provider' });
  runtimes.push(runtime);
  return runtime;
}

function quiesce(runtime: Runtime, deadlineMs: number): Promise<{ readonly unsettledRunIds: readonly string[] }> {
  const quiesced = quiesceRuntimeForHostClose(runtime, { deadlineMs });
  if (!quiesced) throw new Error('The Runtime registered no Host-close quiesce.');
  return quiesced;
}

/** A Run that works until its abort signal fires; `ignoreAbort` models an executor that never returns. */
async function startWorkingRun(runtime: Runtime, ignoreAbort = false): Promise<{ sessionId: string; runId: string }> {
  const session = await runtime.sessions.create({ title: 'Host close' });
  let entered!: () => void;
  const working = new Promise<void>(resolve => { entered = resolve; });
  codingMock.runManagedTask.mockImplementationOnce((options: KodaXOptions) => new Promise<KodaXResult>((_resolve, reject) => {
    entered();
    if (ignoreAbort) return;
    options.abortSignal?.addEventListener('abort',
      () => reject(new DOMException('Fixture work was cancelled.', 'AbortError')), { once: true });
  }));
  const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'Keep working.' });
  await working;
  return { sessionId: session.id, runId: handle.runId };
}

it('settles an in-flight Run and delivers its terminal event while events still flow', async () => {
  const runtime = await openRuntime();
  const { sessionId, runId } = await startWorkingRun(runtime);
  const events: RuntimeEvent[] = [];
  runtime.events.subscribe({ sessionId }, event => { events.push(event); });

  const quiesced = await quiesce(runtime, 5_000);

  expect(quiesced.unsettledRunIds).toEqual([]);
  // Delivered by the time the quiesce resolves: the Host closes the transport next.
  expect(events.filter(event => event.runId === runId).map(event => event.type)).toContain('run.interrupted');
  const persisted = JSON.parse(await readFile(join(homeDir, '.kodax', 'runtime', 'runs', runId, 'status.json'), 'utf8'));
  expect(persisted).toMatchObject({ phase: 'interrupted', stop: { reason: 'runtime closed' } });
  await expect(runtime.close()).resolves.toBeUndefined();
}, 20_000);

it('refuses new work with an actionable conflict while it is quiesced', async () => {
  const runtime = await openRuntime();
  const session = await runtime.sessions.create({ title: 'Late request' });

  await quiesce(runtime, 1_000);

  await expect(runtime.runs.start({ sessionId: session.id, prompt: 'Too late.' }))
    .rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/shutting down/i) });
  expect(codingMock.runManagedTask).not.toHaveBeenCalled();
}, 20_000);

it('returns at its deadline with the Runs that never settled, and repeats nothing', async () => {
  const runtime = await openRuntime();
  const { runId } = await startWorkingRun(runtime, true);

  const startedAt = Date.now();
  const first = quiesce(runtime, 300);
  const quiesced = await first;

  expect(quiesced.unsettledRunIds).toEqual([runId]);
  expect(Date.now() - startedAt).toBeLessThan(3_000);
  // A second request is the same quiesce, not another deadline.
  expect(quiesce(runtime, 60_000)).toBe(first);
  // The unconfirmed Stop that close() has always recorded for such a Run.
  const persisted = JSON.parse(await readFile(join(homeDir, '.kodax', 'runtime', 'runs', runId, 'status.json'), 'utf8'));
  expect(persisted).toMatchObject({ phase: 'unknown', stop: { reason: 'runtime closed' } });
}, 20_000);

it('tells a connected client how its Run ended, and refuses its late request, before the Host hangs up', async () => {
  const runtime = await openRuntime();
  // A Run that never returns keeps the quiesce window open for the late request.
  await startWorkingRun(runtime, true);
  const { sessionId, runId } = await startWorkingRun(runtime);
  const paths = resolveRuntimeDaemonPaths(homeDir, 'default');
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Expected the daemon lock.');
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, runQuiesceMs: 1_500, endpoint: process.platform === 'win32'
    ? { kind: 'pipe', path: `\\\\.\\pipe\\kodax-host-close-${randomUUID()}` }
    : { kind: 'unix', path: join(homeDir, 'daemon.sock') } });
  const client = await createRuntimeDaemonSocketClientTransport(host.endpoint);
  try {
    await client.request('initialize', { profile: 'default', token: readRuntimeDaemonToken(paths) });
    const seen: string[] = [];
    client.subscribe(notification => {
      const event = (notification.params as { readonly event?: RuntimeEvent } | undefined)?.event;
      if (event?.runId === runId) seen.push(event.type);
    });
    client.subscribeLifecycle?.(state => { if (state.state === 'disconnected') seen.push('disconnected'); });
    await client.request('session.observe', { sessionId });

    const closing = host.close();
    await vi.waitFor(() => expect(seen).toContain('run.interrupted'));
    expect(seen).not.toContain('disconnected');
    await expect(client.request('run.start', { sessionId, prompt: 'Too late.' }))
      .rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/shutting down/i) });
    await closing;

    await vi.waitFor(() => expect(seen.at(-1)).toBe('disconnected'));
  } finally {
    await client.close?.();
  }
}, 30_000);

it('still suspends a checkpointed Run for recovery instead of stopping it', async () => {
  const runtime = await openRuntime();
  const session = await runtime.sessions.create({ title: 'Close checkpoint' });
  codingMock.runManagedTask.mockImplementationOnce((options: KodaXOptions) => (async () => {
    const messages: KodaXMessage[] = [{ role: 'user', content: 'Preserve constraints', turnId: 'close-turn' }];
    const lineage = createSessionLineage(messages);
    await options.session!.storage!.save(session.id, { messages, lineage, title: 'Close checkpoint', gitRoot: homeDir });
    await options.events!.onContextCapacityBlocked!({ checkpoint: { version: 1, sessionId: session.id,
      activeEntryId: lineage.activeEntryId, turnId: 'close-turn',
      messagesDigest: createHash('sha256').update(JSON.stringify(messages)).digest('hex') } });
    return { success: true, lastText: 'should remain suspended', messages, sessionId: session.id };
  })());
  const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'Preserve constraints', mode: 'coding' });
  await vi.waitFor(async () => expect((await runtime.runs.get(handle.runId)).contextRecovery?.checkpoint).toBeDefined());

  const quiesced = await quiesce(runtime, 5_000);
  await runtime.close();

  // Held for recovery is the settled state of a checkpointed Run.
  expect(quiesced.unsettledRunIds).toEqual([]);
  expect((await handle.result).phase).toBe('recovering');
  const persisted = JSON.parse(await readFile(join(homeDir, '.kodax', 'runtime', 'runs', handle.runId, 'status.json'), 'utf8'));
  expect(persisted).toMatchObject({ phase: 'recovering', contextRecovery: { checkpoint: { turnId: 'close-turn' } } });
  expect(persisted.stop).toBeUndefined();
  expect(persisted.terminal).toBeUndefined();
  const restarted = await openRuntime();
  codingMock.runManagedTask.mockImplementationOnce(() => Promise.resolve({ success: true, lastText: 'resumed', messages: [], sessionId: session.id }));
  const resumed = await restarted.runs.recover({ runId: handle.runId });
  expect((await resumed.result).phase).toBe('completed');
}, 30_000);
