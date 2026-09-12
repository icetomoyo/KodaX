import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkflowAgentBackend, WorkflowModule, WorkflowProcessEvent } from '@kodax-ai/agent';

import { createWorkflowRunManager, requestSessionWorkflowStop } from './run-manager.js';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeBackend(): {
  readonly backend: WorkflowAgentBackend;
  readonly spawnCount: () => number;
  readonly stopCount: () => number;
} {
  let spawns = 0;
  let stops = 0;
  const names = new Map<string, string>();
  const backend: WorkflowAgentBackend = {
    spawn: async (input) => {
      spawns += 1;
      const taskId = `t${spawns}`;
      names.set(taskId, input.name);
      return { taskId, name: input.name };
    },
    wait: async (taskId) => ({
      taskId,
      name: names.get(taskId) ?? taskId,
      status: 'completed',
      finalText: `done:${taskId}`,
    }),
    output: async (taskId) => ({
      taskId,
      name: names.get(taskId) ?? taskId,
      status: 'running',
    }),
    send: async () => {},
    stop: async () => {
      stops += 1;
    },
  };
  return { backend, spawnCount: () => spawns, stopCount: () => stops };
}

describe('WorkflowRunManager', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-manager-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('rejects another Session stop and confirms only after owned workflow cleanup', async () => {
    const manager = createWorkflowRunManager();
    const cleanup = deferred<void>();
    const started = deferred<void>();
    const run = manager.start({ runId: 'owned', runDir: dir, args: {}, backend: fakeBackend().backend,
      processMetadata: { hostMetadata: { ownerSessionId: 'session-a' } },
      module: { meta: { name: 'owned', description: 'owned', readOnly: true },
        run: async () => { started.resolve(); await cleanup.promise; return 'done'; } },
    });
    await started.promise;
    expect(() => requestSessionWorkflowStop(manager, 'session-b', run.runId)).toThrow(/session_scope/);
    expect(manager.get(run.runId)?.stop).toBeUndefined();
    expect(requestSessionWorkflowStop(manager, 'session-a', run.runId)).toEqual({ runId: 'owned', accepted: true, state: 'unknown' });
    expect(requestSessionWorkflowStop(manager, 'session-a', run.runId)).toEqual({ runId: 'owned', accepted: false, state: 'unknown' });
    cleanup.resolve();
    await run.done;
    expect(requestSessionWorkflowStop(manager, 'session-a', run.runId).state).toBe('confirmed');
  });

  it('starts a workflow in the background and records the terminal snapshot', async () => {
    const manager = createWorkflowRunManager();
    const { backend } = fakeBackend();
    const module: WorkflowModule = {
      meta: { name: 'quick', description: 'quick', readOnly: true },
      run: async (wf) => {
        await wf.runAgent({ name: 'reader', prompt: 'read', readOnly: true });
        return 'ok';
      },
    };

    const run = manager.start({
      module,
      args: {},
      runId: 'run-bg',
      runDir: dir,
      backend,
    });

    expect(manager.get('run-bg')?.status).toBe('running');
    const outcome = await run.done;
    expect(outcome.kind).toBe('completed');
    expect(manager.get('run-bg')).toMatchObject({
      runId: 'run-bg',
      workflow: 'quick',
      status: 'completed',
      totalSpawned: 1,
      resultText: 'ok',
    });
  });

  it('publishes workflow process snapshots for SDK-style subscribers', async () => {
    const manager = createWorkflowRunManager({ now: () => 1_000 });
    const events: WorkflowProcessEvent[] = [];
    const unsubscribe = manager.subscribeWorkflowProcess((event) => events.push(event));
    const { backend } = fakeBackend();
    const module: WorkflowModule = {
      meta: {
        name: 'process-test',
        description: 'process',
        readOnly: true,
        phases: ['scan'],
        maxAgents: 3,
      },
      run: async (wf) => {
        await wf.phase('scan', async () => {
          await wf.runAgent({ name: 'reader', prompt: 'read', readOnly: true });
        });
        return { summary: 'final process result' };
      },
    };

    const run = manager.start({
      module,
      args: {},
      runId: 'run-process',
      runDir: dir,
      backend,
      processMetadata: {
        source: 'sdk',
        displayName: 'SDK process test',
        goal: 'inspect process metadata',
        hostMetadata: { sessionId: 'session-1', tag: 'coder' },
      },
    });

    await run.done;
    unsubscribe();

    const snapshot = manager.getWorkflowProcessSnapshot('run-process');
    expect(snapshot).toMatchObject({
      runId: 'run-process',
      workflowName: 'process-test',
      displayName: 'SDK process test',
      goal: 'inspect process metadata',
      source: 'sdk',
      hostMetadata: { sessionId: 'session-1', tag: 'coder' },
      status: 'completed',
      resultSummary: 'final process result',
      progress: {
        spawnedAgents: 1,
        finishedAgents: 1,
        activeAgents: 0,
        failedAgents: 0,
        stoppedAgents: 0,
        agentCap: 3,
      },
    });
    expect(events.map((event) => event.type)).toContain('workflow_started');
    expect(events.map((event) => event.type)).toContain('workflow_finished');
    expect(manager.listWorkflowProcessSnapshots({ activeOnly: true })).toEqual([]);
  });

  it('publishes host-clamped process caps for managed runs', async () => {
    const manager = createWorkflowRunManager();
    const { backend } = fakeBackend();
    const module: WorkflowModule = {
      meta: {
        name: 'host-capped-process',
        description: 'host capped process',
        readOnly: true,
        maxAgents: 10,
        tokenBudget: 50_000,
      },
      run: async () => 'ok',
    };

    const run = manager.start({
      module,
      args: {},
      runId: 'run-host-capped',
      runDir: dir,
      backend,
      hostPolicy: {
        maxAgents: 2,
        tokenBudget: 1_000,
      },
    });

    await run.done;

    expect(manager.getWorkflowProcessSnapshot('run-host-capped')).toMatchObject({
      progress: {
        agentCap: 2,
      },
      tokens: {
        total: 1_000,
      },
    });
  });

  it('pauses before launching new agents and resumes later', async () => {
    const manager = createWorkflowRunManager();
    const { backend, spawnCount } = fakeBackend();
    const readyForSecond = deferred<void>();
    const allowSecond = deferred<void>();
    const module: WorkflowModule = {
      meta: { name: 'pausable', description: 'pausable', readOnly: true },
      run: async (wf) => {
        await wf.runAgent({ name: 'first', prompt: 'first', readOnly: true });
        readyForSecond.resolve();
        await allowSecond.promise;
        await wf.runAgent({ name: 'second', prompt: 'second', readOnly: true });
        return 'ok';
      },
    };

    const run = manager.start({
      module,
      args: {},
      runId: 'run-pause',
      runDir: dir,
      backend,
    });

    await readyForSecond.promise;
    expect(spawnCount()).toBe(1);
    expect(manager.pause('run-pause')).toBe(true);
    expect(manager.getWorkflowProcessSnapshot('run-pause')?.status).toBe('paused');
    allowSecond.resolve();
    await Promise.resolve();
    expect(manager.get('run-pause')?.status).toBe('paused');
    expect(spawnCount()).toBe(1);

    expect(manager.resume('run-pause')).toBe(true);
    expect(manager.getWorkflowProcessSnapshot('run-pause')?.status).toBe('running');
    const outcome = await run.done;
    expect(outcome.kind).toBe('completed');
    expect(spawnCount()).toBe(2);
  });

  it('stops an in-flight workflow through abort propagation', async () => {
    const manager = createWorkflowRunManager();
    const waitStarted = deferred<void>();
    const backendState = fakeBackend();
    const backend: WorkflowAgentBackend = {
      ...backendState.backend,
      wait: async (taskId) => {
        waitStarted.resolve();
        return new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                taskId,
                name: taskId,
                status: 'stopped',
                finalText: '',
              }),
            20,
          );
        });
      },
    };
    const module: WorkflowModule = {
      meta: { name: 'stop-me', description: 'stop', readOnly: true },
      run: async (wf) => wf.runAgent({ name: 'long', prompt: 'long', readOnly: true }),
    };

    const run = manager.start({
      module,
      args: {},
      runId: 'run-stop',
      runDir: dir,
      backend,
    });

    await waitStarted.promise;
    expect(manager.stop('run-stop', 'test stop')).toBe(true);
    await run.done;
    expect(manager.get('run-stop')?.status).toBe('stopped');
    expect(backendState.stopCount()).toBeGreaterThan(0);
  });

  it('settles as failed instead of rejecting when startup persistence throws', async () => {
    const manager = createWorkflowRunManager();
    const { backend } = fakeBackend();
    const blockedRunDir = join(dir, 'not-a-directory');
    writeFileSync(blockedRunDir, '', 'utf8');
    const module: WorkflowModule = {
      meta: { name: 'bad-run-dir', description: 'bad dir', readOnly: true },
      run: async () => 'unreached',
    };

    const run = manager.start({
      module,
      args: {},
      runId: 'run-bad-dir',
      runDir: blockedRunDir,
      backend,
    });

    const outcome = await run.done;
    expect(outcome.kind).toBe('failed');
    expect(manager.get('run-bad-dir')).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('not-a-directory'),
    });
  });
});
