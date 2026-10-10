/**
 * FEATURE_217 (v0.7.49) — Workflow runtime tests (Phase A).
 *
 * Validates the agent-layer orchestration engine against a fake backend
 * (no real agents): event ordering, maxAgents total cap, maxConcurrency
 * in-flight gate, parallel concurrency, abort handling, budget accounting.
 */

import { describe, expect, it } from 'vitest';

import {
  createWorkflowRuntime,
  runWorkflow,
  WorkflowAbortError,
  WorkflowBudgetError,
  WorkflowLimitError,
  type WorkflowAgentBackend,
  type WorkflowEvent,
  type WorkflowModule,
  type WorkflowSpawnAgentInput,
  type WorkflowTaskResult,
} from './index.js';
import { normalizeWorkflowLimits } from './runtime.js';

describe('normalizeWorkflowLimits — tokenBudget 0 means unbounded', () => {
  it('treats tokenBudget 0 / negative as unbounded (omitted), not an error', () => {
    // Unlike the count limits, tokenBudget 0 is a valid "no cap" — it must NOT throw.
    expect(normalizeWorkflowLimits({ tokenBudget: 0 }).tokenBudget).toBeUndefined();
    expect(normalizeWorkflowLimits({ tokenBudget: -1 }).tokenBudget).toBeUndefined();
    expect(normalizeWorkflowLimits({ tokenBudget: 50_000 }).tokenBudget).toBe(50_000);
  });
  it('still rejects a non-positive count limit (maxAgents/maxConcurrency)', () => {
    expect(() => normalizeWorkflowLimits({ maxAgents: 0 })).toThrow(WorkflowLimitError);
    expect(() => normalizeWorkflowLimits({ maxConcurrency: 0 })).toThrow(WorkflowLimitError);
  });
});

/** Fake backend: each spawn resolves wait after a tick; tracks the max
 *  number of simultaneously in-flight agents so concurrency caps can be
 *  asserted. */
function fakeBackend(
  config: { waitDelayMs?: number } = {},
): {
  backend: WorkflowAgentBackend;
  peakInFlight: () => number;
  spawnCount: () => number;
  stoppedTaskIds: () => readonly string[];
} {
  let counter = 0;
  let inFlight = 0;
  let peak = 0;
  let spawns = 0;
  const stopped: string[] = [];
  const inFlightByTask = new Map<string, boolean>();
  const backend: WorkflowAgentBackend = {
    spawn: async (input: WorkflowSpawnAgentInput) => {
      spawns += 1;
      counter += 1;
      const taskId = `task-${counter}`;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      inFlightByTask.set(taskId, true);
      return { taskId, name: input.name };
    },
    wait: async (taskId: string): Promise<WorkflowTaskResult> => {
      if (config.waitDelayMs) await new Promise((r) => setTimeout(r, config.waitDelayMs));
      else await Promise.resolve();
      if (inFlightByTask.get(taskId)) {
        inFlight -= 1;
        inFlightByTask.set(taskId, false);
      }
      return { taskId, name: taskId, status: 'completed', finalText: 'done', usage: { outputTokens: 10 } };
    },
    output: async (taskId: string) => ({ taskId, name: taskId, status: 'running' as const }),
    send: async () => {},
    stop: async (taskId: string) => {
      stopped.push(taskId);
      if (inFlightByTask.get(taskId)) {
        inFlight -= 1;
        inFlightByTask.set(taskId, false);
      }
    },
  };
  return {
    backend,
    peakInFlight: () => peak,
    spawnCount: () => spawns,
    stoppedTaskIds: () => [...stopped],
  };
}

const baseOpts = (backend: WorkflowAgentBackend, extra = {}) => ({
  runId: 'run-1',
  backend,
  ...extra,
});

describe('runWorkflow — event envelope + ordering', () => {
  it('emits workflow_started first and workflow_completed last in seq order', async () => {
    const { backend } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend), async (wf) => {
      await wf.phase('investigate', async () => {
        await wf.runAgent({ name: 'a', prompt: 'x' });
      });
      return 'ok';
    });
    expect(outcome.ok).toBe(true);
    const types = outcome.state.events.map((e) => e.type);
    expect(types[0]).toBe('workflow_started');
    expect(types[types.length - 1]).toBe('workflow_completed');
    expect(types).toEqual([
      'workflow_started',
      'phase_started',
      'agent_spawned',
      'agent_completed',
      'phase_finished',
      'workflow_completed',
    ]);
    const completed = outcome.state.events.find((event) => event.type === 'agent_completed');
    expect(completed?.data?.summary).toBe('done');
    expect(completed?.data?.usage).toEqual({ outputTokens: 10 });
    // seq strictly increasing.
    const seqs = outcome.state.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('includes summarized workflow results on the terminal completion event', async () => {
    const { backend } = fakeBackend();
    const outcome = await runWorkflow(
      baseOpts(backend, {
        summarizeResult: (result: unknown) =>
          typeof result === 'string' ? `summary:${result}` : undefined,
      }),
      async () => 'ok',
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.state.events.at(-1)).toMatchObject({
      type: 'workflow_completed',
      data: {
        resultSummary: 'summary:ok',
      },
    });
  });

  it('records result summarizer errors without failing a completed workflow', async () => {
    const { backend } = fakeBackend();
    const outcome = await runWorkflow(
      baseOpts(backend, {
        summarizeResult: () => {
          throw new Error('summary unavailable');
        },
      }),
      async () => 'ok',
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.state.status).toBe('completed');
    expect(outcome.state.events.at(-1)).toMatchObject({
      type: 'workflow_completed',
      data: {
        resultSummaryError: 'summary unavailable',
      },
    });
  });

  it('prefers the child self-distilled digest for completed-agent events', async () => {
    const finalText = [
      'I now have a complete picture of the workflow changes.',
      'Here is my long report.',
      'x'.repeat(700),
      'Finding: this full report stays available for synthesis.',
    ].join('\n');
    const digest = [
      '- Finding: workflow transcript uses the child digest.',
      '- Evidence: full finalText stays separate for synthesis.',
    ].join('\n');
    const backend: WorkflowAgentBackend = {
      spawn: async (input: WorkflowSpawnAgentInput) => ({ taskId: 'task-long', name: input.name }),
      wait: async (taskId: string): Promise<WorkflowTaskResult> => ({
        taskId,
        name: 'long-child',
        status: 'completed',
        finalText,
        digest,
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
      }),
      output: async (taskId: string) => ({ taskId, name: 'long-child', status: 'running' }),
      send: async () => {},
      stop: async () => {},
    };

    const outcome = await runWorkflow(baseOpts(backend), async (wf) => {
      await wf.runAgent({ name: 'long-child', prompt: 'x' });
      return 'ok';
    });

    expect(outcome.ok).toBe(true);
    const completed = outcome.state.events.find((event) => event.type === 'agent_completed');
    expect(completed?.data?.summary).toBe(digest);
    expect(completed?.data?.summaryKind).toBe('digest');
    expect(completed?.data?.provider).toBe('anthropic');
    expect(completed?.data?.model).toBe('claude-sonnet-4-5');
    expect(completed?.data?.summary).not.toContain('long report');
  });

  it('falls back to bounded finalText excerpts when a child digest is missing', async () => {
    const finalText = [
      'I now have a complete picture of the workflow changes.',
      'Here is my long report.',
      'overview details '.repeat(400),
      'Finding: finalText fallback remains bounded.',
    ].join('\n');
    const backend: WorkflowAgentBackend = {
      spawn: async (input: WorkflowSpawnAgentInput) => ({ taskId: 'task-long', name: input.name }),
      wait: async (taskId: string): Promise<WorkflowTaskResult> => ({
        taskId,
        name: 'long-child',
        status: 'completed',
        finalText,
      }),
      output: async (taskId: string) => ({ taskId, name: 'long-child', status: 'running' }),
      send: async () => {},
      stop: async () => {},
    };

    const outcome = await runWorkflow(baseOpts(backend), async (wf) => {
      await wf.runAgent({ name: 'long-child', prompt: 'x' });
      return 'ok';
    });

    expect(outcome.ok).toBe(true);
    const completed = outcome.state.events.find((event) => event.type === 'agent_completed');
    expect(completed?.data?.summary).toContain('overview details');
    expect(completed?.data?.summaryKind).toBe('excerpt');
    expect(String(completed?.data?.summary).length).toBeLessThanOrEqual(4096 + 3);
  });

  it('emits async digest updates while the workflow is still running', async () => {
    let summaryListener:
      | ((taskId: string, update: { readonly summary?: string; readonly summaryKind: 'digest' }) => void)
      | undefined;
    const events: WorkflowEvent[] = [];
    let allowWorkflowToFinish: (() => void) | undefined;
    const workflowCanFinish = new Promise<void>((resolve) => {
      allowWorkflowToFinish = resolve;
    });
    let childCompleted: (() => void) | undefined;
    const childCompletedPromise = new Promise<void>((resolve) => {
      childCompleted = resolve;
    });
    const backend: WorkflowAgentBackend = {
      spawn: async (input: WorkflowSpawnAgentInput) => ({ taskId: 'task-async', name: input.name }),
      wait: async (taskId: string): Promise<WorkflowTaskResult> => ({
        taskId,
        name: 'async-child',
        status: 'completed',
        finalText: 'Full report while digest is still running.',
        digestPending: true,
      }),
      output: async (taskId: string) => ({ taskId, name: 'async-child', status: 'running' }),
      send: async () => {},
      stop: async () => {},
      subscribeTaskSummaryUpdates: (listener) => {
        summaryListener = listener;
        return () => {
          summaryListener = undefined;
        };
      },
    };

    const outcomePromise = runWorkflow(
      baseOpts(backend, { onEvent: (event: WorkflowEvent) => events.push(event) }),
      async (wf) => {
        await wf.runAgent({ name: 'async-child', prompt: 'x' });
        childCompleted?.();
        await workflowCanFinish;
        return 'ok';
      },
    );

    await childCompletedPromise;
    const completed = events.find((event) => event.type === 'agent_completed');
    expect(completed?.data).toMatchObject({
      taskId: 'task-async',
      summary: 'Full report while digest is still running.',
      summaryKind: 'pending',
    });

    summaryListener?.('task-async', {
      summary: '- Finding: async digest arrived.',
      summaryKind: 'digest',
    });

    expect(events.at(-1)).toMatchObject({
      type: 'agent_summary_updated',
      data: {
        taskId: 'task-async',
        name: 'async-child',
        summary: '- Finding: async digest arrived.',
        summaryKind: 'digest',
      },
    });

    allowWorkflowToFinish?.();
    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(true);
  });

  it('drops async digest updates after the workflow is completed', async () => {
    let summaryListener:
      | ((taskId: string, update: { readonly summary?: string; readonly summaryKind: 'digest' }) => void)
      | undefined;
    const events: WorkflowEvent[] = [];
    const backend: WorkflowAgentBackend = {
      spawn: async (input: WorkflowSpawnAgentInput) => ({ taskId: 'task-completed', name: input.name }),
      wait: async (taskId: string): Promise<WorkflowTaskResult> => ({
        taskId,
        name: 'completed-child',
        status: 'completed',
        finalText: 'Full report while digest is still running.',
        digestPending: true,
      }),
      output: async (taskId: string) => ({ taskId, name: 'completed-child', status: 'running' }),
      send: async () => {},
      stop: async () => {},
      subscribeTaskSummaryUpdates: (listener) => {
        summaryListener = listener;
        return () => {
          summaryListener = undefined;
        };
      },
    };

    const outcome = await runWorkflow(
      baseOpts(backend, { onEvent: (event: WorkflowEvent) => events.push(event) }),
      async (wf) => {
        await wf.runAgent({ name: 'completed-child', prompt: 'x' });
        return 'ok';
      },
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.state.events.at(-1)?.type).toBe('workflow_completed');
    const eventCount = events.length;

    summaryListener?.('task-completed', {
      summary: '- Finding: digest arrived after workflow completion.',
      summaryKind: 'digest',
    });

    expect(events).toHaveLength(eventCount);
    expect(events.some((event) => event.type === 'agent_summary_updated')).toBe(false);
  });

  it('keeps a fallback summary when an async digest attempt fails before workflow completion', async () => {
    let summaryListener:
      | ((taskId: string, update: { readonly summaryKind: 'digest-failed' }) => void)
      | undefined;
    const events: WorkflowEvent[] = [];
    let allowWorkflowToFinish: (() => void) | undefined;
    const workflowCanFinish = new Promise<void>((resolve) => {
      allowWorkflowToFinish = resolve;
    });
    let childCompleted: (() => void) | undefined;
    const childCompletedPromise = new Promise<void>((resolve) => {
      childCompleted = resolve;
    });
    const backend: WorkflowAgentBackend = {
      spawn: async (input: WorkflowSpawnAgentInput) => ({ taskId: 'task-digest-failed', name: input.name }),
      wait: async (taskId: string): Promise<WorkflowTaskResult> => ({
        taskId,
        name: 'digest-failed-child',
        status: 'completed',
        finalText: 'Fallback report with evidence while digest is unavailable.',
        digestPending: true,
      }),
      output: async (taskId: string) => ({ taskId, name: 'digest-failed-child', status: 'running' }),
      send: async () => {},
      stop: async () => {},
      subscribeTaskSummaryUpdates: (listener) => {
        summaryListener = listener;
        return () => {
          summaryListener = undefined;
        };
      },
    };

    const outcomePromise = runWorkflow(
      baseOpts(backend, { onEvent: (event: WorkflowEvent) => events.push(event) }),
      async (wf) => {
        await wf.runAgent({ name: 'digest-failed-child', prompt: 'x' });
        childCompleted?.();
        await workflowCanFinish;
        return 'ok';
      },
    );

    await childCompletedPromise;
    summaryListener?.('task-digest-failed', { summaryKind: 'digest-failed' });

    expect(events.at(-1)).toMatchObject({
      type: 'agent_summary_updated',
      data: {
        taskId: 'task-digest-failed',
        name: 'digest-failed-child',
        summary: 'Fallback report with evidence while digest is unavailable.',
        summaryKind: 'digest-failed',
      },
    });

    allowWorkflowToFinish?.();
    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(true);
  });

  it('drops async digest updates after the workflow is stopped', async () => {
    let summaryListener:
      | ((taskId: string, update: { readonly summary?: string; readonly summaryKind: 'digest' }) => void)
      | undefined;
    const events: WorkflowEvent[] = [];
    const backend: WorkflowAgentBackend = {
      spawn: async (input: WorkflowSpawnAgentInput) => ({ taskId: 'task-stop', name: input.name }),
      wait: async (taskId: string): Promise<WorkflowTaskResult> => ({
        taskId,
        name: 'stopped-child',
        status: 'completed',
        finalText: 'done',
      }),
      output: async (taskId: string) => ({ taskId, name: 'stopped-child', status: 'running' }),
      send: async () => {},
      stop: async () => {},
      subscribeTaskSummaryUpdates: (listener) => {
        summaryListener = listener;
        return () => {
          summaryListener = undefined;
        };
      },
    };

    const outcome = await runWorkflow(
      baseOpts(backend, { onEvent: (event: WorkflowEvent) => events.push(event) }),
      async (wf) => {
        await wf.spawnAgent({ name: 'stopped-child', prompt: 'x' });
        throw new WorkflowAbortError();
      },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.state.status).toBe('stopped');
    const eventCount = events.length;

    summaryListener?.('task-stop', {
      summary: '- Finding: digest arrived after stop.',
      summaryKind: 'digest',
    });

    expect(events).toHaveLength(eventCount);
    expect(events.some((event) => event.type === 'agent_summary_updated')).toBe(false);
  });

  it('emits workflow_failed and surfaces the error when the script throws', async () => {
    const { backend } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend), async () => {
      throw new Error('script boom');
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toBe('script boom');
    expect(outcome.state.status).toBe('failed');
    expect(outcome.state.events.at(-1)?.type).toBe('workflow_failed');
  });

  it('returns null from wf.runAgent on a failed child (FEATURE_246 Part E lenient; script decides), still records agent_failed', async () => {
    const backend: WorkflowAgentBackend = {
      spawn: async (input) => ({ taskId: 'task-failed', name: input.name }),
      wait: async (taskId) => ({
        taskId,
        name: 'writer',
        status: 'failed',
        finalText: 'Workflow task verification failed: expected file mutations.',
        verification: {
          ok: false,
          reasons: ['expected file mutations'],
        },
      }),
      output: async (taskId) => ({ taskId, name: 'writer', status: 'running' }),
      send: async () => {},
      stop: async () => {},
    };

    let captured: unknown = 'sentinel';
    const outcome = await runWorkflow(baseOpts(backend), async (wf) => {
      // Lenient failure: runAgent resolves to null instead of throwing, so the
      // SCRIPT (not the runtime) decides what a failed child means.
      captured = await wf.runAgent({ name: 'writer', prompt: 'write files', readOnly: false });
      return 'continued';
    });

    expect(captured).toBeNull();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result).toBe('continued');
    // The failure is still surfaced as a run-graph event (KodaX records it).
    expect(outcome.state.events.map((event) => event.type)).toEqual([
      'workflow_started',
      'agent_spawned',
      'agent_failed',
      'workflow_completed',
    ]);
    expect(outcome.state.events.find((event) => event.type === 'agent_failed')).toMatchObject({
      data: {
        taskId: 'task-failed',
        status: 'failed',
        verification: {
          ok: false,
          reasons: ['expected file mutations'],
        },
      },
    });
  });

  it('a script that wants fail-loud can rethrow on a null runAgent result', async () => {
    const backend: WorkflowAgentBackend = {
      spawn: async (input) => ({ taskId: 'task-failed', name: input.name }),
      wait: async (taskId) => ({ taskId, name: 'writer', status: 'failed', finalText: 'boom' }),
      output: async (taskId) => ({ taskId, name: 'writer', status: 'running' }),
      send: async () => {},
      stop: async () => {},
    };
    const outcome = await runWorkflow(baseOpts(backend), async (wf) => {
      const r = await wf.runAgent({ name: 'writer', prompt: 'x', readOnly: false });
      if (r === null) throw new Error('writer failed');
      return 'unreached';
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.state.status).toBe('failed');
  });

  it('allows wf.runAgent to return completed_unverified without failing the workflow', async () => {
    const backend: WorkflowAgentBackend = {
      spawn: async (input) => ({ taskId: 'task-unverified', name: input.name }),
      wait: async (taskId) => ({
        taskId,
        name: 'writer',
        status: 'completed_unverified',
        finalText: 'Finished, but no mutation evidence was observed.',
        verification: {
          ok: false,
          enforcement: 'warn',
          reasons: ['expected file mutations'],
        },
      }),
      output: async (taskId) => ({ taskId, name: 'writer', status: 'running' }),
      send: async () => {},
      stop: async () => {},
    };

    const outcome = await runWorkflow(baseOpts(backend), async (wf) => {
      const result = await wf.runAgent({ name: 'writer', prompt: 'write files', readOnly: false });
      return result.status;
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result).toBe('completed_unverified');
    expect(outcome.state.status).toBe('completed');
    expect(outcome.state.events.map((event) => event.type)).toEqual([
      'workflow_started',
      'agent_spawned',
      'agent_unverified',
      'workflow_completed',
    ]);
  });

  it('records user aborts as stopped instead of failed', async () => {
    const { backend } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend), async () => {
      throw new WorkflowAbortError();
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.state.status).toBe('stopped');
    expect(outcome.state.events.map((event) => event.type)).toEqual([
      'workflow_started',
      'workflow_stopped',
    ]);
  });

  it('stops spawned-but-unwaited children when the workflow fails', async () => {
    const { backend, stoppedTaskIds } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend), async (wf) => {
      await wf.spawnAgent({ name: 'left-running', prompt: 'keep working' });
      throw new Error('script boom');
    });

    expect(outcome.ok).toBe(false);
    expect(stoppedTaskIds()).toEqual(['task-1']);
    expect(outcome.state.events.map((event) => event.type)).toContain('agent_stopped');
  });

  it('stops spawned-but-unwaited children when the workflow succeeds', async () => {
    const { backend, stoppedTaskIds } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend), async (wf) => {
      await wf.spawnAgent({ name: 'left-running', prompt: 'keep working' });
      return 'ok';
    });

    expect(outcome.ok).toBe(true);
    expect(stoppedTaskIds()).toEqual(['task-1']);
    expect(outcome.state.status).toBe('completed');
    expect(outcome.state.events.map((event) => event.type)).toEqual([
      'workflow_started',
      'agent_spawned',
      'agent_stopped',
      'workflow_completed',
    ]);
  });

  it('does not leak concurrency capacity when the agent_spawned event sink throws', async () => {
    const { backend, peakInFlight } = fakeBackend();
    let failFirstSpawnEvent = true;
    const outcome = await runWorkflow(
      baseOpts(backend, {
        limits: { maxConcurrency: 1 },
        onEvent: (event: WorkflowEvent) => {
          if (event.type === 'agent_spawned' && failFirstSpawnEvent) {
            failFirstSpawnEvent = false;
            throw new Error('event sink failed');
          }
        },
      }),
      async (wf) => {
        try {
          await wf.spawnAgent({ name: 'first', prompt: 'x' });
        } catch {
          // Simulates generated workflow recovery after a host-side event failure.
        }
        const second = await wf.spawnAgent({ name: 'second', prompt: 'x' });
        await wf.stop(second.taskId, 'done');
        return 'ok';
      },
    );

    expect(outcome.ok).toBe(true);
    expect(peakInFlight()).toBe(1);
  });

  it('does not emit agent_completed after a failed workflow has stopped the task', async () => {
    const events: WorkflowEvent[] = [];
    let resolveWait: ((result: WorkflowTaskResult) => void) | undefined;
    const backend: WorkflowAgentBackend = {
      spawn: async (input) => ({ taskId: 'task-1', name: input.name }),
      wait: (taskId) =>
        new Promise<WorkflowTaskResult>((resolve) => {
          resolveWait = resolve;
        }).then((result) => ({ ...result, taskId })),
      output: async (taskId) => ({ taskId, name: taskId, status: 'running' }),
      send: async () => {},
      stop: async () => {},
    };

    const outcome = await runWorkflow(
      baseOpts(backend, { onEvent: (event: WorkflowEvent) => events.push(event) }),
      async (wf) => {
        const handle = await wf.spawnAgent({ name: 'late-finisher', prompt: 'keep working' });
        void wf.wait(handle.taskId);
        await Promise.resolve();
        throw new Error('script boom');
      },
    );

    expect(outcome.ok).toBe(false);
    expect(events.some((event) => event.type === 'agent_stopped')).toBe(true);
    resolveWait?.({
      taskId: 'task-1',
      name: 'late-finisher',
      status: 'completed',
      finalText: 'late done',
    });
    await Promise.resolve();
    await Promise.resolve();

    const terminalTypes = events
      .filter((event) => event.type === 'agent_stopped' || event.type === 'agent_completed')
      .map((event) => event.type);
    expect(terminalTypes).toEqual(['agent_stopped']);
  });

  it('does not hang the failed outcome when backend.stop never resolves', async () => {
    const { backend } = fakeBackend();
    const hangingStopBackend: WorkflowAgentBackend = {
      ...backend,
      stop: () => new Promise<void>(() => {}),
    };
    const startedAt = Date.now();

    const outcome = await runWorkflow(baseOpts(hangingStopBackend), async (wf) => {
      await wf.spawnAgent({ name: 'left-running', prompt: 'keep working' });
      throw new Error('script boom');
    });

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(outcome.ok).toBe(false);
    expect(outcome.state.events.at(-1)?.type).toBe('workflow_failed');
    const stopped = outcome.state.events.find((event) => event.type === 'agent_stopped');
    expect(stopped?.data?.stopTimedOut).toBe(true);
  });
});

describe('maxAgents total cap', () => {
  it('releases a pending lifetime reservation when the backend rejects a spawn', async () => {
    const base = fakeBackend();
    let attempts = 0;
    const backend: WorkflowAgentBackend = { ...base.backend,
      spawn: async input => {
        if (attempts++ === 0) throw new Error('Fixture startup failed before acceptance.');
        return base.backend.spawn(input);
      },
    };
    const outcome = await runWorkflow(baseOpts(backend, { limits: { maxAgents: 1 } }), async wf => {
      await expect(wf.spawnAgent({ name: 'rejected', prompt: 'x' })).rejects.toThrow('Fixture startup failed');
      return wf.runAgent({ name: 'accepted', prompt: 'x' });
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.state.totalSpawned).toBe(1);
    expect(base.spawnCount()).toBe(1);
  });

  it('throws WorkflowLimitError when total spawns exceed maxAgents', async () => {
    const { backend, spawnCount } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend, { limits: { maxAgents: 2 } }), async (wf) => {
      await wf.runAgent({ name: 'a', prompt: 'x' });
      await wf.runAgent({ name: 'b', prompt: 'x' });
      await wf.runAgent({ name: 'c', prompt: 'x' }); // 3rd exceeds cap
      return 'unreached';
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(WorkflowLimitError);
    expect(spawnCount()).toBe(2); // 3rd never reached backend.spawn
  });
});

describe('wf.pipeline — no-barrier staged scheduling', () => {
  it('runs each item through ordered stages and preserves input order', async () => {
    const { backend } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend), async (wf) =>
      wf.pipeline!(
        ['a', 'b', 'c'],
        (_prev, item, index) => `${item as string}#${index}`,
        (prev, item) => `${prev as string}->v(${item as string})`,
      ),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toEqual(['a#0->v(a)', 'b#1->v(b)', 'c#2->v(c)']);
    }
  });

  it('drops a throwing item to null and keeps siblings (input order preserved)', async () => {
    const { backend } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend), async (wf) =>
      wf.pipeline!(
        ['ok', 'boom', 'ok2'],
        (_prev, item) => {
          if (item === 'boom') throw new Error('stage blew up');
          return item;
        },
        (prev) => `${prev as string}!`,
      ),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result).toEqual(['ok!', null, 'ok2!']);
  });

  it('advances a fast item into stage 2 while a slow item is still in stage 1 (no barrier)', async () => {
    const { backend } = fakeBackend();
    let releaseSlow: () => void = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const order: string[] = [];
    const runPromise = runWorkflow(baseOpts(backend), async (wf) =>
      wf.pipeline!(
        ['slow', 'fast'],
        async (_prev, item) => {
          if (item === 'slow') await slowGate;
          order.push(`s1:${item as string}`);
          return item;
        },
        async (prev, item) => {
          order.push(`s2:${item as string}`);
          return prev;
        },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    // The fast item cleared BOTH stages while the slow item is still gated in
    // stage 1 — proof there is no inter-stage barrier.
    expect(order).toEqual(['s1:fast', 's2:fast']);
    releaseSlow();
    const outcome = await runPromise;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result).toEqual(['slow', 'fast']);
  });
});

describe('maxConcurrency / parallel in-flight gate', () => {
  it('keeps a globally rejected step pending in protocol state and retries after capacity', async () => {
    const base = fakeBackend();
    let spawnAttempts = 0;
    let capacityWaits = 0;
    const backend: WorkflowAgentBackend = {
      ...base.backend,
      spawn: async (input) => {
        spawnAttempts += 1;
        if (spawnAttempts === 1) {
          throw Object.assign(new Error('Agent concurrency limit reached.'), {
            code: 'agent_limit_reached' as const,
            retryable: true as const,
          });
        }
        return base.backend.spawn(input);
      },
      waitForAgentCapacity: async () => {
        capacityWaits += 1;
        return true;
      },
    };

    const outcome = await runWorkflow(baseOpts(backend), async (wf) => (
      wf.runAgent({ name: 'pending-step', prompt: 'retry after a real slot is released' })
    ));

    expect(outcome.ok).toBe(true);
    expect(spawnAttempts).toBe(2);
    expect(capacityWaits).toBe(1);
    expect(base.spawnCount()).toBe(1);
  });

  it('fails fast on invalid maxConcurrency instead of hanging spawned agents', async () => {
    const { backend, spawnCount } = fakeBackend();
    const outcome = await runWorkflow(
      baseOpts(backend, { limits: { maxConcurrency: 0 } }),
      async (wf) => {
        await wf.runAgent({ name: 'a', prompt: 'x' });
        return 'unreached';
      },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(WorkflowLimitError);
    expect(spawnCount()).toBe(0);
  });

  it('never exceeds maxConcurrency simultaneously in flight', async () => {
    const { backend, peakInFlight } = fakeBackend({ waitDelayMs: 5 });
    const outcome = await runWorkflow(
      baseOpts(backend, { limits: { maxConcurrency: 2 } }),
      async (wf) => {
        await wf.parallel(
          Array.from({ length: 6 }, (_unused, i) => () => wf.runAgent({ name: `a${i}`, prompt: 'x' })),
        );
        return 'ok';
      },
    );
    expect(outcome.ok).toBe(true);
    expect(peakInFlight()).toBeLessThanOrEqual(2);
  });

  it('parallel(opts.concurrency) clamps below maxConcurrency', async () => {
    const { backend, peakInFlight } = fakeBackend({ waitDelayMs: 5 });
    await runWorkflow(baseOpts(backend, { limits: { maxConcurrency: 8 } }), async (wf) => {
      await wf.parallel(
        Array.from({ length: 6 }, (_unused, i) => () => wf.runAgent({ name: `a${i}`, prompt: 'x' })),
        { concurrency: 2 },
      );
      return 'ok';
    });
    expect(peakInFlight()).toBeLessThanOrEqual(2);
  });

  it('defaults an unset maxConcurrency to the resolved ceiling (8), not Infinity', async () => {
    // Defence in depth: a runtime built with no maxConcurrency (bypassing the
    // coding-layer clamp) must fall back to resolveWorkflowMaxConcurrency() (8),
    // not Infinity. Without the fallback, all 12 items would run at once.
    const { backend, peakInFlight } = fakeBackend({ waitDelayMs: 5 });
    await runWorkflow(baseOpts(backend, { limits: {} }), async (wf) => {
      await wf.parallel(
        Array.from({ length: 12 }, (_unused, i) => () => wf.runAgent({ name: `a${i}`, prompt: 'x' })),
      );
      return 'ok';
    });
    expect(peakInFlight()).toBeLessThanOrEqual(8);
    expect(peakInFlight()).toBeGreaterThan(4); // proves real concurrency, capped — not serialized
  });

  it('rejects invalid parallel concurrency', async () => {
    const { backend } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend), async (wf) => {
      await wf.parallel([() => Promise.resolve('a')], { concurrency: 0 });
      return 'unreached';
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(WorkflowLimitError);
  });

  it('parallel preserves result order by index', async () => {
    const { backend } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend), async (wf) => {
      return wf.parallel([
        () => Promise.resolve('a'),
        () => Promise.resolve('b'),
        () => Promise.resolve('c'),
      ]);
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result).toEqual(['a', 'b', 'c']);
  });

  it('rejects an oversized parallel array up front with a clear WorkflowLimitError', async () => {
    const { backend } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend), async (wf) => {
      // 4097 > WORKFLOW_MAX_FANOUT_ITEMS (4096) — the thunks never run.
      await wf.parallel(Array.from({ length: 4097 }, () => () => Promise.resolve('x')));
      return 'unreached';
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(WorkflowLimitError);
      expect(String((outcome.error as Error).message)).toContain('4096-item limit');
    }
  });

  it('rejects an oversized pipeline array up front with a clear WorkflowLimitError', async () => {
    const { backend } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend), async (wf) => {
      await wf.pipeline!(
        Array.from({ length: 4097 }, (_unused, i) => i),
        (n: unknown) => n,
      );
      return 'unreached';
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(WorkflowLimitError);
      expect(String((outcome.error as Error).message)).toContain('4096-item limit');
    }
  });

  it('parallel drops an ordinary throwing thunk to null and keeps siblings (FEATURE_246 Part E)', async () => {
    const { backend } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend), async (wf) => {
      const results = await wf.parallel([
        () => Promise.resolve('a'),
        () => Promise.reject(new Error('boom')),
        () => Promise.resolve('c'),
      ]);
      return results; // null in the middle slot; the call itself never rejects
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toEqual(['a', null, 'c']);
      expect((outcome.result as unknown[]).filter(Boolean)).toEqual(['a', 'c']);
    }
  });

  it('gates bare spawnAgent until the matching wait releases capacity', async () => {
    const { backend, peakInFlight } = fakeBackend({ waitDelayMs: 5 });
    const outcome = await runWorkflow(
      baseOpts(backend, { limits: { maxConcurrency: 2 } }),
      async (wf) => {
        await Promise.all(
          Array.from({ length: 6 }, async (_unused, i) => {
            const handle = await wf.spawnAgent({ name: `bare-${i}`, prompt: 'x' });
            return wf.wait(handle.taskId);
          }),
        );
        return 'ok';
      },
    );

    expect(outcome.ok).toBe(true);
    expect(peakInFlight()).toBeLessThanOrEqual(2);
  });

  it('fails fast instead of soft-deadlocking behind an un-waited spawnAgent handle', async () => {
    const { backend, stoppedTaskIds } = fakeBackend();
    const outcomeOrTimeout = await Promise.race([
      runWorkflow(
        baseOpts(backend, { limits: { maxConcurrency: 1 } }),
        async (wf) => {
          await wf.spawnAgent({ name: 'left-running', prompt: 'keep working' });
          await wf.parallel([
            () => wf.runAgent({ name: 'blocked-behind-left-running', prompt: 'x' }),
          ]);
          return 'unreached';
        },
      ),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);

    expect(outcomeOrTimeout).not.toBe('timeout');
    if (outcomeOrTimeout !== 'timeout') {
      expect(outcomeOrTimeout.ok).toBe(false);
      if (!outcomeOrTimeout.ok) expect(outcomeOrTimeout.error).toBeInstanceOf(WorkflowLimitError);
    }
    expect(stoppedTaskIds()).toEqual(['task-1']);
  });
});

describe('abort handling', () => {
  it('runAgent throws WorkflowAbortError when signal is already aborted', async () => {
    const { backend, spawnCount } = fakeBackend();
    const controller = new AbortController();
    controller.abort();
    const outcome = await runWorkflow(
      baseOpts(backend, { signal: controller.signal }),
      async (wf) => {
        await wf.runAgent({ name: 'a', prompt: 'x' });
        return 'unreached';
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(WorkflowAbortError);
    expect(spawnCount()).toBe(0);
  });

  it('propagates a mid-run abort to the in-flight child via backend.stop', async () => {
    const controller = new AbortController();
    const stopped: string[] = [];
    const backend: WorkflowAgentBackend = {
      spawn: async (input) => ({ taskId: 't1', name: input.name }),
      // wait blocks until the run aborts, then resolves as 'stopped'.
      wait: (taskId) =>
        new Promise((resolve) => {
          controller.signal.addEventListener(
            'abort',
            () => resolve({ taskId, name: taskId, status: 'stopped', finalText: '' }),
            { once: true },
          );
        }),
      output: async (taskId) => ({ taskId, name: taskId, status: 'running' }),
      send: async () => {},
      stop: async (taskId) => { stopped.push(taskId); },
    };
    const outcome = await runWorkflow(
      baseOpts(backend, { signal: controller.signal }),
      async (wf) => {
        const handlePromise = wf.runAgent({ name: 'a', prompt: 'x' });
        setTimeout(() => controller.abort(), 5);
        return handlePromise;
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(WorkflowAbortError);
    expect(stopped).toEqual(['t1']); // abort reached the in-flight child
  });

  it('parallel stops launching new thunks after abort fires mid-run', async () => {
    const { backend } = fakeBackend();
    const controller = new AbortController();
    let launched = 0;
    const outcome = await runWorkflow(
      baseOpts(backend, { signal: controller.signal, limits: { maxConcurrency: 1 } }),
      async (wf) => {
        await wf.parallel(
          Array.from({ length: 5 }, (_unused, i) => async () => {
            launched += 1;
            if (i === 1) controller.abort();
            await Promise.resolve();
            return i;
          }),
        );
        return 'ok';
      },
    );
    expect(outcome.ok).toBe(false);
    expect(launched).toBeLessThan(5); // abort prevented remaining launches
  });

  it('propagates a mid-run abort to a bare spawnAgent waiter', async () => {
    const controller = new AbortController();
    const stopped: string[] = [];
    const backend: WorkflowAgentBackend = {
      spawn: async (input) => ({ taskId: 'bare-1', name: input.name }),
      wait: () => new Promise<WorkflowTaskResult>(() => {}),
      output: async (taskId) => ({ taskId, name: taskId, status: 'running' }),
      send: async () => {},
      stop: async (taskId) => {
        stopped.push(taskId);
      },
    };

    const outcomeOrTimeout = await Promise.race([
      runWorkflow(
        baseOpts(backend, { signal: controller.signal }),
        async (wf) => {
          const handle = await wf.spawnAgent({ name: 'bare', prompt: 'x' });
          setTimeout(() => controller.abort(), 5);
          await wf.wait(handle.taskId);
          return 'unreached';
        },
      ),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);

    expect(outcomeOrTimeout).not.toBe('timeout');
    if (outcomeOrTimeout !== 'timeout') {
      expect(outcomeOrTimeout.ok).toBe(false);
      if (!outcomeOrTimeout.ok) expect(outcomeOrTimeout.error).toBeInstanceOf(WorkflowAbortError);
      expect(outcomeOrTimeout.state.events.some((event) => event.type === 'agent_stopped')).toBe(true);
    }
    expect(stopped).toEqual(['bare-1']);
  });
});

describe('budget accounting + hard stop before new spawns', () => {
  it('accrues output tokens across completed agents', async () => {
    const { backend } = fakeBackend();
    let snapshot: { total: number | null; spent: number; remaining: number } | undefined;
    await runWorkflow(baseOpts(backend, { limits: { tokenBudget: 100 } }), async (wf) => {
      await wf.runAgent({ name: 'a', prompt: 'x' }); // 10 output tokens
      await wf.runAgent({ name: 'b', prompt: 'x' }); // 10 output tokens
      snapshot = { total: wf.budget.total, spent: wf.budget.spent(), remaining: wf.budget.remaining() };
      return 'ok';
    });
    expect(snapshot).toEqual({ total: 100, spent: 20, remaining: 80 });
  });

  it('accrues totalTokens when outputTokens is not provided', async () => {
    const backend: WorkflowAgentBackend = {
      spawn: async (input) => ({ taskId: 'task-total', name: input.name }),
      wait: async (taskId) => ({
        taskId,
        name: 'total',
        status: 'completed',
        finalText: 'done',
        usage: { totalTokens: 25 },
      }),
      output: async (taskId) => ({ taskId, name: taskId, status: 'running' }),
      send: async () => {},
      stop: async () => {},
    };
    let spent = 0;

    await runWorkflow(baseOpts(backend, { limits: { tokenBudget: 100 } }), async (wf) => {
      await wf.runAgent({ name: 'a', prompt: 'x' });
      spent = wf.budget.spent();
      return 'ok';
    });

    expect(spent).toBe(25);
  });

  it('remaining is Infinity when no budget configured', async () => {
    const { backend } = fakeBackend();
    let remaining = 0;
    await runWorkflow(baseOpts(backend), async (wf) => {
      remaining = wf.budget.remaining();
      return 'ok';
    });
    expect(remaining).toBe(Infinity);
  });

  it('throws WorkflowBudgetError before spawning after budget is exhausted', async () => {
    const { backend, spawnCount } = fakeBackend();
    const outcome = await runWorkflow(
      baseOpts(backend, { limits: { tokenBudget: 10 } }),
      async (wf) => {
        await wf.runAgent({ name: 'a', prompt: 'x' }); // spends 10 output tokens
        await wf.runAgent({ name: 'b', prompt: 'x' });
        return 'unreached';
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(WorkflowBudgetError);
    expect(spawnCount()).toBe(1);
  });

  it('rechecks token budget after waiting for concurrency capacity', async () => {
    const { backend, spawnCount } = fakeBackend({ waitDelayMs: 5 });
    const outcome = await runWorkflow(
      baseOpts(backend, { limits: { maxConcurrency: 1, tokenBudget: 10 } }),
      async (wf) => {
        await Promise.all([
          wf.runAgent({ name: 'a', prompt: 'x' }),
          wf.runAgent({ name: 'b', prompt: 'x' }),
        ]);
        return 'unreached';
      },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(WorkflowBudgetError);
    expect(spawnCount()).toBe(1);
  });
});

describe('createWorkflowRuntime — lower-level handle', () => {
  it('exposes api + getState without the run envelope', async () => {
    const { backend } = fakeBackend();
    const onLog: string[] = [];
    const rt = createWorkflowRuntime(baseOpts(backend, { onLog: (e: { message: string }) => onLog.push(e.message) }));
    rt.api.log({ message: 'hello' });
    await rt.api.runAgent({ name: 'a', prompt: 'x' });
    const state = rt.getState();
    expect(state.totalSpawned).toBe(1);
    expect(state.status).toBe('running'); // no envelope sets terminal status
    expect(state.events.find((event) => event.type === 'workflow_log')).toMatchObject({
      data: { message: 'hello' },
    });
    expect(onLog).toEqual(['hello']);
  });

  it('artifact() records a ref and emits artifact_written', async () => {
    const { backend } = fakeBackend();
    const rt = createWorkflowRuntime(baseOpts(backend));
    const ref = await rt.api.artifact('report', { k: 1 });
    expect(ref.name).toBe('report');
    expect(rt.getState().artifacts).toHaveLength(1);
    expect(rt.getState().events.some((e) => e.type === 'artifact_written')).toBe(true);
  });

  it('synthesize runs as a gated agent (counts toward totalSpawned + emits event)', async () => {
    const { backend } = fakeBackend();
    const rt = createWorkflowRuntime(baseOpts(backend));
    const result = await rt.api.synthesize({ inputs: ['a', 'b'], rubric: 'r' });
    expect(typeof result.text).toBe('string');
    expect(rt.getState().totalSpawned).toBe(1); // synthesize spawned one agent
    expect(rt.getState().events.some((e) => e.type === 'synthesis_completed')).toBe(true);
    expect(rt.getState().events.some((e) => e.type === 'agent_spawned')).toBe(true);
  });

  it('synthesize accepts named input objects generated by dynamic workflows', async () => {
    const seenPrompts: string[] = [];
    const { backend } = fakeBackend();
    const rt = createWorkflowRuntime(baseOpts({
      ...backend,
      spawn: async (input: WorkflowSpawnAgentInput) => {
        seenPrompts.push(input.prompt);
        return await backend.spawn(input);
      },
    }));

    const result = await rt.api.synthesize({
      inputs: {
        investigation: 'first finding',
        verification: { risk: 'confirmed' },
      },
      rubric: 'merge findings',
    });

    expect(result.text).toBe('done');
    expect(rt.getState().totalSpawned).toBe(1);
    expect(seenPrompts[0]).toContain('"name": "investigation"');
    expect(seenPrompts[0]).toContain('first finding');
    expect(seenPrompts[0]).toContain('"risk": "confirmed"');
  });

  it('synthesize accepts already-formatted text generated by dynamic workflows', async () => {
    const seenPrompts: string[] = [];
    const { backend } = fakeBackend();
    const rt = createWorkflowRuntime(baseOpts({
      ...backend,
      spawn: async (input: WorkflowSpawnAgentInput) => {
        seenPrompts.push(input.prompt);
        return await backend.spawn(input);
      },
    }));

    const combined = [
      '## control-sense-reviewer',
      'Users need bounded child summaries.',
      '',
      '## feedback-auditor',
      'The live surface needs clearer progress.',
    ].join('\n');

    const result = await rt.api.synthesize({
      inputs: combined,
      rubric: 'merge findings',
    });

    expect(result.text).toBe('done');
    expect(rt.getState().totalSpawned).toBe(1);
    expect(seenPrompts[0]).toContain('## Input 1');
    expect(seenPrompts[0]).toContain('## control-sense-reviewer');
    expect(seenPrompts[0]).toContain('The live surface needs clearer progress.');
  });
});

describe('nested workflow() (FEATURE_246 Part E)', () => {
  const sub = (run: WorkflowModule['run']): WorkflowModule => ({
    meta: { name: 'sub', description: 'a sub-workflow' },
    run,
  });

  it('runs a resolved sub-workflow under the SAME runtime (shared agent counter + args)', async () => {
    const { backend } = fakeBackend();
    const subModule = sub(async (wf, args) => {
      const r = await wf.runAgent({ name: 'sub-agent', prompt: 'x' });
      return { fromSub: true, arg: (args as { k?: string } | undefined)?.k, agent: r?.finalText };
    });
    const outcome = await runWorkflow(
      baseOpts(backend, { resolveWorkflowModule: (name: string) => (name === 'sub' ? subModule : undefined) }),
      async (wf) => {
        await wf.runAgent({ name: 'parent', prompt: 'p' });
        const subResult = await wf.workflow!('sub', { k: 'v' });
        return subResult;
      },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result).toMatchObject({ fromSub: true, arg: 'v' });
    // The sub-workflow's agent shares the parent run's counter (1 parent + 1 sub).
    expect(outcome.state.totalSpawned).toBe(2);
  });

  it('is one level only — a sub-workflow calling workflow() throws', async () => {
    const { backend } = fakeBackend();
    const subModule = sub(async (wf) => {
      await wf.workflow!('sub', {});
      return 'unreached';
    });
    const outcome = await runWorkflow(
      baseOpts(backend, { resolveWorkflowModule: (name: string) => (name === 'sub' ? subModule : undefined) }),
      async (wf) => wf.workflow!('sub', {}),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toContain('one level only');
  });

  it('throws a clear error for an unknown workflow name', async () => {
    const { backend } = fakeBackend();
    const outcome = await runWorkflow(
      baseOpts(backend, { resolveWorkflowModule: () => undefined }),
      async (wf) => wf.workflow!('does-not-exist', {}),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toContain('not found');
  });

  it('does not expose wf.workflow when no resolver is wired', async () => {
    const { backend } = fakeBackend();
    const outcome = await runWorkflow(baseOpts(backend), async (wf) => typeof wf.workflow);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result).toBe('undefined');
  });
});

describe('content-addressed resume cache (FEATURE_246 Part D)', () => {
  const memCache = () => {
    const mem = new Map<string, WorkflowTaskResult>();
    return {
      mem,
      cache: { get: (k: string) => mem.get(k), set: (k: string, v: WorkflowTaskResult) => void mem.set(k, v) },
    };
  };
  const countingBackend = (status: WorkflowTaskResult['status'] = 'completed') => {
    let spawns = 0;
    const backend: WorkflowAgentBackend = {
      spawn: async (input) => {
        spawns += 1;
        return { taskId: `t${spawns}`, name: input.name };
      },
      wait: async (taskId) => ({ taskId, name: 'w', status, finalText: `result:${taskId}` }),
      output: async (taskId) => ({ taskId, name: 'w', status: 'running' }),
      send: async () => {},
      stop: async () => {},
    };
    return { backend, spawns: () => spawns };
  };

  it('replays unchanged effects from a seeded cache on re-run (0 new spawns, same results)', async () => {
    const { cache } = memCache();
    const script = async (wf: import('./index.js').WorkflowApi) => {
      const a = await wf.runAgent({ name: 'a', prompt: 'PA' });
      const b = await wf.runAgent({ name: 'b', prompt: 'PB' });
      return [a?.finalText, b?.finalText];
    };
    const first = countingBackend();
    const o1 = await runWorkflow(baseOpts(first.backend, { resultCache: cache }), script);
    expect(o1.ok).toBe(true);
    expect(first.spawns()).toBe(2);

    // Re-run the SAME script with the SAME (now-seeded) cache: no new spawns.
    const second = countingBackend();
    const o2 = await runWorkflow(baseOpts(second.backend, { resultCache: cache }), script);
    expect(second.spawns()).toBe(0);
    if (o1.ok && o2.ok) expect(o2.result).toEqual(o1.result);
    // FEATURE_246 resume telemetry: each cache hit emits one agent_replayed event
    // (so the process snapshot can render "N/M replayed from cache").
    const replayed = o2.state.events.filter((e) => e.type === 'agent_replayed');
    expect(replayed).toHaveLength(2);
    expect(replayed.map((e) => e.data?.name).sort()).toEqual(['a', 'b']);
    // A fresh run (o1, empty cache) never replays.
    expect(o1.state.events.some((e) => e.type === 'agent_replayed')).toBe(false);
  });

  it('re-runs only the effect whose input changed (content-addressed, not prefix)', async () => {
    const { cache } = memCache();
    const first = countingBackend();
    await runWorkflow(baseOpts(first.backend, { resultCache: cache }), async (wf) => {
      await wf.runAgent({ name: 'a', prompt: 'PA' });
      await wf.runAgent({ name: 'b', prompt: 'PB' });
      return null;
    });
    // Edit only the FIRST effect's prompt; the second is unchanged → cached.
    const second = countingBackend();
    await runWorkflow(baseOpts(second.backend, { resultCache: cache }), async (wf) => {
      await wf.runAgent({ name: 'a', prompt: 'PA-edited' });
      await wf.runAgent({ name: 'b', prompt: 'PB' });
      return null;
    });
    expect(second.spawns()).toBe(1); // only the edited effect re-ran
  });

  it('disambiguates identical inputs by occurrence (two distinct cached results)', async () => {
    const { mem, cache } = memCache();
    const { backend } = countingBackend();
    const outcome = await runWorkflow(baseOpts(backend, { resultCache: cache }), async (wf) => {
      const a = await wf.runAgent({ name: 'x', prompt: 'SAME' });
      const b = await wf.runAgent({ name: 'x', prompt: 'SAME' });
      return [a?.finalText, b?.finalText];
    });
    expect(mem.size).toBe(2);
    if (outcome.ok) expect(outcome.result[0]).not.toEqual(outcome.result[1]);
  });

  it('does not cache a failed child (it re-runs live next time)', async () => {
    const { mem, cache } = memCache();
    const { backend } = countingBackend('failed');
    await runWorkflow(baseOpts(backend, { resultCache: cache }), async (wf) => {
      const r = await wf.runAgent({ name: 'a', prompt: 'P' });
      return r; // null (failed)
    });
    expect(mem.size).toBe(0);
  });
});
