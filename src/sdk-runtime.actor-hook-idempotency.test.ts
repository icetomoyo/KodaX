import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentEvent } from '@kodax-ai/agent';
import type { CodingActorSessionOptions } from '@kodax-ai/coding';

import { executeChildAgents } from '../packages/coding/src/child-executor.js';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';

const observed = vi.hoisted(() => ({ sessions: [] as Array<{
  options: CodingActorSessionOptions;
  events: AgentEvent[];
}> }));

vi.mock('@kodax-ai/coding', async importOriginal => {
  const actual = await importOriginal<typeof import('@kodax-ai/coding')>();
  return {
    ...actual,
    CodingActorSession: class extends actual.CodingActorSession {
      constructor(options: CodingActorSessionOptions = {}) {
        const session = { options, events: [] as AgentEvent[] };
        super({ ...options, onEventCommitted(event) {
          session.events.push(event);
          return options.onEventCommitted?.(event);
        } });
        observed.sessions.push(session);
      }
    },
  };
});

vi.mock('../packages/coding/src/child-executor.js', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/coding/src/child-executor.js')>(),
  executeChildAgents: vi.fn(),
}));

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolvePromise => { release = resolvePromise; });
  return { promise, release };
}

it('ignores duplicate committed terminal hooks without touching a subsequent Actor Turn', async ({ signal, onTestFailed }) => {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-actor-hook-idempotency-'));
  const firstEntered = deferred();
  const firstExecution = deferred();
  const secondEntered = deferred();
  const secondExecution = deferred();
  const releaseGates = () => {
    firstEntered.release(); firstExecution.release(); secondEntered.release(); secondExecution.release();
  };
  signal.addEventListener('abort', releaseGates, { once: true });
  let stage = 'starting the original Turn';
  let lastEvidence = '';
  onTestFailed(() => {
    process.stderr.write(`[Independent Actor duplicate hook diagnostics] ${JSON.stringify({ stage, lastEvidence })}\n`);
  });
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
  let subscription: ReturnType<typeof runtime.events.subscribe> | undefined;
  try {
    let calls = 0;
    vi.mocked(executeChildAgents).mockImplementation(async bundles => {
      calls += 1;
      if (calls === 1) {
        firstEntered.release();
        await firstExecution.promise;
      } else if (calls === 2) {
        secondEntered.release();
        await secondExecution.promise;
      } else throw new Error('Duplicate hook unexpectedly replayed an executor.');
      return { results: [{ childId: bundles[0]!.id, fanoutClass: 'evidence-scan', status: 'completed',
        disposition: 'valid', summary: 'Exactly one execution for this Turn.', evidenceRefs: [], contradictions: [] }],
      mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [] };
    });
    const session = await runtime.sessions.create({ title: 'Canonical terminal hook idempotency' });
    const authority = {
      origin: { principalId: 'hook-client', clientName: 'test' },
      providerCredentialAccessFactory: () => ({ allowedProviders: ['deepseek'], acquire: async () => 'fixture-only' }),
      tools: ['read'], authorization: undefined,
    };
    const terminalEvents: Array<{ type: string; runId: string | undefined }> = [];
    subscription = runtime.events.subscribe({ sessionId: session.id,
      type: ['run.completed', 'run.failed', 'run.interrupted', 'run.cancelled'] }, event => {
      terminalEvents.push({ type: event.type, runId: event.runId });
    });
    const first = await runtime.agents.spawn(session.id, { taskName: 'worker', objective: 'Complete the first Turn once.' }, authority);
    await firstEntered.promise;
    signal.throwIfAborted();
    const firstRun = (await runtime.runs.list({ sessionId: session.id })).find(value => value.turnId === first.turnId);
    if (!firstRun) throw new Error('Hook fixture has no first independent Run.');
    firstExecution.release();
    await expect(runtime.runs.await(firstRun.runId)).resolves.toMatchObject({ phase: 'completed' });
    const captured = observed.sessions.find(value => value.options.sessionId === session.id);
    const terminalEvent = captured?.events.find(event => event.kind === 'turn_completed'
      && event.actorPath === first.actorPath && event.turnId === first.turnId);
    const callback = captured?.options.onEventCommitted;
    if (!callback || !terminalEvent) throw new Error('Hook fixture did not capture its canonical terminal callback.');
    const firstFile = join(homeDir, '.kodax', 'runtime', 'runs', encodeURIComponent(firstRun.runId), 'status.json');
    const firstCanonical = await readFile(firstFile, 'utf8');
    stage = 'redelivering the original canonical terminal event';
    await callback(terminalEvent);
    await callback(terminalEvent);
    expect(await readFile(firstFile, 'utf8')).toBe(firstCanonical);
    expect(terminalEvents).toEqual([{ type: 'run.completed', runId: firstRun.runId }]);

    const followup = await runtime.agents.followup(session.id, first.actorPath, 'Complete a distinct subsequent Turn.', authority);
    expect(followup.delivery).toBe('started_turn');
    await secondEntered.promise;
    signal.throwIfAborted();
    const secondRun = (await runtime.runs.list({ sessionId: session.id })).find(value => value.turnId === followup.turn.turnId);
    if (!secondRun) throw new Error('Hook fixture has no followup independent Run.');
    expect(secondRun.runId).not.toBe(firstRun.runId);
    const secondFile = join(homeDir, '.kodax', 'runtime', 'runs', encodeURIComponent(secondRun.runId), 'status.json');
    const secondRunning = await readFile(secondFile, 'utf8');
    stage = 'redelivering an old terminal event during the new Turn';
    await callback(terminalEvent);
    await callback(terminalEvent);
    const output = await runtime.agents.output(session.id, followup.turn.actorPath, followup.turn.turnId);
    lastEvidence = JSON.stringify({ output, terminalEvents, calls });
    expect(output.state, lastEvidence).toBe('running');
    await expect(runtime.runs.get(secondRun.runId)).resolves.toMatchObject({ phase: 'running' });
    expect(await readFile(firstFile, 'utf8')).toBe(firstCanonical);
    expect(await readFile(secondFile, 'utf8')).toBe(secondRunning);
    expect(terminalEvents).toEqual([{ type: 'run.completed', runId: firstRun.runId }]);
    expect(executeChildAgents).toHaveBeenCalledTimes(2);

    secondExecution.release();
    await expect(runtime.runs.await(secondRun.runId)).resolves.toMatchObject({ phase: 'completed' });
    expect(terminalEvents).toEqual([{ type: 'run.completed', runId: firstRun.runId },
      { type: 'run.completed', runId: secondRun.runId }]);
    expect(executeChildAgents).toHaveBeenCalledTimes(2);
  } finally {
    releaseGates();
    subscription?.close();
    await runtime.close();
    signal.removeEventListener('abort', releaseGates);
    observed.sessions.length = 0;
    vi.mocked(executeChildAgents).mockReset();
    if (dirname(homeDir) !== temporaryRoot) throw new Error('Refusing to remove a fixture outside its temporary root.');
    await rm(homeDir, { recursive: true, force: true });
  }
}, 30_000);
