import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';

import {
  getActiveAgentHomes,
  setKodaXDiagnosticSink,
  type AgentActorSaveAttempt,
  type AgentActorSavePhase,
  type KodaXDiagnostic,
} from '@kodax-ai/agent';
import type { KodaXOptions, KodaXResult } from '@kodax-ai/coding';
import { FileSessionStorage } from '@kodax-ai/repl';
import { executeChildAgents } from '../packages/coding/src/child-executor.js';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import {
  readRuntimeDaemonLockOwner,
  readRuntimeDaemonToken,
  resolveRuntimeDaemonPaths,
  tryAcquireRuntimeDaemonLock,
} from './runtime-daemon/state.js';
import { createRuntimeDaemonSocketClientTransport } from './runtime-daemon/transport.js';

const codingMock = vi.hoisted(() => ({ runManagedTask: vi.fn() }));

vi.mock('@kodax-ai/coding', async importOriginal => ({
  ...await importOriginal<typeof import('@kodax-ai/coding')>(),
  runManagedTask: codingMock.runManagedTask,
}));

vi.mock('../packages/coding/src/child-executor.js', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/coding/src/child-executor.js')>(),
  executeChildAgents: vi.fn(),
}));

function deferred() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function abortable(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const abort = () => reject(new DOMException('Fixture work was cancelled.', 'AbortError'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

/** The real save runs only after `gate`; until then the attempt is an ambiguous in-flight commit. */
function lateCommitAttempt(gate: Promise<void>, commit: () => Promise<void>): AgentActorSaveAttempt {
  let phase: AgentActorSavePhase = 'commit_inflight';
  const canonical = gate.then(commit).then(() => { phase = 'committed'; });
  void canonical.catch(() => undefined);
  return {
    dequeued: Promise.resolve(),
    eligible: Promise.resolve(),
    canonical,
    completion: canonical,
    phase: () => phase,
    cancelBeforeCommit: () => false,
    diagnostics: () => ({ attemptId: 'late-stop-commit', phase, timingsMs: {} }),
  };
}

type Runtime = Awaited<ReturnType<typeof createKodaXRuntime>>;
interface StoppedRun {
  readonly runtime: Runtime;
  readonly homeDir: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly statusFile: string;
  readonly stage: (value: string) => void;
}
interface LateCommitOptions {
  /** Runs after the Stop save has timed out and before it commits late. */
  readonly beforeLateCommit?: (stopped: StoppedRun) => Promise<void>;
  readonly onDiagnostic?: (diagnostic: KodaXDiagnostic) => void;
  /** A fenced Actor controller cannot release its owner, so close may be expected to fail. */
  readonly onCloseError?: (error: unknown, homeDir: string) => Promise<void>;
}
interface TestContext {
  readonly signal: AbortSignal;
  readonly onTestFailed: (handler: () => void) => void;
}

/**
 * Two parallel child Actors are running when Stop arrives. The single save
 * that interrupts both of them misses its deadline and commits late; `verify`
 * then observes how the Runtime settles the Run.
 */
async function stopWithLateSiblingCommit(
  { signal, onTestFailed }: TestContext,
  options: LateCommitOptions,
  verify: (stopped: StoppedRun) => Promise<void>,
): Promise<void> {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-stop-late-commit-'));
  const childrenEntered = { a: deferred(), b: deferred() };
  const lateCommit = deferred();
  const cancellationFailed = deferred();
  signal.addEventListener('abort', () => {
    childrenEntered.a.resolve(); childrenEntered.b.resolve(); lateCommit.resolve(); cancellationFailed.resolve();
  }, { once: true });
  let runId: string | undefined;
  const diagnostics: Array<{ source: string; message: string }> = [];
  const restoreDiagnostics = setKodaXDiagnosticSink(diagnostic => {
    // The sink is process-global: a previous test's Runtime may still report its
    // own background repair, so only this Run's cancellation failure counts.
    if (diagnostic.source === 'runtime.run.actor-cancellation'
      && runId !== undefined && diagnostic.message.includes(runId)) cancellationFailed.resolve();
    if (diagnostics.length < 32) diagnostics.push({ source: diagnostic.source, message: diagnostic.message.slice(0, 512) });
    options.onDiagnostic?.(diagnostic);
  });
  let stage = 'starting the Run';
  onTestFailed(() => {
    process.stderr.write(`[Late Stop commit diagnostics] ${JSON.stringify({ stage, diagnostics })}\n`);
  });
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  try {
    codingMock.runManagedTask.mockImplementation(async (runOptions: KodaXOptions): Promise<KodaXResult> => {
      const actorSession = runOptions.context?.actorSession;
      if (!actorSession) throw new Error('Fixture Run has no Actor session.');
      const control = actorSession.attach({ backups: new Map() }, runOptions);
      await control.spawn({ taskName: 'gen-S1-A', objective: 'Generate part A.' });
      await control.spawn({ taskName: 'gen-S1-B', objective: 'Generate part B.' });
      return abortable(runOptions.abortSignal);
    });
    vi.mocked(executeChildAgents).mockImplementation(async (_bundles, _context, childOptions) => {
      const path = childOptions.actorControl!.callerPath;
      if (path === '/root/gen-S1-A') childrenEntered.a.resolve();
      else if (path === '/root/gen-S1-B') childrenEntered.b.resolve();
      return abortable(childOptions.abortSignal);
    });
    const beginSave = FileSessionStorage.prototype.beginActorSnapshotSave;
    let stopSaveArmed = true;
    vi.spyOn(FileSessionStorage.prototype, 'beginActorSnapshotSave').mockImplementation(function (
      this: FileSessionStorage, id, snapshot, expectedRevision,
    ) {
      const interrupted = snapshot.turns.filter(turn => turn.state === 'interrupted').map(turn => turn.actorPath);
      if (stopSaveArmed && interrupted.includes('/root/gen-S1-A') && interrupted.includes('/root/gen-S1-B')) {
        stopSaveArmed = false;
        return lateCommitAttempt(lateCommit.promise, () => beginSave.call(this, id, snapshot, expectedRevision).canonical);
      }
      return beginSave.call(this, id, snapshot, expectedRevision);
    });

    const session = await runtime.sessions.create({ title: 'Stop with a late sibling interruption commit' });
    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'generate in parallel', mode: 'managed_task' });
    runId = run.runId;
    const stopped: StoppedRun = {
      runtime,
      homeDir,
      sessionId: session.id,
      runId: run.runId,
      statusFile: join(homeDir, '.kodax', 'runtime', 'runs',encodeURIComponent(run.runId), 'status.json'),
      stage: (value) => { stage = value; },
    };
    stage = 'waiting for both children';
    await Promise.all([childrenEntered.a.promise, childrenEntered.b.promise]);
    signal.throwIfAborted();

    stage = 'stopping while the sibling interruption save is slow';
    await runtime.runs.abort(run.runId);
    await cancellationFailed.promise;
    await options.beforeLateCommit?.(stopped);
    stage = 'committing the timed-out save late';
    lateCommit.resolve();
    await verify(stopped);
  } finally {
    lateCommit.resolve();
    let closeError: { readonly error: unknown } | undefined;
    try { await runtime.close(); }
    catch (error: unknown) { closeError = { error }; }
    restoreDiagnostics();
    vi.restoreAllMocks();
    if (closeError !== undefined) {
      if (!options.onCloseError) throw closeError.error;
      await options.onCloseError(closeError.error, homeDir);
    }
    vi.mocked(executeChildAgents).mockReset();
    if (dirname(homeDir) !== temporaryRoot) throw new Error('Refusing to remove a fixture outside its temporary root.');
    // A failed close leaves Session maintenance writing briefly.
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

it('gives Stop a definite outcome when the sibling interruption save commits after its deadline', async (context) => {
  await stopWithLateSiblingCommit(context, {}, async ({ runtime, sessionId, runId, stage }) => {
    stage('awaiting a definite Stop outcome');
    let status = await runtime.runs.get(runId);
    await vi.waitFor(async () => {
      status = await runtime.runs.get(runId);
      stage(`awaiting a definite Stop outcome: ${JSON.stringify(status).slice(0, 3000)}`);
      expect(status.phase).not.toBe('unknown');
    }, { timeout: 15_000, interval: 100 });
    const evidence = JSON.stringify(status);
    expect(['cancelled', 'failed', 'interrupted'], evidence).toContain(status.phase);
    expect(status.stop?.state, evidence).toBe('confirmed');
    const events = await runtime.agents.events(sessionId);
    for (const actorPath of ['/root/gen-S1-A', '/root/gen-S1-B']) {
      const terminal = events.filter(event => event.actorPath === actorPath
        && ['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.kind));
      expect(terminal.map(event => event.kind), evidence).toEqual(['turn_interrupted']);
    }
  });
}, 30_000);

it('keeps the Runtime alive when the repaired Stop cannot persist its terminal status', async (context) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  const settlementLost = deferred();
  context.signal.addEventListener('abort', () => settlementLost.resolve(), { once: true });
  let durableStatus = '';
  try {
    await stopWithLateSiblingCommit(context, {
      onDiagnostic: (diagnostic) => {
        if (diagnostic.source === 'runtime.run-settlement') settlementLost.resolve();
      },
      beforeLateCommit: async ({ statusFile }) => {
        // Every later status write fails because the durable record is malformed.
        durableStatus = await readFile(statusFile, 'utf8');
        await writeFile(statusFile, '{}');
      },
    }, async ({ runtime, runId, statusFile, stage }) => {
      stage('awaiting the unpersisted settlement report');
      await Promise.race([settlementLost.promise, new Promise(resolve => setTimeout(resolve, 15_000))]);
      await new Promise(resolve => setTimeout(resolve, 50));
      await writeFile(statusFile, durableStatus);
      expect(unhandled).toEqual([]);
      const status = await runtime.runs.get(runId);
      expect(status.phase, JSON.stringify(status)).toBe('unknown');
      expect(status.stop?.state, JSON.stringify(status)).not.toBe('confirmed');
      expect(status.lifecycleError?.code, JSON.stringify(status)).toBe('run_settlement_not_persisted');

      stage('stopping again once the status record is writable');
      await runtime.runs.abort(runId);
      await vi.waitFor(async () => {
        const settled = await runtime.runs.get(runId);
        expect(settled.phase, JSON.stringify(settled)).toBe('interrupted');
        expect(settled.stop?.state, JSON.stringify(settled)).toBe('confirmed');
      }, { timeout: 10_000, interval: 100 });
    });
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}, 30_000);

it('gives a Stop whose Actor repair fails deterministically a final outcome and keeps the Session fenced', async (context) => {
  let closeError: unknown;
  let finalStatus: Awaited<ReturnType<Runtime['runs']['get']>> | undefined;
  const executions = codingMock.runManagedTask.mock.calls.length + 1;
  await stopWithLateSiblingCommit(context, {
    beforeLateCommit: async ({ sessionId }) => {
      // From here the durable Actor snapshot reads as owned by another Runtime,
      // so same-owner repair fails with AgentOwnerConflictError on every attempt.
      const peek = FileSessionStorage.prototype.peek;
      vi.spyOn(FileSessionStorage.prototype, 'peek').mockImplementation(async function (this: FileSessionStorage, id) {
        const data = await peek.call(this, id);
        const snapshot = data?.actorSnapshot;
        if (data === null || id !== sessionId || snapshot?.schemaVersion !== 2 || snapshot.owner === undefined) return data;
        return { ...data, actorSnapshot: { ...snapshot, owner: { ...snapshot.owner, ownerId: 'foreign-owner' } } };
      });
    },
    onCloseError: async (error, homeDir) => {
      closeError = error;
      if (finalStatus === undefined) return; // verify already failed; keep its error.
      // Restart while the old owner still answers liveness: the terminal Run is
      // trusted as is, and the Actor tree cannot be claimed under it.
      const restarted = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
      try {
        const recovered = await restarted.runs.get(finalStatus!.runId);
        expect(recovered, JSON.stringify(recovered)).toMatchObject({
          phase: 'failed', terminal: finalStatus!.terminal, stop: { state: 'confirmed' },
        });
        const successor = await restarted.runs.start({ sessionId: finalStatus!.sessionId, prompt: 'after restart',
          mode: 'managed_task' }).then(() => undefined, (rejection: unknown) => rejection);
        process.stderr.write(`[Issue 413] close: ${String(error)}\n[Issue 413] successor after restart: ${String(successor)} ${JSON.stringify(successor)}\n`);
        expect(successor).toMatchObject({ code: 'actor_owner_conflict' });
        expect(codingMock.runManagedTask).toHaveBeenCalledTimes(executions);
      } finally {
        await restarted.close();
      }
      // Once the old owner no longer answers (its process died), restart
      // recovery reclaims the Actor tree and the Session accepts work again.
      const storage = new FileSessionStorage({ sessionsDir: join(homeDir, '.kodax', 'sessions') });
      const snapshot = (await storage.peek(finalStatus!.sessionId))?.actorSnapshot;
      if (snapshot?.schemaVersion !== 2 || snapshot.owner === undefined) throw new Error('Expected a fenced Actor owner.');
      await storage.saveActorSnapshot(finalStatus!.sessionId, {
        ...snapshot, revision: snapshot.revision + 1, owner: { ...snapshot.owner, livenessId: '0'.repeat(32) },
      }, snapshot.revision);
      const reclaimed = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
      try {
        await expect(reclaimed.runs.get(finalStatus!.runId)).resolves.toMatchObject({ phase: 'failed' });
        const tree = await reclaimed.agents.tree(finalStatus!.sessionId);
        expect(tree.actors.map(actor => actor.path).sort(), JSON.stringify(tree)).toEqual(
          ['/root', '/root/gen-S1-A', '/root/gen-S1-B'],
        );
        for (const actorPath of ['/root/gen-S1-A', '/root/gen-S1-B']) {
          const turns = (await reclaimed.agents.detail(finalStatus!.sessionId, actorPath)).turns;
          expect(turns.map(turn => turn.state), actorPath).toEqual(['interrupted']);
        }
      } finally {
        await reclaimed.close();
      }
    },
  }, async ({ runtime, sessionId, runId, statusFile, stage }) => {
    stage('awaiting a final outcome after the repair gave up');
    const startedAt = Date.now();
    let status = await runtime.runs.get(runId);
    await vi.waitFor(async () => {
      status = await runtime.runs.get(runId);
      stage(`awaiting a final outcome after the repair gave up: ${JSON.stringify(status).slice(0, 3000)}`);
      expect(status.phase).toBe('failed');
    }, { timeout: 15_000, interval: 100 });
    process.stderr.write(`[Issue 413] final outcome ${Date.now() - startedAt} ms after the late commit\n`);
    const evidence = JSON.stringify(status);
    expect(status.terminal, evidence).toMatchObject({
      kind: 'failed', code: 'actor_settlement_not_persisted', effectOutcome: 'unknown',
    });
    expect(status.stop?.state, evidence).toBe('confirmed');
    const durable: unknown = JSON.parse(await readFile(statusFile, 'utf8'));
    expect(durable, evidence).toMatchObject({ phase: 'failed', terminal: { effectOutcome: 'unknown' } });
    await expect(runtime.runs.await(runId)).resolves.toMatchObject({ phase: expect.any(String) });
    const again = await runtime.runs.abort(runId);
    expect(again, JSON.stringify(again)).toMatchObject({ accepted: false });
    finalStatus = status;

    stage('starting a successor while the Actor tree is still unconfirmed');
    await expect(runtime.runs.start({ sessionId, prompt: 'next', mode: 'managed_task' }))
      .rejects.toMatchObject({ code: 'actor_settlement_not_persisted' });
    expect(codingMock.runManagedTask).toHaveBeenCalledTimes(executions);

    stage('mutating Session history while the Actor tree is still unconfirmed');
    const notice = await runtime.sessions.appendNotice({ sessionId, content: 'after the final outcome' })
      .then((entry) => ({ entry }), (rejection: unknown) => ({ rejection }));
    process.stderr.write(`[Issue 413] Session mutation after the final outcome: ${JSON.stringify(notice)}\n`);
    expect(notice).toMatchObject({ rejection: { code: 'conflict' } });
  });
  // The Actor owner fence is never released in-process; restart recovery owns it.
  expect(closeError).toBeDefined();
}, 60_000);

/**
 * While the original Actor owner is on disk it reads as a foreign owner that
 * answers liveness until `isAlive` turns false. A successor owner reads as is.
 */
function serveOriginalOwnerAsForeign(sessionId: string, isAlive: () => boolean): void {
  const peek = FileSessionStorage.prototype.peek;
  let originalOwnerId: string | undefined;
  vi.spyOn(FileSessionStorage.prototype, 'peek').mockImplementation(async function (this: FileSessionStorage, id) {
    const data = await peek.call(this, id);
    const snapshot = data?.actorSnapshot;
    if (data === null || id !== sessionId || snapshot?.schemaVersion !== 2 || snapshot.owner === undefined) return data;
    originalOwnerId ??= snapshot.owner.ownerId;
    if (snapshot.owner.ownerId !== originalOwnerId) return data;
    const owner = { ...snapshot.owner, ownerId: 'foreign-owner',
      ...(isAlive() ? {} : { livenessId: '0'.repeat(32) }) };
    return { ...data, actorSnapshot: { ...snapshot, owner } };
  });
}

/** Later executions record the Actor session they run on and wait for Stop. */
function captureLaterActorSessions(): Array<NonNullable<NonNullable<KodaXOptions['context']>['actorSession']>> {
  const captured: Array<NonNullable<NonNullable<KodaXOptions['context']>['actorSession']>> = [];
  codingMock.runManagedTask.mockImplementation(async (runOptions: KodaXOptions): Promise<KodaXResult> => {
    const actorSession = runOptions.context?.actorSession;
    if (actorSession) captured.push(actorSession);
    return abortable(runOptions.abortSignal);
  });
  return captured;
}

it('heals the Session without a restart once the foreign Actor owner exits', async (context) => {
  let closeError: unknown;
  let foreignAlive = true;
  await stopWithLateSiblingCommit(context, {
    beforeLateCommit: async ({ sessionId }) => serveOriginalOwnerAsForeign(sessionId, () => foreignAlive),
    onCloseError: async (error) => { closeError = error; },
  }, async ({ runtime, sessionId, runId, stage }) => {
    await vi.waitFor(async () => {
      expect((await runtime.runs.get(runId)).phase).toBe('failed');
    }, { timeout: 15_000, interval: 100 });
    await expect(runtime.runs.start({ sessionId, prompt: 'while fenced', mode: 'managed_task' }))
      .rejects.toMatchObject({ code: 'actor_settlement_not_persisted' });

    stage('starting a successor after the foreign owner exited');
    const sessions = captureLaterActorSessions();
    foreignAlive = false;
    let successor: unknown;
    await vi.waitFor(async () => {
      successor = await runtime.runs.start({ sessionId, prompt: 'after the owner exited', mode: 'managed_task' })
        .then((started) => ({ started: started.runId }), (rejection: unknown) => ({ rejection }));
      expect(successor, JSON.stringify(successor)).toMatchObject({ started: expect.any(String) });
    }, { timeout: 20_000, interval: 500 });
    const started = (successor as { readonly started: string }).started;
    await vi.waitFor(async () => {
      expect((await runtime.runs.get(started)).phase).toBe('running');
    }, { timeout: 10_000, interval: 100 });
    await vi.waitFor(() => expect(sessions).toHaveLength(1), { timeout: 10_000, interval: 100 });
    expect(sessions[0]!.health().state).toBe('healthy');
    // The old Run keeps its outcome; its children were interrupted on takeover.
    expect((await runtime.runs.get(runId)).phase).toBe('failed');
    for (const actorPath of ['/root/gen-S1-A', '/root/gen-S1-B']) {
      const turns = (await runtime.agents.detail(sessionId, actorPath)).turns;
      expect(turns.map(turn => turn.state), actorPath).toEqual(['interrupted']);
    }
    await runtime.runs.abort(started);
  });
  // The rebuilt Actor tree is healthy, so close releases its owner.
  expect(closeError).toBeUndefined();
}, 60_000);

it('starts a continuation queued behind the Stop on the reclaimed Actor tree', async (context) => {
  let foreignAlive = true;
  let successorId: string | undefined;
  await stopWithLateSiblingCommit(context, {
    beforeLateCommit: async ({ runtime, sessionId, runId }) => {
      // Accepted behind the unconfirmed Stop, so it was bound before the reclaim.
      const queued = await runtime.runs.submitInput({ sessionId, afterRunId: runId, delivery: 'after_turn',
        input: [{ type: 'text', text: 'continue after reclaim' }] });
      if (queued.accepted) successorId = queued.runId;
      serveOriginalOwnerAsForeign(sessionId, () => foreignAlive);
    },
  }, async ({ runtime, runId, stage }) => {
    if (successorId === undefined) throw new Error('Expected the continuation to be accepted.');
    await vi.waitFor(async () => {
      expect((await runtime.runs.get(runId)).phase).toBe('failed');
    }, { timeout: 15_000, interval: 100 });
    expect((await runtime.runs.get(successorId)).phase).toBe('queued');

    stage('awaiting the queued continuation once the foreign owner exited');
    const sessions = captureLaterActorSessions();
    foreignAlive = false;
    await vi.waitFor(() => {
      expect(sessions).toHaveLength(1);
    }, { timeout: 20_000, interval: 100 });
    expect(sessions[0]!.health().state).toBe('healthy');
    await vi.waitFor(async () => {
      expect((await runtime.runs.get(successorId!)).phase).toBe('running');
    }, { timeout: 10_000, interval: 100 });
    await runtime.runs.abort(successorId);
  });
}, 60_000);

it('ends a Stop whose Actor repair keeps failing once the repair budget is spent', async (context) => {
  await stopWithLateSiblingCommit(context, {
    beforeLateCommit: async ({ sessionId }) => {
      // Repair now fails with a retryable error (missing snapshot) on every
      // attempt, and the wall clock is already past the repair budget.
      const peek = FileSessionStorage.prototype.peek;
      vi.spyOn(FileSessionStorage.prototype, 'peek').mockImplementation(async function (this: FileSessionStorage, id) {
        const data = await peek.call(this, id);
        return id === sessionId && data ? { ...data, actorSnapshot: undefined } : data;
      });
      const now = Date.now.bind(Date);
      vi.spyOn(Date, 'now').mockImplementation(() => now() + 6 * 60_000);
    },
    onCloseError: async () => undefined,
  }, async ({ runtime, runId, stage }) => {
    let status = await runtime.runs.get(runId);
    await vi.waitFor(async () => {
      status = await runtime.runs.get(runId);
      stage(`awaiting the out-of-budget outcome: ${JSON.stringify(status).slice(0, 3000)}`);
      expect(status.phase).toBe('failed');
    }, { timeout: 15_000, interval: 100 });
    vi.mocked(Date.now).mockRestore();
    expect(status.terminal, JSON.stringify(status)).toMatchObject({
      kind: 'failed', code: 'actor_settlement_not_persisted', effectOutcome: 'unknown',
    });
  });
}, 30_000);

it('[review] lets the Session accept work once storage recovers after the repair budget is spent', async (context) => {
  let closeError: unknown;
  await stopWithLateSiblingCommit(context, {
    beforeLateCommit: async ({ sessionId }) => {
      const peek = FileSessionStorage.prototype.peek;
      vi.spyOn(FileSessionStorage.prototype, 'peek').mockImplementation(async function (this: FileSessionStorage, id) {
        const data = await peek.call(this, id);
        return id === sessionId && data ? { ...data, actorSnapshot: undefined } : data;
      });
      const now = Date.now.bind(Date);
      vi.spyOn(Date, 'now').mockImplementation(() => now() + 6 * 60_000);
    },
    onCloseError: async (error) => { closeError = error; },
  }, async ({ runtime, sessionId, runId, stage }) => {
    await vi.waitFor(async () => {
      expect((await runtime.runs.get(runId)).phase).toBe('failed');
    }, { timeout: 15_000, interval: 100 });
    // The outage ends: the snapshot reads normally and the clock is back.
    vi.mocked(Date.now).mockRestore();
    vi.mocked(FileSessionStorage.prototype.peek).mockRestore();

    stage('starting a successor after storage recovered');
    let successor: unknown;
    await vi.waitFor(async () => {
      successor = await runtime.runs.start({ sessionId, prompt: 'after recovery', mode: 'managed_task' })
        .then((started) => ({ started: started.runId }), (rejection: unknown) => ({ rejection }));
      expect(successor, JSON.stringify(successor)).toMatchObject({ started: expect.any(String) });
    }, { timeout: 10_000, interval: 500 });
    const started = (successor as { readonly started: string }).started;
    // Accepted is not enough: a still-fenced Session would keep it queued.
    await vi.waitFor(async () => {
      expect((await runtime.runs.get(started)).phase).toBe('running');
    }, { timeout: 10_000, interval: 100 });
    await runtime.runs.abort(started);
  });
  // A healthy Actor tree must release its owner on close.
  expect(closeError).toBeUndefined();
}, 60_000);

interface StorageTrace {
  readonly inflight: () => readonly string[];
  readonly startedSince: (mark: number) => readonly string[];
  readonly restore: () => void;
}

/** Records every FileSessionStorage call so a test can see Session I/O that outlives close(). */
function traceSessionStorage(): StorageTrace {
  const prototype = FileSessionStorage.prototype as unknown as Record<string, unknown>;
  const originals = new Map<string, (...args: unknown[]) => unknown>();
  const calls: Array<{ readonly name: string; readonly at: number; settled: boolean }> = [];
  for (const name of Object.getOwnPropertyNames(FileSessionStorage.prototype)) {
    const original: unknown = Object.getOwnPropertyDescriptor(FileSessionStorage.prototype, name)?.value;
    if (name === 'constructor' || typeof original !== 'function') continue;
    originals.set(name, original as (...args: unknown[]) => unknown);
    prototype[name] = function (this: unknown, ...args: unknown[]): unknown {
      const call = { name, at: performance.now(), settled: false };
      calls.push(call);
      const value: unknown = (original as (...args: unknown[]) => unknown).apply(this, args);
      const settle = () => { call.settled = true; };
      if (value instanceof Promise) void value.then(settle, settle);
      else settle();
      return value;
    };
  }
  return {
    inflight: () => calls.filter(call => !call.settled).map(call => call.name),
    startedSince: (mark) => calls.filter(call => call.at >= mark).map(call => call.name),
    restore: () => { for (const [name, original] of originals) prototype[name] = original; },
  };
}

it('leaves no Session storage work running once close() rejects for a fenced Session', async (context) => {
  // Installed before the fixture's spies, so restoring them keeps the trace.
  const trace = traceSessionStorage();
  let afterClose: { readonly inflight: readonly string[]; readonly started: readonly string[] } | undefined;
  try {
    await stopWithLateSiblingCommit(context, {
      beforeLateCommit: async ({ sessionId }) => {
        // Repair keeps failing with a retryable error past its budget, so it is
        // still retrying in the background when close() runs.
        const peek = FileSessionStorage.prototype.peek;
        vi.spyOn(FileSessionStorage.prototype, 'peek').mockImplementation(async function (this: FileSessionStorage, id) {
          const data = await peek.call(this, id);
          return id === sessionId && data ? { ...data, actorSnapshot: undefined } : data;
        });
        const now = Date.now.bind(Date);
        vi.spyOn(Date, 'now').mockImplementation(() => now() + 6 * 60_000);
      },
      onCloseError: async (error) => {
        expect(error).toMatchObject({ name: 'AgentShutdownPersistenceError' });
        const closedAt = performance.now();
        const inflight = trace.inflight();
        // Longer than the repair backoff reached by now and the display checkpoint spacing.
        await new Promise(resolve => setTimeout(resolve, 2_000));
        afterClose = { inflight, started: trace.startedSince(closedAt) };
      },
    }, async ({ runtime, runId }) => {
      await vi.waitFor(async () => {
        expect((await runtime.runs.get(runId)).phase).toBe('failed');
      }, { timeout: 15_000, interval: 100 });
      vi.mocked(Date.now).mockRestore();
    });
  } finally {
    trace.restore();
  }
  expect(afterClose).toEqual({ inflight: [], started: [] });
}, 60_000);

it('lets the Host stop while a Session it cannot repair stays fenced', async (context) => {
  let closed: { readonly error: unknown; readonly agentHomeActive: boolean } | undefined;
  await stopWithLateSiblingCommit(context, {
    beforeLateCommit: async ({ sessionId }) => {
      // Repair keeps failing with a retryable error past its budget, so the
      // Session is still fenced when the Host is asked to stop.
      const peek = FileSessionStorage.prototype.peek;
      vi.spyOn(FileSessionStorage.prototype, 'peek').mockImplementation(async function (this: FileSessionStorage, id) {
        const data = await peek.call(this, id);
        return id === sessionId && data ? { ...data, actorSnapshot: undefined } : data;
      });
      const now = Date.now.bind(Date);
      vi.spyOn(Date, 'now').mockImplementation(() => now() + 6 * 60_000);
    },
    onCloseError: async (error, homeDir) => {
      closed = { error, agentHomeActive: getActiveAgentHomes().includes(resolve(homeDir, '.kodax')) };
    },
  }, async ({ runtime, homeDir, runId, stage }) => {
    await vi.waitFor(async () => {
      expect((await runtime.runs.get(runId)).phase).toBe('failed');
    }, { timeout: 15_000, interval: 100 });
    vi.mocked(Date.now).mockRestore();
    // The fenced controller can commit nothing more, so its children are not
    // live work that should keep the Host from stopping.
    const preflight = await runtime.status.preflight();
    expect(preflight, JSON.stringify(preflight)).toMatchObject({ activeAgentTurns: [], blockers: [], canStop: true });

    stage('stopping the Host through the daemon protocol');
    const paths = resolveRuntimeDaemonPaths(homeDir, 'default');
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error('Expected the daemon lock.');
    const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint: process.platform === 'win32'
      ? { kind: 'pipe', path: `\\\\.\\pipe\\kodax-fenced-stop-${randomUUID()}` }
      : { kind: 'unix', path: join(homeDir, 'daemon.sock') } });
    const client = await createRuntimeDaemonSocketClientTransport(host.endpoint);
    try {
      await client.request('initialize', { profile: 'default', token: readRuntimeDaemonToken(paths) });
      await expect(client.request('daemon.stop')).resolves.toEqual({ ok: true });
      await host.closed;
    } finally {
      await client.close?.();
    }
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
  });
  // close() still reports the Actor tree it leaves to restart recovery, but the
  // rest of the Runtime is closed.
  expect(closed).toMatchObject({ error: { name: 'AgentShutdownPersistenceError' }, agentHomeActive: false });
}, 60_000);

it('starts a continuation queued behind Actor repair once background repair lifts the Session fence', async (context) => {
  const executions = codingMock.runManagedTask.mock.calls.length + 1;
  let successorId: string | undefined;
  await stopWithLateSiblingCommit(context, {
    beforeLateCommit: async ({ runtime, sessionId, runId }) => {
      // Accepted behind the unconfirmed Stop while its repair is still pending.
      const queued = await runtime.runs.submitInput({ sessionId, afterRunId: runId, delivery: 'after_turn',
        input: [{ type: 'text', text: 'continue after repair' }] });
      if (queued.accepted) successorId = queued.runId;
      const peek = FileSessionStorage.prototype.peek;
      vi.spyOn(FileSessionStorage.prototype, 'peek').mockImplementation(async function (this: FileSessionStorage, id) {
        const data = await peek.call(this, id);
        return id === sessionId && data ? { ...data, actorSnapshot: undefined } : data;
      });
      const now = Date.now.bind(Date);
      vi.spyOn(Date, 'now').mockImplementation(() => now() + 6 * 60_000);
    },
  }, async ({ runtime, runId, stage }) => {
    if (successorId === undefined) throw new Error('Expected the continuation to be accepted.');
    await vi.waitFor(async () => {
      expect((await runtime.runs.get(runId)).phase).toBe('failed');
    }, { timeout: 15_000, interval: 100 });
    // Like the successor of any failed Run, it waits for the Session instead of being dropped.
    expect((await runtime.runs.get(successorId)).phase).toBe('queued');
    vi.mocked(Date.now).mockRestore();
    vi.mocked(FileSessionStorage.prototype.peek).mockRestore();

    stage('awaiting the queued continuation once repair lifts the fence');
    await vi.waitFor(() => {
      expect(codingMock.runManagedTask).toHaveBeenCalledTimes(executions + 1);
    }, { timeout: 15_000, interval: 100 });
    await runtime.runs.abort(successorId);
  });
}, 60_000);
