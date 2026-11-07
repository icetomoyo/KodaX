import { createHash } from 'node:crypto';
import fsPromises, { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createSessionLineage, setKodaXDiagnosticSink, type AgentActorSaveAttempt, type AgentTurnRef } from '@kodax-ai/agent';
import { FileSessionStorage } from '@kodax-ai/repl';
import { executeChildAgents } from '../packages/coding/src/child-executor.js';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';

vi.mock('../packages/coding/src/child-executor.js', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/coding/src/child-executor.js')>(),
  executeChildAgents: vi.fn(),
}));

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolvePromise => { release = resolvePromise; });
  return { promise, release };
}

function childResult(childId: string): Awaited<ReturnType<typeof executeChildAgents>> {
  return { results: [{ childId, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid',
    summary: 'Verified the exact Actor outcome.', evidenceRefs: [], contradictions: [] }],
  mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [] };
}

async function awaitCompleted(runtime: Awaited<ReturnType<typeof createKodaXRuntime>>, sessionId: string,
  turn: AgentTurnRef, signal: AbortSignal): Promise<void> {
  let cursor = 0;
  for (;;) {
    signal.throwIfAborted();
    const output = await runtime.agents.output(sessionId, turn.actorPath, turn.turnId);
    if (output.state !== 'accepted' && output.state !== 'running') {
      expect(output.state, JSON.stringify(output)).toBe('completed');
      return;
    }
    const event = await runtime.agents.wait(sessionId, cursor, 100, { signal });
    if (event) cursor = event.sequence;
  }
}

it('retains an already canonical independent Actor while its peer becomes unknown and repairs', async ({ signal, onTestFailed }) => {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-completed-peer-unknown-'));
  const peerEntered = deferred();
  const peerExecution = deferred();
  const renameEntered = deferred();
  const terminalCommit = deferred();
  const unknownObserved = deferred();
  const releaseGates = () => { peerExecution.release(); terminalCommit.release(); };
  signal.addEventListener('abort', releaseGates, { once: true });
  const diagnostics: string[] = [];
  const restoreDiagnostics = setKodaXDiagnosticSink(diagnostic => {
    if (diagnostics.length < 16) diagnostics.push(`${diagnostic.source}: ${diagnostic.message}`.slice(0, 512));
  });
  let stage = 'starting';
  let terminalAttempt: AgentActorSaveAttempt | undefined;
  onTestFailed(() => {
    process.stderr.write(`Completed Actor isolation evidence: ${JSON.stringify({ stage, diagnostics, save: terminalAttempt?.diagnostics() })}\n`);
  });
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  let subscription: ReturnType<typeof runtime.events.subscribe> | undefined;
  try {
    vi.mocked(executeChildAgents).mockImplementation(async (bundles, _context, options) => {
      if (options.actorControl?.callerPath === '/root/peer') {
        peerEntered.release();
        await peerExecution.promise;
      }
      return childResult(bundles[0]!.id);
    });
    const session = await runtime.sessions.create({ title: 'Completed Actor survives shared unknown' });
    const authority = { origin: { principalId: 'completed-peer-client', clientName: 'test' },
      providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'fixture-only' }),
      tools: ['read'], authorization: undefined };
    const completed = await runtime.agents.spawn(session.id, { taskName: 'completed', objective: 'Complete before the peer becomes unknown.' }, authority);
    await awaitCompleted(runtime, session.id, completed, signal);
    const completedRun = (await runtime.runs.list({ sessionId: session.id })).find(value => value.turnId === completed.turnId);
    if (!completedRun) throw new Error('Completed Actor has no exact Run.');
    await expect(runtime.runs.await(completedRun.runId)).resolves.toMatchObject({ phase: 'completed', terminal: { kind: 'completed' } });
    const authoritativeCompleted = await runtime.runs.get(completedRun.runId);

    const peer = await runtime.agents.spawn(session.id, { taskName: 'peer', objective: 'Become uncertain after the first Actor is canonical.' }, authority);
    await peerEntered.promise;
    const peerRun = (await runtime.runs.list({ sessionId: session.id })).find(value => value.turnId === peer.turnId);
    if (!peerRun) throw new Error('Unknown peer has no exact Run.');
    const peerResult = runtime.runs.await(peerRun.runId);
    const completedEvents: string[] = [];
    subscription = runtime.events.subscribe({ sessionId: session.id }, event => {
      if (event.runId === completedRun.runId) completedEvents.push(event.type);
      if (event.runId === peerRun.runId && event.type === 'run.updated'
        && typeof event.payload === 'object' && event.payload !== null && 'phase' in event.payload
        && event.payload.phase === 'unknown') unknownObserved.release();
    });
    let holdRename = false;
    const beginSave = FileSessionStorage.prototype.beginActorSnapshotSave;
    vi.spyOn(FileSessionStorage.prototype, 'beginActorSnapshotSave').mockImplementation(function (
      this: FileSessionStorage, id, snapshot, expectedRevision,
    ) {
      const exactTerminal = id === session.id && snapshot.turns.some(value => value.actorPath === peer.actorPath
        && value.turnId === peer.turnId && value.state === 'completed');
      if (exactTerminal) holdRename = true;
      const attempt = beginSave.call(this, id, snapshot, expectedRevision);
      if (exactTerminal) terminalAttempt = attempt;
      return attempt;
    });
    const rename = fsPromises.rename;
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (source, destination) => {
      if (holdRename && String(destination).endsWith(`${session.id}.jsonl`)) {
        holdRename = false;
        renameEntered.release();
        await terminalCommit.promise;
      }
      return rename(source, destination);
    });
    stage = 'awaiting peer unknown';
    peerExecution.release();
    await renameEntered.promise;
    expect(terminalAttempt?.phase()).toBe('commit_inflight');
    await unknownObserved.promise;
    await expect(peerResult).resolves.toMatchObject({ phase: 'unknown' });
    await expect(runtime.runs.get(completedRun.runId)).resolves.toEqual(authoritativeCompleted);
    await expect(runtime.agents.output(session.id, completed.actorPath, completed.turnId)).resolves.toMatchObject({ state: 'completed' });
    expect(completedEvents).toEqual([]);
    await expect(runtime.runs.start({ sessionId: session.id, prompt: 'Remain fenced while peer storage is unknown.' }))
      .rejects.toMatchObject({ code: 'actor_settlement_not_persisted' });

    stage = 'awaiting peer repair';
    terminalCommit.release();
    await awaitCompleted(runtime, session.id, peer, signal);
    await expect(runtime.runs.get(peerRun.runId)).resolves.toMatchObject({ phase: 'completed', terminal: { kind: 'completed' } });
    await expect(runtime.runs.get(completedRun.runId)).resolves.toEqual(authoritativeCompleted);
    expect(completedEvents).toEqual([]);
    expect(executeChildAgents).toHaveBeenCalledTimes(2);
  } finally {
    releaseGates();
    subscription?.close();
    vi.restoreAllMocks();
    await runtime.close();
    restoreDiagnostics();
    signal.removeEventListener('abort', releaseGates);
    vi.mocked(executeChildAgents).mockReset();
    if (dirname(homeDir) !== temporaryRoot) throw new Error('Refusing to remove a fixture outside its temporary root.');
    await rm(homeDir, { recursive: true, force: true });
  }
}, 30_000);

it('retains checkpoint owner liveness after a failed close and permits takeover only after retry succeeds', async ({ signal, onTestFailed }) => {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-checkpoint-close-retry-'));
  const checkpointEntered = deferred();
  const first = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  let contender: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
  let lastEvidence = '';
  onTestFailed(() => { process.stderr.write(`Checkpoint close retry evidence: ${lastEvidence}\n`); });
  try {
    vi.mocked(executeChildAgents).mockImplementationOnce(async (_bundles, _context, options) => {
      const messages = [{ role: 'user' as const, content: 'EDIT019 already exists. Resume only this verified generation.' }];
      const lineage = createSessionLineage(messages);
      const workerId = 'independent-close-retry-worker';
      await options.historyStorage!.save(workerId, { messages, lineage, gitRoot: homeDir, title: 'Close retry worker', scope: 'managed-task-worker' });
      const checkpoint = { version: 1 as const, sessionId: workerId, activeEntryId: lineage.activeEntryId,
        messagesDigest: createHash('sha256').update(JSON.stringify(messages)).digest('hex') };
      checkpointEntered.release();
      await options.parentOptions!.events!.onContextCapacityBlocked!({ checkpoint }, options.abortSignal,
        { childAgentId: options.actorControl!.callerPath, turnId: options.actorTurnId });
      throw new Error('Original checkpoint execution must remain suspended.');
    });
    const session = await first.sessions.create({ title: 'Independent checkpoint close failure and retry' });
    const authority = { origin: { principalId: 'close-retry-client', clientName: 'test' },
      providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'fixture-only' }),
      tools: ['read'], authorization: undefined };
    const turn = await first.agents.spawn(session.id, { taskName: 'worker', objective: 'Preserve the original verified checkpoint.' }, authority);
    await checkpointEntered.promise;
    let cursor = 0;
    let run: Awaited<ReturnType<typeof first.runs.get>> | undefined;
    for (;;) {
      signal.throwIfAborted();
      const actor = await first.agents.detail(session.id, turn.actorPath);
      run = (await first.runs.list({ sessionId: session.id })).find(value => value.turnId === turn.turnId);
      if (actor.turns.find(value => value.turnId === turn.turnId)?.checkpoint && run?.contextRecovery?.checkpoint
        && run.phase === 'recovering') break;
      const event = await first.agents.wait(session.id, cursor, 100, { signal });
      if (event) cursor = event.sequence;
    }
    const checkpoint = run.contextRecovery?.checkpoint;
    if (!checkpoint) throw new Error('Close retry fixture has no verified generation checkpoint.');
    let releaseArmed = false;
    let releaseRejected = false;
    const beginSave = FileSessionStorage.prototype.beginActorSnapshotSave;
    const save = vi.spyOn(FileSessionStorage.prototype, 'beginActorSnapshotSave').mockImplementation(function (
      this: FileSessionStorage, id, snapshot, expectedRevision,
    ) {
      if (id === session.id && snapshot.schemaVersion === 2 && snapshot.owner === undefined) releaseArmed = true;
      return beginSave.call(this, id, snapshot, expectedRevision);
    });
    const rename = fsPromises.rename;
    const renameSpy = vi.spyOn(fsPromises, 'rename').mockImplementation(async (source, destination) => {
      if (releaseArmed && !releaseRejected && String(destination).endsWith(`${session.id}.jsonl`)) {
        releaseArmed = false;
        releaseRejected = true;
        throw Object.assign(new Error('Fixture checkpoint owner release failed once.'), { code: 'EIO' });
      }
      return rename(source, destination);
    });
    const closing = first.close();
    expect(first.close()).toBe(closing);
    await expect(closing).rejects.toMatchObject({ code: 'EIO' });
    expect(releaseRejected).toBe(true);
    save.mockRestore();
    renameSpy.mockRestore();
    contender = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
    await expect(contender.runs.get(run.runId)).resolves.toMatchObject({ phase: 'recovering' });
    await expect(contender.agents.tree(session.id)).rejects.toMatchObject({ code: 'actor_owner_conflict' });
    expect(executeChildAgents).toHaveBeenCalledTimes(1);
    await first.close();
    await expect(contender.runs.get(run.runId)).resolves.toMatchObject({ phase: 'recovering', contextRecovery: { checkpoint } });
    await expect(contender.agents.output(session.id, turn.actorPath, turn.turnId)).resolves.toMatchObject({ state: 'running' });
    vi.mocked(executeChildAgents).mockImplementationOnce(async (bundles, _context, options) => {
      expect(options.generationCheckpoint).toEqual(checkpoint);
      expect(options.actorTurnId).toBe(turn.turnId);
      return childResult(bundles[0]!.id);
    });
    const resumed = await contender.agents.followup(session.id, turn.actorPath, '', { ...authority, resumeCheckpoint: true });
    expect(resumed.turn.turnId).toBe(turn.turnId);
    await awaitCompleted(contender, session.id, turn, signal);
    const final = await contender.runs.get(run.runId);
    lastEvidence = JSON.stringify({ final, output: await contender.agents.output(session.id, turn.actorPath, turn.turnId) });
    expect(final, lastEvidence).toMatchObject({ phase: 'completed', terminal: { kind: 'completed' } });
    expect(executeChildAgents).toHaveBeenCalledTimes(2);
  } finally {
    vi.restoreAllMocks();
    await first.close();
    await contender?.close();
    vi.mocked(executeChildAgents).mockReset();
    if (dirname(homeDir) !== temporaryRoot) throw new Error('Refusing to remove a fixture outside its temporary root.');
    await rm(homeDir, { recursive: true, force: true });
  }
}, 30_000);
