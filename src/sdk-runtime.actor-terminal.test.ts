import fsPromises, { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';

import { setKodaXDiagnosticSink, type AgentActorSaveAttempt, type AgentTurnRef } from '@kodax-ai/agent';
import { FileSessionStorage } from '@kodax-ai/repl';
import { executeChildAgents } from '../packages/coding/src/child-executor.js';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';

vi.mock('../packages/coding/src/child-executor.js', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/coding/src/child-executor.js')>(),
  executeChildAgents: vi.fn(),
}));

function deferred() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

for (const scenario of ['completed', 'failed', 'iteration-limit'] as const) {
it(`publishes an independent Run terminal only after its exact Actor terminal is durable (${scenario})`, async ({ signal, onTestFailed }) => {
  const expectedState = scenario === 'completed' ? 'completed' : 'failed';
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-terminal-'));
  const executionEntered = deferred();
  const executionGate = deferred();
  const renameEntered = deferred();
  const terminalGate = deferred();
  const releaseGates = () => {
    executionEntered.resolve();
    executionGate.resolve();
    renameEntered.resolve();
    terminalGate.resolve();
  };
  signal.addEventListener('abort', releaseGates, { once: true });
  const diagnostics: Array<{ level: string; message: string }> = [];
  const restoreDiagnostics = setKodaXDiagnosticSink(diagnostic => {
    if (diagnostic.source === 'coding:actors' && diagnostics.length < 16) {
      diagnostics.push({ level: diagnostic.level, message: diagnostic.message.slice(0, 512) });
    }
  });
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  let restarted: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
  let terminalAttempt: AgentActorSaveAttempt | undefined;
  let stage = 'starting executor';
  let lastEvidence = '';
  let executorCalls = 0;
  onTestFailed(() => {
    process.stderr.write(`[Actor terminal diagnostics] ${JSON.stringify({ scenario, stage, lastEvidence,
      save: terminalAttempt?.diagnostics(), executorCalls, diagnostics })}\n`);
  });
  try {
    vi.mocked(executeChildAgents).mockImplementation(async bundles => {
      executorCalls += 1;
      executionEntered.resolve();
      await executionGate.promise;
      if (scenario === 'failed') throw new Error('Fixture independent Actor executor failed.');
      return {
        results: [{ childId: bundles[0]!.id, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid',
          summary: 'Verified EDIT019 without repetition.', evidenceRefs: [], contradictions: [],
          ...(scenario === 'iteration-limit' ? { limitReached: true, actualIterations: 200 } : {}) }],
        mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [],
      };
    });
    const session = await runtime.sessions.create({ title: 'Independent Actor canonical terminal gate' });
    const authority = {
      origin: { principalId: 'terminal-client', clientName: 'test' },
      providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'fixture-only' }),
      tools: ['read'],
      authorization: undefined,
    };
    const turn = await runtime.agents.spawn(session.id, {
      taskName: 'worker', objective: 'Verify EDIT019 without repeating its completed edit.',
    }, authority);
    await executionEntered.promise;
    signal.throwIfAborted();
    // Obtain the exact Run before holding any Session storage operation.
    const run = (await runtime.runs.list({ sessionId: session.id })).find(value => value.turnId === turn.turnId);
    if (!run) throw new Error('Worker dispatched without its exact Runtime Run.');
    let resultSettled = false;
    const publicResult = runtime.runs.await(run.runId).then(
      value => { resultSettled = true; return { kind: 'result' as const, value }; },
      (error: unknown) => { resultSettled = true; return { kind: 'error' as const, error }; },
    );
    await runtime.runs.get(run.runId);
    let terminalWriteArmed = false;
    const beginSave = FileSessionStorage.prototype.beginActorSnapshotSave;
    vi.spyOn(FileSessionStorage.prototype, 'beginActorSnapshotSave').mockImplementation(function (
      this: FileSessionStorage, id, snapshot, expectedRevision,
    ) {
      const exactTerminal = id === session.id && snapshot.turns.some(value =>
        value.actorPath === turn.actorPath && value.turnId === turn.turnId && value.state === expectedState);
      if (exactTerminal) terminalWriteArmed = true;
      const attempt = beginSave.call(this, id, snapshot, expectedRevision);
      if (exactTerminal) terminalAttempt = attempt;
      return attempt;
    });
    const rename = fsPromises.rename;
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (source, destination) => {
      if (terminalWriteArmed && String(destination).endsWith(`${session.id}.jsonl`)) {
        terminalWriteArmed = false;
        renameEntered.resolve();
        await terminalGate.promise;
      }
      return rename(source, destination);
    });
    stage = 'waiting for exact terminal rename';
    executionGate.resolve();
    await renameEntered.promise;
    signal.throwIfAborted();
    stage = 'reading canonical-precommit observations';
    const pendingOutput = await runtime.agents.output(session.id, turn.actorPath, turn.turnId);
    const pendingRun = await runtime.runs.get(run.runId);
    const pendingEvidence = JSON.stringify({ output: pendingOutput, phase: pendingRun.phase,
      save: terminalAttempt?.diagnostics(), executorCalls: vi.mocked(executeChildAgents).mock.calls.length, diagnostics });
    lastEvidence = pendingEvidence;
    expect(terminalAttempt?.phase(), pendingEvidence).toBe('commit_inflight');
    expect(pendingOutput.state, pendingEvidence).toBe('running');
    expect(['completed', 'failed', 'cancelled', 'interrupted'], pendingEvidence).not.toContain(pendingRun.phase);
    expect(pendingRun, pendingEvidence).not.toHaveProperty('terminal');
    expect(resultSettled, pendingEvidence).toBe(false);

    stage = 'waiting for canonical Actor and Run terminals';
    terminalGate.resolve();
    let cursor = 0;
    for (;;) {
      signal.throwIfAborted();
      const output = await runtime.agents.output(session.id, turn.actorPath, turn.turnId);
      const status = await runtime.runs.get(run.runId);
      const evidence = JSON.stringify({ output, phase: status.phase, save: terminalAttempt?.diagnostics(),
        executorCalls: vi.mocked(executeChildAgents).mock.calls.length, diagnostics });
      lastEvidence = evidence;
      if (output.state !== 'accepted' && output.state !== 'running') {
        expect(output.state, evidence).toBe(expectedState);
        if (scenario === 'iteration-limit') expect(output.terminationReason, evidence).toBe('iteration_limit');
        if (['completed', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(status.phase)) {
          expect(status.phase, evidence).toBe(expectedState);
          expect(status.terminal?.kind, evidence).toBe(expectedState);
          break;
        }
      }
      const event = await runtime.agents.wait(session.id, cursor, 100, { signal });
      if (event) cursor = event.sequence;
    }
    stage = 'awaiting the public durable Run result';
    const settled = await publicResult;
    if (settled.kind === 'error') throw settled.error;
    expect(settled.value).toMatchObject({ phase: expectedState, terminal: { kind: expectedState } });
    expect(executeChildAgents).toHaveBeenCalledTimes(1);
    stage = 'restarting after durable terminal';
    await runtime.close();
    restarted = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
    await expect(restarted.runs.get(run.runId)).resolves.toMatchObject({ phase: expectedState, terminal: { kind: expectedState } });
    await expect(restarted.agents.output(session.id, turn.actorPath, turn.turnId)).resolves.toMatchObject({ state: expectedState });
    expect(executeChildAgents).toHaveBeenCalledTimes(1);
  } finally {
    releaseGates();
    await restarted?.close();
    await runtime.close();
    signal.removeEventListener('abort', releaseGates);
    restoreDiagnostics();
    vi.restoreAllMocks();
    vi.mocked(executeChildAgents).mockReset();
    if (dirname(homeDir) !== temporaryRoot) throw new Error('Refusing to remove a fixture outside its temporary root.');
    await rm(homeDir, { recursive: true, force: true });
  }
}, 30_000);
}

it('settles only the bound Turn while its child and an unrelated independent Actor remain active', async ({ signal, onTestFailed }) => {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-terminal-scope-'));
  const peerEntered = deferred();
  const childEntered = deferred();
  const peerGate = deferred();
  const childGate = deferred();
  const releaseGates = () => {
    peerEntered.resolve(); childEntered.resolve(); peerGate.resolve(); childGate.resolve();
  };
  signal.addEventListener('abort', releaseGates, { once: true });
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  let child: AgentTurnRef | undefined;
  let lastEvidence = '';
  const diagnostics: Array<{ level: string; message: string }> = [];
  const restoreDiagnostics = setKodaXDiagnosticSink(diagnostic => {
    if (diagnostic.source === 'coding:actors' && diagnostics.length < 16) {
      diagnostics.push({ level: diagnostic.level, message: diagnostic.message.slice(0, 512) });
    }
  });
  onTestFailed(() => {
    process.stderr.write(`[Actor terminal scope diagnostics] ${JSON.stringify({ lastEvidence, diagnostics })}\n`);
  });
  try {
    vi.mocked(executeChildAgents).mockImplementation(async (bundles, _context, options) => {
      const actor = options.actorControl!;
      if (actor.callerPath === '/root/peer') {
        peerEntered.resolve();
        await peerGate.promise;
      } else if (actor.callerPath === '/root/parent/child') {
        childEntered.resolve();
        await childGate.promise;
      } else if (actor.callerPath === '/root/parent') {
        child = await actor.spawn({ taskName: 'child', objective: 'Continue independent evidence collection.' });
      } else throw new Error(`Unexpected fixture Actor ${actor.callerPath}`);
      return {
        results: [{ childId: bundles[0]!.id, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid',
          summary: actor.callerPath === '/root/parent' ? 'Parent complete; /root/parent/child intentionally remains active.' : 'Evidence complete.',
          evidenceRefs: [], contradictions: [] }],
        mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [],
      };
    });
    const session = await runtime.sessions.create({ title: 'Exact Turn terminal scope' });
    const authority = {
      origin: { principalId: 'scope-client', clientName: 'test' },
      providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'fixture-only' }),
      tools: ['read'], authorization: undefined,
    };
    const peer = await runtime.agents.spawn(session.id, { taskName: 'peer', objective: 'Keep working independently.' }, authority);
    await peerEntered.promise;
    signal.throwIfAborted();
    const parent = await runtime.agents.spawn(session.id, { taskName: 'parent', objective: 'Report the intentionally active child.' }, authority);
    await childEntered.promise;
    signal.throwIfAborted();
    let cursor = 0;
    for (;;) {
      signal.throwIfAborted();
      const output = await runtime.agents.output(session.id, parent.actorPath, parent.turnId);
      lastEvidence = JSON.stringify({ parent: output, tree: await runtime.agents.tree(session.id) });
      if (output.state !== 'accepted' && output.state !== 'running') {
        expect(output.state, lastEvidence).toBe('completed');
        break;
      }
      const event = await runtime.agents.wait(session.id, cursor, 100, { signal });
      if (event) cursor = event.sequence;
    }
    const run = (await runtime.runs.list({ sessionId: session.id })).find(value => value.turnId === parent.turnId);
    if (!run || !child) throw new Error('Scope fixture has no exact parent Run or child Turn.');
    await expect(runtime.runs.await(run.runId)).resolves.toMatchObject({ phase: 'completed', terminal: { kind: 'completed' } });
    await expect(runtime.agents.output(session.id, peer.actorPath, peer.turnId)).resolves.toMatchObject({ state: 'running' });
    await expect(runtime.agents.output(session.id, child.actorPath, child.turnId)).resolves.toMatchObject({ state: 'running' });
    expect(executeChildAgents).toHaveBeenCalledTimes(3);
  } finally {
    releaseGates();
    await runtime.close();
    signal.removeEventListener('abort', releaseGates);
    restoreDiagnostics();
    vi.restoreAllMocks();
    vi.mocked(executeChildAgents).mockReset();
    if (dirname(homeDir) !== temporaryRoot) throw new Error('Refusing to remove a fixture outside its temporary root.');
    await rm(homeDir, { recursive: true, force: true });
  }
}, 30_000);
