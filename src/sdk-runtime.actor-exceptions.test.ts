import fsPromises, { mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';

import { createSessionLineage, setKodaXDiagnosticSink } from '@kodax-ai/agent';
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

it('preserves an independent Actor checkpoint on graceful close while an unrelated Actor is active', async ({ signal, onTestFailed }) => {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-close-scope-'));
  const checkpointEntered = deferred();
  const peerEntered = deferred();
  const peerExecution = deferred();
  signal.addEventListener('abort', peerExecution.release, { once: true });
  const first = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  let restarted: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
  let lastEvidence = '';
  onTestFailed(() => { process.stderr.write(`Independent Actor checkpoint close evidence: ${lastEvidence}\n`); });
  try {
    vi.mocked(executeChildAgents).mockImplementation(async (bundles, _context, options) => {
      if (options.actorControl?.callerPath === '/root/checkpoint') {
        const messages = [{ role: 'user' as const, content: 'EDIT019 is complete. Preserve the verified generation boundary.' }];
        const lineage = createSessionLineage(messages);
        const workerId = 'independent-close-checkpoint-worker';
        await options.historyStorage!.save(workerId, { messages, lineage, gitRoot: homeDir, title: 'Checkpoint worker', scope: 'managed-task-worker' });
        const checkpoint = { version: 1 as const, sessionId: workerId, activeEntryId: lineage.activeEntryId,
          messagesDigest: createHash('sha256').update(JSON.stringify(messages)).digest('hex') };
        checkpointEntered.release();
        await options.parentOptions!.events!.onContextCapacityBlocked!({ checkpoint }, options.abortSignal,
          { childAgentId: options.actorControl.callerPath, turnId: options.actorTurnId });
        throw new Error('The original checkpoint executor must remain suspended.');
      }
      if (options.actorControl?.callerPath !== '/root/peer') throw new Error('Unexpected checkpoint fixture Actor.');
      options.abortSignal?.addEventListener('abort', peerExecution.release, { once: true });
      peerEntered.release();
      await peerExecution.promise;
      return { results: [{ childId: bundles[0]!.id, fanoutClass: 'evidence-scan', status: 'completed',
        disposition: 'valid', summary: 'Peer executor stopped.', evidenceRefs: [], contradictions: [] }],
      mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [] };
    });
    const session = await first.sessions.create({ title: 'Independent checkpoint close scope' });
    const authority = { origin: { principalId: 'close-scope-client', clientName: 'test' },
      providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'fixture-only' }),
      tools: ['read'], authorization: undefined };
    const checkpointTurn = await first.agents.spawn(session.id, { taskName: 'checkpoint', objective: 'Keep the safe generation checkpoint.' }, authority);
    await checkpointEntered.promise;
    let cursor = 0;
    let checkpointRun: Awaited<ReturnType<typeof first.runs.get>> | undefined;
    for (;;) {
      signal.throwIfAborted();
      const detail = await first.agents.detail(session.id, checkpointTurn.actorPath);
      checkpointRun = (await first.runs.list({ sessionId: session.id })).find(value => value.turnId === checkpointTurn.turnId);
      lastEvidence = JSON.stringify({ checkpoint: detail.turns.find(value => value.turnId === checkpointTurn.turnId), run: checkpointRun });
      if (detail.turns.find(value => value.turnId === checkpointTurn.turnId)?.checkpoint && checkpointRun?.contextRecovery?.checkpoint
        && checkpointRun.phase === 'recovering') break;
      const event = await first.agents.wait(session.id, cursor, 100, { signal });
      if (event) cursor = event.sequence;
    }
    const peer = await first.agents.spawn(session.id, { taskName: 'peer', objective: 'Stay active without a generation checkpoint.' }, authority);
    await peerEntered.promise;
    await expect(first.agents.output(session.id, peer.actorPath, peer.turnId)).resolves.toMatchObject({ state: 'running' });
    const expectedCheckpoint = checkpointRun.contextRecovery?.checkpoint;
    if (!expectedCheckpoint) throw new Error('Checkpoint close fixture lost its verified recovery boundary.');
    await first.close();
    restarted = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
    const recovered = await restarted.runs.get(checkpointRun.runId);
    lastEvidence = JSON.stringify({ recovered, output: await restarted.agents.output(session.id, checkpointTurn.actorPath, checkpointTurn.turnId) });
    expect(recovered, lastEvidence).toMatchObject({ phase: 'recovering', contextRecovery: { checkpoint: expectedCheckpoint } });
    expect(recovered, lastEvidence).not.toHaveProperty('stop');
    expect(recovered, lastEvidence).not.toHaveProperty('terminal');
    await expect(restarted.agents.output(session.id, checkpointTurn.actorPath, checkpointTurn.turnId)).resolves.toMatchObject({ state: 'running' });
    expect(executeChildAgents).toHaveBeenCalledTimes(2);
  } finally {
    peerExecution.release();
    await restarted?.close();
    await first.close();
    signal.removeEventListener('abort', peerExecution.release);
    vi.restoreAllMocks();
    vi.mocked(executeChildAgents).mockReset();
    if (dirname(homeDir) !== temporaryRoot) throw new Error('Refusing to remove a fixture outside its temporary root.');
    await rm(homeDir, { recursive: true, force: true });
  }
}, 30_000);

it('keeps a temporary Session after an independent Actor finishes', async ({ signal }) => {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-temporary-'));
  const dispatched = deferred();
  const execution = deferred();
  signal.addEventListener('abort', execution.release, { once: true });
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  try {
    vi.mocked(executeChildAgents).mockImplementation(async bundles => {
      dispatched.release();
      await execution.promise;
      return { results: [{ childId: bundles[0]!.id, fanoutClass: 'evidence-scan', status: 'completed',
        disposition: 'valid', summary: 'Independent work completed.', evidenceRefs: [], contradictions: [] }],
      mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [] };
    });
    const session = await runtime.sessions.create({ title: 'Temporary Session owned by its caller', temporary: true });
    const authority = {
      origin: { principalId: 'temporary-client', clientName: 'test' },
      providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'fixture-only' }),
      tools: ['read'],
      authorization: undefined,
    };
    const turn = await runtime.agents.spawn(session.id, { taskName: 'worker', objective: 'Finish independent work.' }, authority);
    await dispatched.promise;
    const run = (await runtime.runs.list({ sessionId: session.id })).find(value => value.turnId === turn.turnId);
    if (!run) throw new Error('Independent Actor did not publish its exact Run.');
    const result = runtime.runs.await(run.runId);
    execution.release();
    await expect(result).resolves.toMatchObject({ phase: 'completed' });
    await expect(runtime.sessions.load(session.id)).resolves.toMatchObject({ id: session.id });
    await expect(runtime.agents.output(session.id, turn.actorPath, turn.turnId)).resolves.toMatchObject({ state: 'completed' });
  } finally {
    execution.release();
    await runtime.close();
    signal.removeEventListener('abort', execution.release);
    vi.restoreAllMocks();
    vi.mocked(executeChildAgents).mockReset();
    if (dirname(homeDir) !== temporaryRoot) throw new Error('Refusing to remove a fixture outside its temporary root.');
    await rm(homeDir, { recursive: true, force: true });
  }
}, 30_000);

it('settles a canonical independent Actor after its blocking Shell cleanup is released', async ({ signal, onTestFailed }) => {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-cleanup-settlement-'));
  const dispatched = deferred();
  const execution = deferred();
  signal.addEventListener('abort', execution.release, { once: true });
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  const diagnostics: string[] = [];
  const restoreDiagnostics = setKodaXDiagnosticSink(diagnostic => {
    if (diagnostics.length < 16) diagnostics.push(`${diagnostic.source}: ${diagnostic.message}`.slice(0, 512));
  });
  let lastEvidence = '';
  onTestFailed(() => { process.stderr.write(`Independent Actor cleanup evidence: ${JSON.stringify({ lastEvidence, diagnostics })}\n`); });
  let releaseCleanup: (() => void) | undefined;
  try {
    const session = await runtime.sessions.create({ title: 'Independent Actor cleanup settlement' });
    vi.mocked(executeChildAgents).mockImplementation(async (bundles, _context, options) => {
      const run = (await runtime.runs.list({ sessionId: session.id })).find(value => value.turnId === options.actorTurnId);
      if (!run || !options.parentOptions?.events?.registerShellCleanup) throw new Error('Actor has no admitted Shell cleanup route.');
      releaseCleanup = options.parentOptions.events.registerShellCleanup({ runtimeRunId: run.runId,
        pid: 12345, registrationId: randomUUID() }, async () => { releaseCleanup?.(); });
      dispatched.release();
      await execution.promise;
      return { results: [{ childId: bundles[0]!.id, fanoutClass: 'evidence-scan', status: 'completed',
        disposition: 'valid', summary: 'Canonical result waits for its admitted Shell cleanup.', evidenceRefs: [], contradictions: [] }],
      mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [] };
    });
    const authority = { origin: { principalId: 'cleanup-client', clientName: 'test' },
      providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'fixture-only' }),
      tools: ['read'], authorization: undefined };
    const turn = await runtime.agents.spawn(session.id, { taskName: 'worker', objective: 'Retain the blocking cleanup fence.' }, authority);
    await dispatched.promise;
    const run = (await runtime.runs.list({ sessionId: session.id })).find(value => value.turnId === turn.turnId);
    if (!run || !releaseCleanup) throw new Error('Cleanup fixture did not publish its exact Run and cleanup release.');
    let resultSettled = false;
    const result = runtime.runs.await(run.runId).then(value => { resultSettled = true; return value; });
    execution.release();
    let cursor = 0;
    for (;;) {
      signal.throwIfAborted();
      const output = await runtime.agents.output(session.id, turn.actorPath, turn.turnId);
      if (output.state !== 'accepted' && output.state !== 'running') {
        expect(output.state).toBe('completed');
        break;
      }
      const event = await runtime.agents.wait(session.id, cursor, 100, { signal });
      if (event) cursor = event.sequence;
    }
    const blocked = await runtime.runs.get(run.runId);
    lastEvidence = JSON.stringify({ blocked, resultSettled });
    expect(blocked).toMatchObject({ phase: 'unknown' });
    expect(resultSettled).toBe(false);
    releaseCleanup();
    await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({ phase: 'completed', terminal: { kind: 'completed' } });
    await expect(result).resolves.toMatchObject({ phase: 'completed', terminal: { kind: 'completed' } });
    expect(executeChildAgents).toHaveBeenCalledTimes(1);
  } finally {
    execution.release();
    releaseCleanup?.();
    await runtime.close();
    restoreDiagnostics();
    signal.removeEventListener('abort', execution.release);
    vi.restoreAllMocks();
    vi.mocked(executeChildAgents).mockReset();
    if (dirname(homeDir) !== temporaryRoot) throw new Error('Refusing to remove a fixture outside its temporary root.');
    await rm(homeDir, { recursive: true, force: true });
  }
}, 30_000);

for (const notificationFailure of [false, true]) {
  it(`settles and repairs an independent Actor unknown without a terminal event (notification failure: ${notificationFailure})`, async ({ signal, onTestFailed }) => {
    const temporaryRoot = resolve(tmpdir());
    const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-unknown-'));
    const dispatched = deferred();
    const execution = deferred();
    const renameEntered = deferred();
    const terminalCommit = deferred();
    const unknownObserved = deferred();
    const peerEntered = deferred();
    const peerExecution = deferred();
    const releaseGates = () => { execution.release(); terminalCommit.release(); peerExecution.release(); };
    signal.addEventListener('abort', releaseGates, { once: true });
    const diagnostics: string[] = [];
    let stage = 'starting';
    onTestFailed(() => {
      process.stderr.write(`Independent Actor exception evidence: ${JSON.stringify({ stage, diagnostics })}\n`);
    });
    const restoreDiagnostics = setKodaXDiagnosticSink(diagnostic => {
      if (diagnostics.length < 24) diagnostics.push(`${diagnostic.source}: ${diagnostic.message}`.slice(0, 512));
    });
    const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
    let subscription: ReturnType<typeof runtime.events.subscribe> | undefined;
    try {
      vi.mocked(executeChildAgents).mockImplementation(async (bundles, _context, options) => {
        if (options.actorControl?.callerPath === '/root/unknown-peer') {
          peerEntered.release();
          await peerExecution.promise;
        } else {
          dispatched.release();
          await execution.promise;
        }
        return { results: [{ childId: bundles[0]!.id, fanoutClass: 'evidence-scan', status: 'completed',
          disposition: 'valid', summary: 'Executor completed before uncertain persistence.', evidenceRefs: [], contradictions: [] }],
        mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [] };
      });
      const session = await runtime.sessions.create({ title: 'Independent Actor unknown repair' });
      const authority = {
        origin: { principalId: 'unknown-client', clientName: 'test' },
        providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'fixture-only' }),
        tools: ['read'],
        authorization: undefined,
      };
      const turn = await runtime.agents.spawn(session.id, { taskName: 'worker', objective: 'Keep the canonical outcome uncertain.' }, authority);
      await dispatched.promise;
      stage = 'dispatched';
      const peer = notificationFailure ? undefined : await runtime.agents.spawn(session.id,
        { taskName: 'unknown-peer', objective: 'Keep the executor pending while shared storage becomes unknown.' }, authority);
      if (peer) await peerEntered.promise;
      const run = (await runtime.runs.list({ sessionId: session.id })).find(value => value.turnId === turn.turnId);
      if (!run) throw new Error('Independent Actor did not publish its exact Run.');
      const peerRun = peer ? (await runtime.runs.list({ sessionId: session.id })).find(value => value.turnId === peer.turnId) : undefined;
      if (peer && !peerRun) throw new Error('Unknown peer Actor did not publish its exact Run.');
      let result: Awaited<ReturnType<typeof runtime.runs.await>> | undefined;
      void runtime.runs.await(run.runId).then(value => { result = value; });
      let peerResult: Awaited<ReturnType<typeof runtime.runs.await>> | undefined;
      if (peerRun) void runtime.runs.await(peerRun.runId).then(value => { peerResult = value; });
      const events: string[] = [];
      subscription = runtime.events.subscribe({ sessionId: session.id, runId: run.runId }, event => {
        events.push(event.type);
        if (event.type === 'run.updated'
          && typeof event.payload === 'object' && event.payload !== null && 'phase' in event.payload
          && event.payload.phase === 'unknown') {
          unknownObserved.release();
          if (notificationFailure) throw new Error('Fixture unknown notification failure.');
        }
      });
      let publicationRejected = false;
      if (notificationFailure) {
        const stringify = JSON.stringify;
        vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...args: unknown[]) => {
          // Fail the unknown event payload once; durable status envelopes remain writable.
          if (!publicationRejected && typeof value === 'object' && value !== null
            && 'runId' in value && value.runId === run.runId && 'phase' in value && value.phase === 'unknown'
            && !('_runtime' in value)) {
            publicationRejected = true;
            unknownObserved.release();
            throw new Error('Fixture unknown event serialization failure.');
          }
          return Reflect.apply(stringify, JSON, [value, ...args]) as string | undefined;
        }) as typeof JSON.stringify);
      }
      let holdRename = false;
      const beginSave = FileSessionStorage.prototype.beginActorSnapshotSave;
      vi.spyOn(FileSessionStorage.prototype, 'beginActorSnapshotSave').mockImplementation(function (
        this: FileSessionStorage, id, snapshot, expectedRevision,
      ) {
        if (id === session.id && snapshot.turns.some(value => value.turnId === turn.turnId && value.state === 'completed')) holdRename = true;
        return beginSave.call(this, id, snapshot, expectedRevision);
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
      execution.release();
      await renameEntered.promise;
      stage = 'terminal rename entered';
      await unknownObserved.promise;
      stage = 'unknown observed';
      expect(events, diagnostics.join('\n')).not.toContain('run.completed');
      await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({ phase: 'unknown' });
      expect(result, diagnostics.join('\n')).toMatchObject({ phase: 'unknown' });
      if (peerRun) expect(peerResult, diagnostics.join('\n')).toMatchObject({ phase: 'unknown' });
      if (notificationFailure) expect(publicationRejected).toBe(true);
      await expect(runtime.agents.output(session.id, turn.actorPath, turn.turnId)).resolves.toMatchObject({ state: 'running' });
      await expect(runtime.runs.start({ sessionId: session.id, prompt: 'Must remain behind the unknown Actor fence.' }))
        .rejects.toMatchObject({ code: 'actor_settlement_not_persisted' });

      terminalCommit.release();
      stage = 'awaiting canonical repair';
      let cursor = 0;
      for (;;) {
        signal.throwIfAborted();
        const output = await runtime.agents.output(session.id, turn.actorPath, turn.turnId);
        if (output.state !== 'accepted' && output.state !== 'running') {
          const status = await runtime.runs.get(run.runId);
          expect(status.phase, diagnostics.join('\n')).toBe('completed');
          expect(output.state, diagnostics.join('\n')).toBe('completed');
          stage = 'repaired';
          break;
        }
        const event = await runtime.agents.wait(session.id, cursor, 100, { signal });
        if (event) cursor = event.sequence;
      }
      if (peer && peerRun) {
        await expect(runtime.agents.output(session.id, peer.actorPath, peer.turnId)).resolves.toMatchObject({ state: 'interrupted' });
        await expect(runtime.runs.get(peerRun.runId)).resolves.toMatchObject({ phase: 'interrupted', terminal: { kind: 'interrupted' } });
      }
      expect(executeChildAgents).toHaveBeenCalledTimes(peer ? 2 : 1);
    } finally {
      releaseGates();
      subscription?.close();
      vi.restoreAllMocks();
      await runtime.close().catch(error => {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'actor_shutdown_not_persisted') throw error;
      });
      restoreDiagnostics();
      signal.removeEventListener('abort', releaseGates);
      vi.mocked(executeChildAgents).mockReset();
      if (dirname(homeDir) !== temporaryRoot) throw new Error('Refusing to remove a fixture outside its temporary root.');
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 30_000);
}
