import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { FileSessionStorage } from '@kodax-ai/repl';

import { executeChildAgents } from '../packages/coding/src/child-executor.js';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';

vi.mock('../packages/coding/src/child-executor.js', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/coding/src/child-executor.js')>(),
  executeChildAgents: vi.fn(),
}));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type RuntimeFixture = Awaited<ReturnType<typeof createKodaXRuntime>>;
type ExactTurn = { readonly actorPath: string; readonly turnId: string };
type RunEnvelope = Record<string, unknown> & { _runtime: Record<string, unknown> };

async function waitExactTurn(runtime: RuntimeFixture, sessionId: string, turn: ExactTurn, signal: AbortSignal,
  expected: 'completed' | 'failed' = 'completed'): Promise<void> {
  let cursor = 0;
  for (;;) {
    signal.throwIfAborted();
    const output = await runtime.agents.output(sessionId, turn.actorPath, turn.turnId);
    signal.throwIfAborted();
    if (output.state !== 'accepted' && output.state !== 'running') {
      expect(output.state).toBe(expected);
      return;
    }
    const event = await runtime.agents.wait(sessionId, cursor, 100, { signal });
    if (event) cursor = event.sequence;
  }
}

async function readRunEnvelope(homeDir: string, runId: string): Promise<{ statusFile: string; persisted: RunEnvelope }> {
  const statusFile = join(homeDir, '.kodax', 'runtime', 'runs', encodeURIComponent(runId), 'status.json');
  const persisted: unknown = JSON.parse(await readFile(statusFile, 'utf8'));
  if (!isRecord(persisted) || !isRecord(persisted._runtime)) throw new Error('Run fixture has no durable Runtime envelope.');
  return { statusFile, persisted: persisted as RunEnvelope };
}

it('does not overwrite a competing Run owner or revision after reading the canonical Actor', async ({ signal }) => {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-reconcile-cas-'));
  const first = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  let restarted: RuntimeFixture | undefined;
  let restoreSnapshotRead: (() => void) | undefined;
  try {
    vi.mocked(executeChildAgents).mockImplementation(async bundles => ({
      results: [{ childId: bundles[0]!.id, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid',
        summary: 'Canonical before competing Run update.', evidenceRefs: [], contradictions: [] }],
      mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [],
    }));
    const session = await first.sessions.create({ title: 'Canonical reconciliation CAS' });
    const authority = {
      origin: { principalId: 'cas-client', clientName: 'test' },
      providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'fixture-only' }),
      tools: ['read'], authorization: undefined,
    };
    const turn = await first.agents.spawn(session.id, { taskName: 'worker', objective: 'Do not overwrite a competing owner.' }, authority);
    await waitExactTurn(first, session.id, turn, signal);
    const canonicalTurn = (await first.agents.detail(session.id, turn.actorPath)).turns.find(value => value.turnId === turn.turnId);
    const run = (await first.runs.list({ sessionId: session.id })).find(value => value.turnId === turn.turnId);
    if (!run || !canonicalTurn) throw new Error('CAS fixture did not publish its exact Run and Turn.');
    await first.close();
    const { statusFile, persisted } = await readRunEnvelope(homeDir, run.runId);
    const crashWindow = { ...persisted, phase: 'running', stage: 'executing', endedAt: undefined, terminal: undefined,
      _runtime: { ...persisted._runtime, actor: { actorPath: turn.actorPath, turnId: turn.turnId, createdAt: canonicalTurn.createdAt } } };
    await writeFile(statusFile, JSON.stringify(crashWindow));
    const oldRevision = persisted._runtime.revision;
    if (typeof oldRevision !== 'number') throw new Error('CAS fixture has no durable revision.');
    const competingOwner = { ownerId: 'competing-owner', runtimeId: 'competing-runtime', pid: process.pid, startedAt: run.startedAt };
    const readSnapshot = FileSessionStorage.prototype.readActorSnapshot;
    let raced = false;
    const read = vi.spyOn(FileSessionStorage.prototype, 'readActorSnapshot').mockImplementation(async function (this: FileSessionStorage, id, options) {
      const snapshot = await readSnapshot.call(this, id, options);
      if (id === session.id && !raced) {
        raced = true;
        await writeFile(statusFile, JSON.stringify({ ...crashWindow,
          _runtime: { ...crashWindow._runtime, revision: oldRevision + 1, owner: competingOwner } }));
      }
      return snapshot;
    });
    restoreSnapshotRead = () => read.mockRestore();
    restarted = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
    expect(raced).toBe(true);
    const current: unknown = JSON.parse(await readFile(statusFile, 'utf8'));
    expect(current).toMatchObject({ phase: 'running', _runtime: { revision: oldRevision + 1, owner: competingOwner } });
    const observed = await restarted.runs.get(run.runId);
    expect(observed.phase).toBe('unknown');
    expect(observed.terminal).toBeUndefined();
    expect(vi.mocked(executeChildAgents)).toHaveBeenCalledTimes(1);
  } finally {
    restoreSnapshotRead?.();
    await restarted?.close();
    await first.close();
    vi.mocked(executeChildAgents).mockReset();
    if (dirname(homeDir) !== temporaryRoot) throw new Error('Refusing to remove a fixture outside its temporary root.');
    await rm(homeDir, { recursive: true, force: true });
  }
}, 30_000);

it('reconciles a committed independent Actor after restart without executing its Turn again', async ({ signal }) => {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-settlement-'));
  const first = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  let restarted: RuntimeFixture | undefined;
  try {
    vi.mocked(executeChildAgents).mockImplementation(async bundles => ({
      results: [{ childId: bundles[0]!.id, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid',
        summary: 'Verified EDIT019 without repetition.', evidenceRefs: [], contradictions: [] }],
      mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [],
    }));
    const session = await first.sessions.create({ title: 'Independent Actor terminal reconciliation' });
    const authority = {
      origin: { principalId: 'reconciliation-client', clientName: 'test' },
      providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'fixture-only' }),
      tools: ['read'], authorization: undefined,
    };
    const turn = await first.agents.spawn(session.id, {
      taskName: 'worker', objective: 'Verify EDIT019 without repeating its completed edit.',
    }, authority);
    await waitExactTurn(first, session.id, turn, signal);
    const completedTurn = (await first.agents.detail(session.id, turn.actorPath)).turns.find(value => value.turnId === turn.turnId);
    expect(completedTurn).toBeDefined();
    const run = (await first.runs.list({ sessionId: session.id })).find(value => value.turnId === turn.turnId);
    if (!run || !completedTurn) throw new Error('Independent Actor fixture did not publish its exact Run and Turn.');
    expect(vi.mocked(executeChildAgents)).toHaveBeenCalledTimes(1);
    await first.close();

    // Model death after Actor canonical commit but before the matching Run terminal write.
    // Keep the real Actor snapshot and dead owner; only restore the preceding Run state.
    const { statusFile, persisted } = await readRunEnvelope(homeDir, run.runId);
    await writeFile(statusFile, JSON.stringify({
      ...persisted, phase: 'running', stage: 'executing', endedAt: undefined, terminal: undefined,
      _runtime: { ...persisted._runtime, actor: {
        actorPath: turn.actorPath, turnId: turn.turnId, createdAt: completedTurn.createdAt,
      } },
    }));

    restarted = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
    await expect(restarted.runs.get(run.runId)).resolves.toMatchObject({
      phase: 'completed', terminal: { kind: 'completed' },
    });
    await expect(restarted.agents.output(session.id, turn.actorPath, turn.turnId)).resolves.toMatchObject({ state: 'completed' });
    expect(vi.mocked(executeChildAgents)).toHaveBeenCalledTimes(1);
  } finally {
    await restarted?.close();
    await first.close();
    vi.mocked(executeChildAgents).mockReset();
    if (dirname(homeDir) !== temporaryRoot) throw new Error('Refusing to remove a fixture outside its temporary root.');
    await rm(homeDir, { recursive: true, force: true });
  }
}, 30_000);

it('persists the exact independent Actor binding before its worker dispatches', async ({ signal }) => {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-dispatch-binding-'));
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  let releaseExecution!: () => void;
  const executionGate = new Promise<void>(resolve => { releaseExecution = resolve; });
  signal.addEventListener('abort', releaseExecution, { once: true });
  let observeDispatch!: (value: { sessionId: unknown; actor: unknown;
    expectedActor: { actorPath: string; turnId: string; createdAt: string } }) => void;
  let rejectObservation!: (error: unknown) => void;
  const dispatch = new Promise<Parameters<typeof observeDispatch>[0]>((resolve, reject) => {
    observeDispatch = resolve;
    rejectObservation = reject;
  });
  try {
    const session = await runtime.sessions.create({ title: 'Durable binding before dispatch' });
    vi.mocked(executeChildAgents).mockImplementation(async (bundles, _context, options) => {
      try {
        const actorPath = options.actorControl?.callerPath;
        const turnId = options.actorTurnId;
        if (!actorPath || !turnId) throw new Error('Worker dispatch has no exact Actor identity.');
        const turn = (await runtime.agents.detail(session.id, actorPath)).turns.find(value => value.turnId === turnId);
        const run = (await runtime.runs.list({ sessionId: session.id })).find(value => value.turnId === turnId);
        if (!turn || !run) throw new Error('Worker dispatched before its canonical Turn and Run were available.');
        const { persisted } = await readRunEnvelope(homeDir, run.runId);
        observeDispatch({ sessionId: persisted.sessionId, actor: persisted._runtime.actor,
          expectedActor: { actorPath, turnId, createdAt: turn.createdAt } });
        await executionGate;
        return {
          results: [{ childId: bundles[0]!.id, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid',
            summary: 'Binding verified before execution.', evidenceRefs: [], contradictions: [] }],
          mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [],
        };
      } catch (error: unknown) { rejectObservation(error); throw error; }
    });
    const authority = {
      origin: { principalId: 'binding-client', clientName: 'test' },
      providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'fixture-only' }),
      tools: ['read'], authorization: undefined,
    };
    await runtime.agents.spawn(session.id, { taskName: 'worker', objective: 'Observe the durable binding.' }, authority);
    const observed = await dispatch;
    expect(observed.sessionId).toBe(session.id);
    expect(observed.actor).toEqual(observed.expectedActor);
    expect(vi.mocked(executeChildAgents)).toHaveBeenCalledTimes(1);
  } finally {
    releaseExecution();
    await runtime.close();
    signal.removeEventListener('abort', releaseExecution);
    vi.mocked(executeChildAgents).mockReset();
    if (dirname(homeDir) !== temporaryRoot) throw new Error('Refusing to remove a fixture outside its temporary root.');
    await rm(homeDir, { recursive: true, force: true });
  }
}, 30_000);

it('reconciles a foreign independent Run when its owner dies after this Host starts', async ({ signal }) => {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-observed-owner-'));
  const first = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  let observer: RuntimeFixture | undefined;
  try {
    vi.mocked(executeChildAgents).mockImplementation(async bundles => ({
      results: [{ childId: bundles[0]!.id, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid',
        summary: 'Completed once before owner death.', evidenceRefs: [], contradictions: [] }],
      mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [],
    }));
    const session = await first.sessions.create({ title: 'Observe owner death after startup' });
    const authority = {
      origin: { principalId: 'observed-owner-client', clientName: 'test' },
      providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'fixture-only' }),
      tools: ['read'], authorization: undefined,
    };
    const turn = await first.agents.spawn(session.id, { taskName: 'worker', objective: 'Complete without being replayed.' }, authority);
    await waitExactTurn(first, session.id, turn, signal);
    const completedTurn = (await first.agents.detail(session.id, turn.actorPath)).turns.find(value => value.turnId === turn.turnId);
    const run = (await first.runs.list({ sessionId: session.id })).find(value => value.turnId === turn.turnId);
    if (!run || !completedTurn) throw new Error('Owner-death fixture did not publish its exact Run and Turn.');
    const { statusFile, persisted } = await readRunEnvelope(homeDir, run.runId);
    await writeFile(statusFile, JSON.stringify({
      ...persisted, phase: 'running', stage: 'executing', endedAt: undefined, terminal: undefined,
      _runtime: { ...persisted._runtime, actor: {
        actorPath: turn.actorPath, turnId: turn.turnId, createdAt: completedTurn.createdAt,
      } },
    }));

    observer = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
    // The original owner is still alive here: startup must leave its Run alone.
    await expect(observer.runs.get(run.runId)).resolves.toMatchObject({ phase: 'running' });
    expect(vi.mocked(executeChildAgents)).toHaveBeenCalledTimes(1);
    await first.close();

    // This get exercises subsequent owner-death observation, not startup repair.
    await expect(observer.runs.get(run.runId)).resolves.toMatchObject({
      phase: 'completed', terminal: { kind: 'completed' },
    });
    await expect(observer.agents.output(session.id, turn.actorPath, turn.turnId)).resolves.toMatchObject({ state: 'completed' });
    expect(vi.mocked(executeChildAgents)).toHaveBeenCalledTimes(1);
  } finally {
    await observer?.close();
    await first.close();
    vi.mocked(executeChildAgents).mockReset();
    if (dirname(homeDir) !== temporaryRoot) throw new Error('Refusing to remove a fixture outside its temporary root.');
    await rm(homeDir, { recursive: true, force: true });
  }
}, 30_000);

for (const scenario of ['failed', 'failed-with-detail', 'legacy', 'completed-stop-detail',
  'wrong-createdAt', 'wrong-turnId', 'recovering-checkpoint', 'blocked-cleanup', 'snapshot-read-failure'] as const) {
it(`reconciles an independent Actor crash boundary safely (${scenario})`, async ({ signal }) => {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-reconciliation-guard-'));
  const first = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  let restarted: RuntimeFixture | undefined;
  let restoreSnapshotRead: (() => void) | undefined;
  const trustedFailureDetail = {
    failureKind: 'provider', stage: 'transport', providerErrorCode: 'request_timeout', safeMessage: 'Stored precise provider failure.',
  };
  try {
    vi.mocked(executeChildAgents).mockImplementation(async bundles => {
      if (scenario.startsWith('failed')) throw new Error('Fixture Actor execution failed.');
      return {
        results: [{ childId: bundles[0]!.id, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid',
          summary: 'Canonical guard outcome.', evidenceRefs: [], contradictions: [] }],
        mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [],
      };
    });
    const session = await first.sessions.create({ title: 'Independent Actor reconciliation guard' });
    const authority = {
      origin: { principalId: 'guard-client', clientName: 'test' },
      providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'fixture-only' }),
      tools: ['read'], authorization: undefined,
    };
    const turn = await first.agents.spawn(session.id, { taskName: 'worker', objective: 'Preserve the executor outcome.' }, authority);
    await waitExactTurn(first, session.id, turn, signal, scenario.startsWith('failed') ? 'failed' : 'completed');
    const canonicalTurn = (await first.agents.detail(session.id, turn.actorPath)).turns.find(value => value.turnId === turn.turnId);
    const run = (await first.runs.list({ sessionId: session.id })).find(value => value.turnId === turn.turnId);
    if (!run || !canonicalTurn) throw new Error('Reconciliation guard did not publish its exact Run and Turn.');
    await first.close();
    const { statusFile, persisted } = await readRunEnvelope(homeDir, run.runId);
    await writeFile(statusFile, JSON.stringify({
      ...persisted, phase: scenario === 'recovering-checkpoint' ? 'recovering' : 'running',
      stage: 'executing', endedAt: undefined, terminal: undefined,
      _runtime: { ...persisted._runtime, actor: scenario === 'legacy' ? undefined : {
        actorPath: turn.actorPath, turnId: scenario === 'wrong-turnId' ? `${turn.turnId}-missing` : turn.turnId,
        createdAt: scenario === 'wrong-createdAt' ? '1970-01-01T00:00:00.000Z' : canonicalTurn.createdAt,
      }, shellCleanups: scenario === 'blocked-cleanup' ? [{ unconfirmedCleanup: true }] : undefined },
      failureDetail: scenario === 'completed-stop-detail' ? {
        failureKind: 'cancelled', stage: 'runtime_control', providerErrorCode: 'cancelled', safeMessage: 'Run cancelled.',
      } : scenario === 'failed-with-detail' ? trustedFailureDetail : undefined,
      stop: scenario === 'completed-stop-detail' ? {
        state: 'unknown', outcome: 'unknown', reason: 'Late Stop', requestedAt: run.startedAt,
      } : undefined,
      contextRecovery: scenario === 'recovering-checkpoint' ? {
        waitingSince: run.startedAt, checkpoint: { version: 1, sessionId: 'old-worker-history',
          activeEntryId: null, messagesDigest: 'a'.repeat(64) },
      } : undefined,
    }));
    if (scenario === 'snapshot-read-failure') {
      const readSnapshot = FileSessionStorage.prototype.readActorSnapshot;
      const read = vi.spyOn(FileSessionStorage.prototype, 'readActorSnapshot').mockImplementation(async function (this: FileSessionStorage, id, options) {
        const snapshot = await readSnapshot.call(this, id, options);
        if (id === session.id) throw Object.assign(new Error('Injected Actor snapshot read failure.'), { code: 'EIO' });
        return snapshot;
      });
      restoreSnapshotRead = () => read.mockRestore();
    }
    restarted = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
    const expectedPhase = scenario.startsWith('failed') ? 'failed' : scenario === 'legacy' ? 'interrupted'
      : scenario === 'completed-stop-detail' || scenario === 'recovering-checkpoint' ? 'completed' : 'unknown';
    const recoveredStatus = await restarted.runs.get(run.runId);
    expect(recoveredStatus.phase).toBe(expectedPhase);
    if (expectedPhase === 'unknown') expect(recoveredStatus.terminal).toBeUndefined();
    else expect(recoveredStatus.terminal).toMatchObject({ kind: expectedPhase });
    if (scenario === 'failed') expect(recoveredStatus).not.toHaveProperty('failureDetail');
    if (scenario === 'failed-with-detail') expect(recoveredStatus.failureDetail).toEqual(trustedFailureDetail);
    if (scenario === 'completed-stop-detail') {
      const recovered = await restarted.runs.get(run.runId);
      expect(recovered).not.toHaveProperty('failureDetail');
      expect(recovered.terminal).not.toHaveProperty('failureKind');
      expect(recovered.stop).toMatchObject({ state: 'confirmed', outcome: 'completed' });
    }
    expect(vi.mocked(executeChildAgents)).toHaveBeenCalledTimes(1);
  } finally {
    restoreSnapshotRead?.();
    await restarted?.close();
    await first.close();
    vi.mocked(executeChildAgents).mockReset();
    if (dirname(homeDir) !== temporaryRoot) throw new Error('Refusing to remove a fixture outside its temporary root.');
    await rm(homeDir, { recursive: true, force: true });
  }
}, 30_000);
}
