import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';

import {
  setKodaXDiagnosticSink,
  type AgentActorSaveAttempt,
  type AgentActorSavePhase,
  type KodaXDiagnostic,
} from '@kodax-ai/agent';
import type { KodaXOptions, KodaXResult } from '@kodax-ai/coding';
import { KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider } from '@kodax-ai/llm';
import { FileSessionStorage } from '@kodax-ai/repl';
import { CodingActorSession } from '../packages/coding/src/agent-runtime/actor-runtime.js';
import { executeChildAgents } from '../packages/coding/src/child-executor.js';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';

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
    diagnostics: () => ({ attemptId: 'late-workflow-stop-commit', phase, timingsMs: {} }),
  };
}

class FixtureProvider extends KodaXBaseProvider {
  readonly name = 'workflow-stop-fixture';
  readonly supportsThinking = false;
  protected readonly config = { apiKeyEnv: 'KODAX_WORKFLOW_STOP_FIXTURE_KEY', model: 'fixture', supportsThinking: false };
  async stream(): Promise<never> { throw new Error('Unexpected LLM request outside the child seam'); }
}

const WORKFLOW_SOURCE = 'async function run(wf) { const result = await wf.runAgent({ name: "gen", '
  + 'prompt: "Generate the part.", readOnly: true }); return { synthesis: result.finalText }; }';

type Runtime = Awaited<ReturnType<typeof createKodaXRuntime>>;
interface StoppedWorkflowRun {
  readonly runtime: Runtime;
  readonly sessionId: string;
  readonly runId: string;
  readonly stage: (value: string) => void;
}
interface LateCommitOptions {
  /** Runs after the Stop save has timed out and before it commits late. */
  readonly beforeLateCommit?: (stopped: StoppedWorkflowRun) => Promise<void>;
  readonly onDiagnostic?: (diagnostic: KodaXDiagnostic) => void;
  readonly onCloseError?: (error: unknown) => void;
}
interface TestContext {
  readonly signal: AbortSignal;
  readonly onTestFailed: (handler: () => void) => void;
}

/**
 * A Workflow-owned Run has one child Actor running when Stop arrives. The save
 * that interrupts the child misses its deadline and commits late; `verify` then
 * observes how the Runtime settles the Run.
 */
async function stopWorkflowWithLateCommit(
  { signal, onTestFailed }: TestContext,
  options: LateCommitOptions,
  verify: (stopped: StoppedWorkflowRun) => Promise<void>,
): Promise<void> {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-workflow-stop-late-commit-'));
  const childEntered = deferred();
  const lateCommit = deferred();
  const cancellationFailed = deferred();
  signal.addEventListener('abort', () => {
    childEntered.resolve(); lateCommit.resolve(); cancellationFailed.resolve();
  }, { once: true });
  let runId: string | undefined;
  let childPath: string | undefined;
  const diagnostics: Array<{ source: string; message: string }> = [];
  const restoreDiagnostics = setKodaXDiagnosticSink(diagnostic => {
    if (diagnostic.source === 'runtime.run.actor-cancellation'
      && runId !== undefined && diagnostic.message.includes(runId)) cancellationFailed.resolve();
    if (diagnostics.length < 32) diagnostics.push({ source: diagnostic.source, message: diagnostic.message.slice(0, 512) });
    options.onDiagnostic?.(diagnostic);
  });
  let stage = 'starting the Workflow Run';
  onTestFailed(() => {
    process.stderr.write(`[Late Workflow Stop commit diagnostics] ${JSON.stringify({ stage, childPath, diagnostics })}\n`);
  });
  process.env.KODAX_WORKFLOW_STOP_FIXTURE_KEY = 'local-test-only';
  registerModelProvider('workflow-stop-fixture', () => new FixtureProvider());
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'workflow-stop-fixture' });
  try {
    codingMock.runManagedTask.mockImplementation(async (runOptions: KodaXOptions): Promise<KodaXResult> =>
      abortable(runOptions.abortSignal));
    vi.mocked(executeChildAgents).mockImplementation(async (_bundles, _context, childOptions) => {
      childPath = childOptions.contextAgentId;
      childEntered.resolve();
      return abortable(childOptions.abortSignal);
    });
    const beginSave = FileSessionStorage.prototype.beginActorSnapshotSave;
    let stopSaveArmed = true;
    vi.spyOn(FileSessionStorage.prototype, 'beginActorSnapshotSave').mockImplementation(function (
      this: FileSessionStorage, id, snapshot, expectedRevision,
    ) {
      const interrupted = snapshot.turns.filter(turn => turn.state === 'interrupted').map(turn => turn.actorPath);
      if (stopSaveArmed && childPath !== undefined && interrupted.includes(childPath)) {
        stopSaveArmed = false;
        return lateCommitAttempt(lateCommit.promise, () => beginSave.call(this, id, snapshot, expectedRevision).canonical);
      }
      return beginSave.call(this, id, snapshot, expectedRevision);
    });

    const session = await runtime.sessions.create({ title: 'Stop a Workflow with a late commit', projectPath: homeDir });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', agentMode: 'ama' });
    const started = await runtime.workflows.start({
      sessionId: session.id, projectRoot: homeDir, provider: 'workflow-stop-fixture',
      source: { kind: 'inline', source: WORKFLOW_SOURCE, manifest: { name: 'late-stop', description: 'Generate one part',
        readOnly: true, maxAgents: 1, maxConcurrency: 1, tokenBudget: 1000, phases: ['generate'],
        patterns: ['fan-out-and-synthesize'] } },
    });
    if (started.kind !== 'started') throw new Error(started.reason);
    runId = started.runId;
    const stopped: StoppedWorkflowRun = { runtime, sessionId: session.id, runId, stage: (value) => { stage = value; } };
    stage = 'waiting for the Workflow child';
    await childEntered.promise;
    signal.throwIfAborted();

    stage = 'stopping while the child interruption save is slow';
    await runtime.runs.abort(runId);
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
    clearRuntimeModelProviders();
    delete process.env.KODAX_WORKFLOW_STOP_FIXTURE_KEY;
    vi.mocked(executeChildAgents).mockReset();
    if (closeError !== undefined) {
      if (!options.onCloseError) throw closeError.error;
      options.onCloseError(closeError.error);
    }
    if (dirname(homeDir) !== temporaryRoot) throw new Error('Refusing to remove a fixture outside its temporary root.');
    // A failed close leaves Session maintenance writing briefly.
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** From the call on, same-owner repair fails with AgentOwnerConflictError on every attempt. */
function readActorSnapshotAsForeign(sessionId: string): void {
  const peek = FileSessionStorage.prototype.peek;
  vi.spyOn(FileSessionStorage.prototype, 'peek').mockImplementation(async function (this: FileSessionStorage, id) {
    const data = await peek.call(this, id);
    const snapshot = data?.actorSnapshot;
    if (data === null || id !== sessionId || snapshot?.schemaVersion !== 2 || snapshot.owner === undefined) return data;
    return { ...data, actorSnapshot: { ...snapshot, owner: { ...snapshot.owner, ownerId: 'foreign-owner' } } };
  });
}

async function expectFinalOutcomeWithFencedSession(
  { runtime, sessionId, runId, stage }: StoppedWorkflowRun,
): Promise<void> {
  let status = await runtime.runs.get(runId);
  await vi.waitFor(async () => {
    status = await runtime.runs.get(runId);
    stage(`awaiting a final Workflow outcome after the repair gave up: ${JSON.stringify(status).slice(0, 3000)}`);
    expect(status.phase).toBe('failed');
  }, { timeout: 15_000, interval: 100 });
  const evidence = JSON.stringify(status);
  expect(status.terminal, evidence).toMatchObject({
    kind: 'failed', code: 'actor_settlement_not_persisted', effectOutcome: 'unknown',
  });
  await expect(runtime.runs.await(runId)).resolves.toMatchObject({ phase: expect.any(String) });

  stage('starting a successor while the Actor tree is still unconfirmed');
  await expect(runtime.runs.start({ sessionId, prompt: 'next', mode: 'managed_task' }))
    .rejects.toMatchObject({ code: 'actor_settlement_not_persisted' });
}

it('gives a Workflow Stop whose Actor repair fails deterministically a final outcome and keeps the Session fenced', async (context) => {
  let closeError: unknown;
  await stopWorkflowWithLateCommit(context, {
    beforeLateCommit: async ({ sessionId }) => readActorSnapshotAsForeign(sessionId),
    onCloseError: (error) => { closeError = error; },
  }, expectFinalOutcomeWithFencedSession);
  // The Actor owner fence is never released in-process; restart recovery owns it.
  expect(closeError).toBeDefined();
}, 60_000);

it('applies a repair give-up that lands while the Workflow Promise is still settling', async (context) => {
  let closeError: unknown;
  const repairGaveUp = deferred();
  context.signal.addEventListener('abort', () => repairGaveUp.resolve(), { once: true });
  // The Workflow Promise settles only after repair has already given up.
  const settleOwner = CodingActorSession.prototype.settleWorkflowOwner;
  vi.spyOn(CodingActorSession.prototype, 'settleWorkflowOwner').mockImplementation(async function (
    this: CodingActorSession, ...args
  ) {
    await repairGaveUp.promise;
    return settleOwner.apply(this, args);
  });
  await stopWorkflowWithLateCommit(context, {
    onDiagnostic: (diagnostic) => {
      if (diagnostic.source === 'runtime.run.actor-cancellation'
        && diagnostic.detail instanceof Error && diagnostic.detail.name === 'AgentOwnerConflictError') repairGaveUp.resolve();
    },
    beforeLateCommit: async ({ sessionId }) => readActorSnapshotAsForeign(sessionId),
    onCloseError: (error) => { closeError = error; },
  }, expectFinalOutcomeWithFencedSession);
  expect(closeError).toBeDefined();
}, 60_000);

it('finalizes a Workflow Stop and releases its Session once storage recovers after the repair budget', async (context) => {
  let closeError: unknown;
  await stopWorkflowWithLateCommit(context, {
    beforeLateCommit: async ({ sessionId }) => {
      // Repair fails with a retryable error (missing snapshot) on every
      // attempt, and the wall clock is already past the repair budget.
      const peek = FileSessionStorage.prototype.peek;
      vi.spyOn(FileSessionStorage.prototype, 'peek').mockImplementation(async function (this: FileSessionStorage, id) {
        const data = await peek.call(this, id);
        return id === sessionId && data ? { ...data, actorSnapshot: undefined } : data;
      });
      const now = Date.now.bind(Date);
      vi.spyOn(Date, 'now').mockImplementation(() => now() + 6 * 60_000);
    },
    onCloseError: (error) => { closeError = error; },
  }, async ({ runtime, sessionId, runId, stage }) => {
    let status = await runtime.runs.get(runId);
    await vi.waitFor(async () => {
      status = await runtime.runs.get(runId);
      stage(`awaiting the out-of-budget Workflow outcome: ${JSON.stringify(status).slice(0, 3000)}`);
      expect(status.phase).toBe('failed');
    }, { timeout: 15_000, interval: 100 });
    expect(status.terminal, JSON.stringify(status)).toMatchObject({
      kind: 'failed', code: 'actor_settlement_not_persisted', effectOutcome: 'unknown',
    });
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
    await vi.waitFor(async () => {
      const next = await runtime.runs.get(started);
      stage(`awaiting the successor to execute: ${JSON.stringify(next).slice(0, 2000)}`);
      expect(next.phase).toBe('running');
    }, { timeout: 10_000, interval: 100 });
    await runtime.runs.abort(started);
  });
  // A healthy Actor tree must release its owner on close.
  expect(closeError).toBeUndefined();
}, 60_000);
