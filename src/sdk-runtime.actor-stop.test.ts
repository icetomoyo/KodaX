import fs from 'node:fs';
import fsPromises, { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { expect, it, vi } from 'vitest';

import { setKodaXDiagnosticSink, type AgentActorSaveAttempt } from '@kodax-ai/agent';
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

async function waitForReleaseOrAbort(release: Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  let rejectAbort: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new DOMException('Fixture Actor was cancelled.', 'AbortError'));
    signal?.addEventListener('abort', rejectAbort, { once: true });
  });
  try { await Promise.race([release, abort]); }
  finally { if (rejectAbort) signal?.removeEventListener('abort', rejectAbort); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

it('does not overwrite a replacement Run owner when its original Actor commits', async ({ signal, onTestFailed }) => {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-live-owner-'));
  const executionEntered = deferred();
  const executionGate = deferred();
  const renameEntered = deferred();
  const terminalGate = deferred();
  const releaseGates = () => {
    executionEntered.resolve(); executionGate.resolve(); renameEntered.resolve(); terminalGate.resolve();
  };
  signal.addEventListener('abort', releaseGates, { once: true });
  const diagnostics: Array<{ source: string; message: string }> = [];
  const restoreDiagnostics = setKodaXDiagnosticSink(diagnostic => {
    if ((diagnostic.source === 'coding:actors' || diagnostic.source.startsWith('runtime.')) && diagnostics.length < 16) {
      diagnostics.push({ source: diagnostic.source, message: diagnostic.message.slice(0, 512) });
    }
  });
  let stage = 'starting the original owner';
  let terminalAttempt: AgentActorSaveAttempt | undefined;
  let lastEvidence = '';
  onTestFailed(() => {
    process.stderr.write(`[Independent Actor live owner diagnostics] ${JSON.stringify({ stage, lastEvidence,
      save: terminalAttempt?.diagnostics(), diagnostics })}\n`);
  });
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  try {
    vi.mocked(executeChildAgents).mockImplementation(async bundles => {
      executionEntered.resolve();
      await executionGate.promise;
      return {
        results: [{ childId: bundles[0]!.id, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid',
          summary: 'Canonical completion belongs to the original Turn.', evidenceRefs: [], contradictions: [] }],
        mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [],
      };
    });
    const session = await runtime.sessions.create({ title: 'Live independent Run owner replacement' });
    const authority = {
      origin: { principalId: 'live-owner-client', clientName: 'test' },
      providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'fixture-only' }),
      tools: ['read'], authorization: undefined,
    };
    const turn = await runtime.agents.spawn(session.id, { taskName: 'worker', objective: 'Complete without overwriting another owner.' }, authority);
    await executionEntered.promise;
    signal.throwIfAborted();
    const run = (await runtime.runs.list({ sessionId: session.id })).find(value => value.turnId === turn.turnId);
    if (!run) throw new Error('Live owner fixture has no exact independent Run.');
    const publicResult = runtime.runs.await(run.runId);
    const beginSave = FileSessionStorage.prototype.beginActorSnapshotSave;
    let terminalWriteArmed = false;
    vi.spyOn(FileSessionStorage.prototype, 'beginActorSnapshotSave').mockImplementation(function (
      this: FileSessionStorage, id, snapshot, expectedRevision,
    ) {
      const terminal = id === session.id && snapshot.turns.some(value => value.actorPath === turn.actorPath
        && value.turnId === turn.turnId && value.state === 'completed');
      if (terminal) terminalWriteArmed = true;
      const attempt = beginSave.call(this, id, snapshot, expectedRevision);
      if (terminal) terminalAttempt = attempt;
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
    executionGate.resolve();
    await renameEntered.promise;
    signal.throwIfAborted();
    expect(terminalAttempt?.phase()).toBe('commit_inflight');
    stage = 'replacing the Run owner before Actor terminal commit';
    const statusFile = join(homeDir, '.kodax', 'runtime', 'runs', encodeURIComponent(run.runId), 'status.json');
    const persisted: unknown = JSON.parse(await readFile(statusFile, 'utf8'));
    if (!isRecord(persisted) || !isRecord(persisted._runtime) || typeof persisted._runtime.revision !== 'number') {
      throw new Error('Live owner fixture has no durable Run revision.');
    }
    const replacement = JSON.stringify({ ...persisted, _runtime: { ...persisted._runtime,
      revision: persisted._runtime.revision + 1,
      owner: { ownerId: 'replacement-owner', runtimeId: 'replacement-runtime', pid: process.pid, startedAt: run.startedAt },
    } });
    await writeFile(statusFile, replacement);
    terminalGate.resolve();
    stage = 'awaiting the original owner settlement';
    const result = await publicResult;
    const output = await runtime.agents.output(session.id, turn.actorPath, turn.turnId);
    lastEvidence = JSON.stringify({ result, output });
    expect(result.phase, lastEvidence).toBe('unknown');
    expect(result, lastEvidence).not.toHaveProperty('terminal');
    expect(output.state, lastEvidence).toBe('completed');
    expect(await readFile(statusFile, 'utf8')).toBe(replacement);
    expect(executeChildAgents).toHaveBeenCalledTimes(1);
    stage = 'closing the original Host';
    await runtime.close();
    expect(await readFile(statusFile, 'utf8')).toBe(replacement);
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

it('lets Stop win a pending independent Actor without interrupting its unrelated peer', async ({ signal, onTestFailed }) => {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-stop-first-'));
  const targetEntered = deferred();
  const peerEntered = deferred();
  const targetGate = deferred();
  const peerGate = deferred();
  const releaseGates = () => {
    targetEntered.resolve(); peerEntered.resolve(); targetGate.resolve(); peerGate.resolve();
  };
  signal.addEventListener('abort', releaseGates, { once: true });
  const diagnostics: Array<{ level: string; message: string }> = [];
  const restoreDiagnostics = setKodaXDiagnosticSink(diagnostic => {
    if (diagnostic.source === 'coding:actors' && diagnostics.length < 16) {
      diagnostics.push({ level: diagnostic.level, message: diagnostic.message.slice(0, 512) });
    }
  });
  let stage = 'starting Actors';
  let lastEvidence = '';
  onTestFailed(() => {
    process.stderr.write(`[Independent Actor Stop diagnostics] ${JSON.stringify({ stage, lastEvidence, diagnostics })}\n`);
  });
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  try {
    vi.mocked(executeChildAgents).mockImplementation(async (bundles, _context, options) => {
      const path = options.actorControl!.callerPath;
      if (path === '/root/target') {
        targetEntered.resolve();
        await waitForReleaseOrAbort(targetGate.promise, options.abortSignal);
      } else if (path === '/root/peer') {
        peerEntered.resolve();
        await waitForReleaseOrAbort(peerGate.promise, options.abortSignal);
      } else throw new Error(`Unexpected fixture Actor ${path}`);
      return {
        results: [{ childId: bundles[0]!.id, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid',
          summary: 'Fixture evidence complete.', evidenceRefs: [], contradictions: [] }],
        mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [],
      };
    });
    const session = await runtime.sessions.create({ title: 'Independent Actor Stop isolation' });
    const authority = {
      origin: { principalId: 'stop-client', clientName: 'test' },
      providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'fixture-only' }),
      tools: ['read'], authorization: undefined,
    };
    const target = await runtime.agents.spawn(session.id, { taskName: 'target', objective: 'Wait for the accepted Stop.' }, authority);
    await targetEntered.promise;
    signal.throwIfAborted();
    const peerAuthority = {
      ...authority, origin: { principalId: 'peer-client', clientName: 'test' },
    };
    const peer = await runtime.agents.spawn(session.id, { taskName: 'peer', objective: 'Keep working for another client.' }, peerAuthority);
    await peerEntered.promise;
    signal.throwIfAborted();
    const run = (await runtime.runs.list({ sessionId: session.id })).find(value => value.turnId === target.turnId);
    if (!run) throw new Error('Stop fixture has no exact independent Run.');
    stage = 'requesting Stop';
    const receipt = await runtime.runs.abort(run.runId);
    expect(receipt).toMatchObject({ accepted: true });
    stage = 'awaiting durable cancelled result';
    const result = await runtime.runs.await(run.runId);
    const targetOutput = await runtime.agents.output(session.id, target.actorPath, target.turnId);
    const peerOutput = await runtime.agents.output(session.id, peer.actorPath, peer.turnId);
    const status = await runtime.runs.get(run.runId);
    lastEvidence = JSON.stringify({ receipt, result, targetOutput, peerOutput, status });
    expect(peerOutput.state, lastEvidence).toBe('running');
    expect(result.phase, lastEvidence).toBe('cancelled');
    expect(targetOutput.state, lastEvidence).toBe('interrupted');
    expect(status, lastEvidence).toMatchObject({ phase: 'cancelled', terminal: { kind: 'cancelled' },
      stop: { state: 'confirmed', outcome: 'cancelled' } });
    expect(executeChildAgents).toHaveBeenCalledTimes(2);
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

for (const failure of ['write-rejected', 'write-ack-lost', 'readback-unavailable', 'event-notification-lost'] as const) {
it(`retains the canonical Actor outcome when the Run terminal persistence has ${failure}`, async ({ signal, onTestFailed }) => {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-run-persistence-'));
  const executionEntered = deferred();
  const executionGate = deferred();
  const releaseGates = () => { executionEntered.resolve(); executionGate.resolve(); };
  signal.addEventListener('abort', releaseGates, { once: true });
  const diagnostics: Array<{ source: string; level: string; message: string }> = [];
  const restoreDiagnostics = setKodaXDiagnosticSink(diagnostic => {
    if ((diagnostic.source === 'coding:actors' || diagnostic.source.startsWith('runtime.')) && diagnostics.length < 16) {
      diagnostics.push({ source: diagnostic.source, level: diagnostic.level, message: diagnostic.message.slice(0, 512) });
    }
  });
  let stage = 'starting executor';
  let lastEvidence = '';
  let writeFailures = 0;
  let readFailures = 0;
  let publicationRejected = false;
  let readbackUnavailable = false;
  onTestFailed(() => {
    process.stderr.write(`[Independent Run persistence diagnostics] ${JSON.stringify({ failure, stage, lastEvidence,
      writeFailures, readFailures, publicationRejected, diagnostics })}\n`);
  });
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  let restarted: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
  try {
    vi.mocked(executeChildAgents).mockImplementation(async bundles => {
      executionEntered.resolve();
      await executionGate.promise;
      return {
        results: [{ childId: bundles[0]!.id, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid',
          summary: 'Actor result is canonical despite Run storage faults.', evidenceRefs: [], contradictions: [] }],
        mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [],
      };
    });
    const session = await runtime.sessions.create({ title: 'Independent Run terminal persistence fault' });
    const authority = {
      origin: { principalId: 'persistence-client', clientName: 'test' },
      providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'fixture-only' }),
      tools: ['read'], authorization: undefined,
    };
    const turn = await runtime.agents.spawn(session.id, { taskName: 'worker', objective: 'Complete exactly once.' }, authority);
    await executionEntered.promise;
    signal.throwIfAborted();
    const run = (await runtime.runs.list({ sessionId: session.id })).find(value => value.turnId === turn.turnId);
    if (!run) throw new Error('Persistence fixture has no exact independent Run.');
    const publicResult = runtime.runs.await(run.runId).then(
      value => ({ kind: 'result' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    );
    await runtime.runs.get(run.runId);
    if (failure === 'event-notification-lost') {
      const stringify = JSON.stringify;
      vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...args: unknown[]) => {
        // Reject the public event once, after its canonical status envelope remains writable.
        if (!publicationRejected && isRecord(value) && value.runId === run.runId
          && value.phase === 'completed' && !('_runtime' in value)) {
          publicationRejected = true;
          throw new Error('Fixture terminal event serialization failure.');
        }
        return Reflect.apply(stringify, JSON, [value, ...args]) as string | undefined;
      }) as typeof JSON.stringify);
    }
    const statusFile = join(homeDir, '.kodax', 'runtime', 'runs', encodeURIComponent(run.runId), 'status.json');
    const readFile = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((filename, options) => {
      if (readbackUnavailable && String(filename) === statusFile) {
        readFailures += 1;
        throw Object.assign(new Error('Fixture Run status readback is unavailable.'), { code: 'EIO' });
      }
      return readFile(filename, options);
    });
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (String(destination) === statusFile) {
        const candidate: unknown = JSON.parse(readFile(source, 'utf8'));
        if (failure !== 'event-notification-lost' && isRecord(candidate) && candidate.phase === 'completed') {
          writeFailures += 1;
          if (failure !== 'write-rejected') rename(source, destination);
          if (failure === 'readback-unavailable') readbackUnavailable = true;
          throw Object.assign(new Error('Fixture Run terminal write acknowledgement failed.'), { code: 'EIO' });
        }
      }
      return rename(source, destination);
    });
    syncBuiltinESMExports();
    stage = 'awaiting Run persistence fault outcome';
    executionGate.resolve();
    const result = await publicResult;
    if (result.kind === 'error') throw result.error;
    const output = await runtime.agents.output(session.id, turn.actorPath, turn.turnId);
    lastEvidence = JSON.stringify({ result: result.value, output });
    if (failure === 'event-notification-lost') expect(publicationRejected, lastEvidence).toBe(true);
    else expect(writeFailures, lastEvidence).toBeGreaterThan(0);
    if (failure === 'readback-unavailable') expect(readFailures, lastEvidence).toBeGreaterThan(0);
    expect(output.state, lastEvidence).toBe('completed');
    expect(result.value.phase, lastEvidence).toBe(failure === 'write-ack-lost' || failure === 'event-notification-lost' ? 'completed' : 'unknown');
    if (result.value.phase === 'unknown') {
      expect(result.value, lastEvidence).not.toHaveProperty('terminal');
    }
    expect(executeChildAgents).toHaveBeenCalledTimes(1);
    readbackUnavailable = false;
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    stage = 'reading authoritative status after the storage fault clears';
    if (failure !== 'write-rejected') {
      await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({ phase: 'completed', terminal: { kind: 'completed' } });
    }
    await runtime.close();
    restarted = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
    await expect(restarted.runs.get(run.runId)).resolves.toMatchObject({ phase: 'completed', terminal: { kind: 'completed' } });
    await expect(restarted.agents.output(session.id, turn.actorPath, turn.turnId)).resolves.toMatchObject({ state: 'completed' });
    expect(executeChildAgents).toHaveBeenCalledTimes(1);
  } finally {
    releaseGates();
    readbackUnavailable = false;
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    await restarted?.close();
    await runtime.close();
    signal.removeEventListener('abort', releaseGates);
    restoreDiagnostics();
    vi.mocked(executeChildAgents).mockReset();
    if (dirname(homeDir) !== temporaryRoot) throw new Error('Refusing to remove a fixture outside its temporary root.');
    await rm(homeDir, { recursive: true, force: true });
  }
}, 30_000);
}

it('keeps a natural canonical completion when Stop arrives during its terminal commit', async ({ signal, onTestFailed }) => {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-completion-first-'));
  const targetEntered = deferred();
  const peerEntered = deferred();
  const targetGate = deferred();
  const peerGate = deferred();
  const renameEntered = deferred();
  const terminalGate = deferred();
  const releaseGates = () => {
    targetEntered.resolve(); peerEntered.resolve(); targetGate.resolve(); peerGate.resolve();
    renameEntered.resolve(); terminalGate.resolve();
  };
  signal.addEventListener('abort', releaseGates, { once: true });
  const diagnostics: Array<{ level: string; message: string }> = [];
  const restoreDiagnostics = setKodaXDiagnosticSink(diagnostic => {
    if (diagnostic.source === 'coding:actors' && diagnostics.length < 16) {
      diagnostics.push({ level: diagnostic.level, message: diagnostic.message.slice(0, 512) });
    }
  });
  let stage = 'starting Actors';
  let lastEvidence = '';
  let terminalAttempt: AgentActorSaveAttempt | undefined;
  onTestFailed(() => {
    process.stderr.write(`[Independent Actor late Stop diagnostics] ${JSON.stringify({ stage, lastEvidence,
      save: terminalAttempt?.diagnostics(), diagnostics })}\n`);
  });
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  try {
    vi.mocked(executeChildAgents).mockImplementation(async (bundles, _context, options) => {
      const path = options.actorControl!.callerPath;
      if (path === '/root/target') {
        targetEntered.resolve();
        await waitForReleaseOrAbort(targetGate.promise, options.abortSignal);
      } else if (path === '/root/peer') {
        peerEntered.resolve();
        await waitForReleaseOrAbort(peerGate.promise, options.abortSignal);
      } else throw new Error(`Unexpected fixture Actor ${path}`);
      return {
        results: [{ childId: bundles[0]!.id, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid',
          summary: 'Natural execution completed before Stop.', evidenceRefs: [], contradictions: [] }],
        mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [],
      };
    });
    const session = await runtime.sessions.create({ title: 'Natural completion wins late Stop' });
    const authority = {
      origin: { principalId: 'completion-client', clientName: 'test' },
      providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'fixture-only' }),
      tools: ['read'], authorization: undefined,
    };
    const target = await runtime.agents.spawn(session.id, { taskName: 'target', objective: 'Finish before the late Stop.' }, authority);
    await targetEntered.promise;
    signal.throwIfAborted();
    const peerAuthority = { ...authority, origin: { principalId: 'peer-client', clientName: 'test' } };
    const peer = await runtime.agents.spawn(session.id, { taskName: 'peer', objective: 'Keep working for another client.' }, peerAuthority);
    await peerEntered.promise;
    signal.throwIfAborted();
    const run = (await runtime.runs.list({ sessionId: session.id })).find(value => value.turnId === target.turnId);
    if (!run) throw new Error('Late Stop fixture has no exact independent Run.');
    const beginSave = FileSessionStorage.prototype.beginActorSnapshotSave;
    let terminalWriteArmed = false;
    vi.spyOn(FileSessionStorage.prototype, 'beginActorSnapshotSave').mockImplementation(function (
      this: FileSessionStorage, id, snapshot, expectedRevision,
    ) {
      const terminal = id === session.id && snapshot.turns.some(turn => turn.actorPath === target.actorPath
        && turn.turnId === target.turnId && turn.state === 'completed');
      if (terminal) terminalWriteArmed = true;
      const attempt = beginSave.call(this, id, snapshot, expectedRevision);
      if (terminal) terminalAttempt = attempt;
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
    stage = 'holding the exact natural terminal commit';
    targetGate.resolve();
    await renameEntered.promise;
    signal.throwIfAborted();
    expect(terminalAttempt?.phase()).toBe('commit_inflight');
    const abort = runtime.runs.abort(run.runId).then(
      receipt => ({ kind: 'receipt' as const, receipt }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    );
    stage = 'waiting for the durable late Stop request';
    let cursor = 0;
    for (;;) {
      signal.throwIfAborted();
      const pending = await runtime.runs.get(run.runId);
      lastEvidence = JSON.stringify({ pending, save: terminalAttempt?.diagnostics() });
      if (pending.stop) break;
      const event = await runtime.agents.wait(session.id, cursor, 100, { signal });
      if (event) cursor = event.sequence;
    }
    terminalGate.resolve();
    stage = 'awaiting canonical natural completion';
    const result = await runtime.runs.await(run.runId);
    const stop = await abort;
    if (stop.kind === 'error') throw stop.error;
    const targetOutput = await runtime.agents.output(session.id, target.actorPath, target.turnId);
    const peerOutput = await runtime.agents.output(session.id, peer.actorPath, peer.turnId);
    const status = await runtime.runs.get(run.runId);
    lastEvidence = JSON.stringify({ receipt: stop.receipt, result, targetOutput, peerOutput, status });
    expect(stop.receipt).toMatchObject({ accepted: true });
    expect(peerOutput.state, lastEvidence).toBe('running');
    expect(result.phase, lastEvidence).toBe('completed');
    expect(targetOutput.state, lastEvidence).toBe('completed');
    expect(status, lastEvidence).toMatchObject({ phase: 'completed', terminal: { kind: 'completed' },
      stop: { state: 'confirmed', outcome: 'completed' } });
    expect(executeChildAgents).toHaveBeenCalledTimes(2);
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
