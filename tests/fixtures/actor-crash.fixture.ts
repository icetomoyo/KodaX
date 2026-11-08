import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { it, vi } from 'vitest';
import { type AgentActorSaveAttempt } from '@kodax-ai/agent';
import { FileSessionStorage } from '@kodax-ai/repl';
import { executeChildAgents } from '../../packages/coding/src/child-executor.js';
import { createKodaXRuntime } from '../runtime-fixture.js';

// Node's named fs exports are snapshots of the mutable default object.
// Forward the named method so the SDK namespace import observes this fixture's exact rename gate.
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  renameSync: (...args: Parameters<typeof fs.renameSync>) => fs.renameSync(...args),
}));

export type ActorCrashBoundary = 'before-actor-canonical' | 'before-run-terminal';

export interface ActorCrashMarker {
  readonly pid: number;
  readonly boundary: ActorCrashBoundary;
  readonly sessionId: string;
  readonly actorPath: string;
  readonly turnId: string;
  readonly runId: string;
  readonly actorSavePhase: string;
  readonly runPhase: string;
  readonly executorCalls: number;
}

vi.mock('../../packages/coding/src/child-executor.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../packages/coding/src/child-executor.js')>(),
  executeChildAgents: vi.fn(),
}));

it('holds the requested real persistence boundary until its owning process is killed', async () => {
  const homeDir = process.env.KODAX_ACTOR_CRASH_HOME;
  const markerFile = process.env.KODAX_ACTOR_CRASH_MARKER;
  const boundary = process.env.KODAX_ACTOR_CRASH_BOUNDARY;
  if (!homeDir || !markerFile || (boundary !== 'before-actor-canonical' && boundary !== 'before-run-terminal')) {
    throw new Error('Actor crash fixture requires its private home, marker, and persistence boundary.');
  }
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  const session = await runtime.sessions.create({ title: 'Actor crash boundary' });
  let target: { actorPath: string; turnId: string; runId: string } | undefined;
  let markTargetReady!: (value: NonNullable<typeof target>) => void;
  const targetReady = new Promise<NonNullable<typeof target>>(resolve => { markTargetReady = resolve; });
  let terminalWriteArmed = false;
  let terminalAttempt: AgentActorSaveAttempt | undefined;
  const originalRenameSync = fs.renameSync;
  const writeMarker = (): void => {
    if (!target) throw new Error('Persistence boundary has no exact Actor/Run association.');
    const statusFile = join(homeDir, '.kodax', 'runtime', 'runs', encodeURIComponent(target.runId), 'status.json');
    const status: unknown = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    const runPhase = typeof status === 'object' && status !== null && 'phase' in status && typeof status.phase === 'string'
      ? status.phase : 'unreadable';
    const marker: ActorCrashMarker = { pid: process.pid, boundary, sessionId: session.id, ...target,
      actorSavePhase: terminalAttempt?.phase() ?? 'not_started', runPhase,
      executorCalls: vi.mocked(executeChildAgents).mock.calls.length };
    const temporaryMarker = `${markerFile}.tmp`;
    fs.writeFileSync(temporaryMarker, JSON.stringify(marker));
    originalRenameSync(temporaryMarker, markerFile);
  };
  const beginSave = FileSessionStorage.prototype.beginActorSnapshotSave;
  vi.spyOn(FileSessionStorage.prototype, 'beginActorSnapshotSave').mockImplementation(function (
    this: FileSessionStorage, id, snapshot, expectedRevision,
  ) {
    const exactTerminal = id === session.id && target !== undefined && snapshot.turns.some(turn =>
      turn.actorPath === target!.actorPath && turn.turnId === target!.turnId && turn.state === 'completed');
    if (exactTerminal) terminalWriteArmed = true;
    const attempt = beginSave.call(this, id, snapshot, expectedRevision);
    if (exactTerminal) terminalAttempt = attempt;
    return attempt;
  });
  const rename = fsPromises.rename;
  vi.spyOn(fsPromises, 'rename').mockImplementation(async (source, destination) => {
    if (boundary === 'before-actor-canonical' && terminalWriteArmed && String(destination).endsWith(`${session.id}.jsonl`)) {
      terminalWriteArmed = false;
      writeMarker();
      await new Promise<void>(() => undefined);
    }
    return rename(source, destination);
  });
  vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
    if (boundary === 'before-run-terminal' && target !== undefined
      && String(destination) === join(homeDir, '.kodax', 'runtime', 'runs', encodeURIComponent(target.runId), 'status.json')) {
      const replacement: unknown = JSON.parse(fs.readFileSync(source, 'utf8'));
      if (typeof replacement === 'object' && replacement !== null && 'phase' in replacement && replacement.phase === 'completed') {
        writeMarker();
        // The parent kills this dedicated child process, not the suite's worker.
        // Blocking the child thread keeps this synchronous Run replacement uncommitted.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    }
    return originalRenameSync(source, destination);
  });
  vi.mocked(executeChildAgents).mockImplementation(async (bundles, _context, options) => {
    const actorPath = options.actorControl?.callerPath;
    const turnId = options.actorTurnId;
    if (!actorPath || !turnId) throw new Error('Worker has no exact Actor identity.');
    const run = (await runtime.runs.list({ sessionId: session.id })).find(value => value.turnId === turnId);
    if (!run) throw new Error('Worker dispatched without its durable Run.');
    target = { actorPath, turnId, runId: run.runId };
    markTargetReady(target);
    return {
      results: [{ childId: bundles[0]!.id, fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid',
        summary: 'Completed exactly once before the crash.', evidenceRefs: [], contradictions: [] }],
      mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [],
    };
  });
  const authority = { authorization: undefined, origin: { principalId: 'crash-client', clientName: 'test' },
    providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'fixture-only' }), tools: ['read'] };
  await runtime.agents.spawn(session.id, { taskName: 'worker', objective: 'Preserve exactly one completed execution.' }, authority);
  const dispatchedTarget = await targetReady;
  const result = await runtime.runs.await(dispatchedTarget.runId);
  await runtime.close();
  throw new Error(`Requested ${boundary} was not intercepted; Run settled as ${result.phase}.`);
}, 120_000);
