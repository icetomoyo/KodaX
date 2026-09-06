/**
 * FEATURE_192 v0.7.44 Phase D — /goal slash command unit tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { InteractiveContext } from '../interactive/context.js';
import type { CommandCallbacks } from './types.js';
import {
  appendGoalEntry,
  readLatestGoalState,
  type KodaXGoalState,
  type KodaXSessionLineage,
} from '@kodax-ai/agent';
import { buildCreatedGoal } from '@kodax-ai/coding';
import { goalCommand } from './goal-command.js';

function makeLineage(): KodaXSessionLineage {
  return {
    version: 2,
    activeEntryId: 'm1',
    entries: [
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-05-25T00:00:00.000Z',
        message: { role: 'user', content: 'hello' },
      },
    ],
  };
}

function makeContext(lineage?: KodaXSessionLineage): InteractiveContext {
  return {
    messages: [],
    sessionId: 'test',
    title: 'test',
    createdAt: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
    lineage,
  };
}

function makeCallbacks(): CommandCallbacks {
  return {
    exit: vi.fn(),
    saveSession: vi.fn(async () => undefined),
    loadSession: vi.fn(async () => 'loaded' as const),
    listSessions: vi.fn(async () => undefined),
    clearHistory: vi.fn(),
    printHistory: vi.fn(),
    ui: {} as unknown as CommandCallbacks['ui'],
  };
}

const CONFIG = {
  provider: 'anthropic',
  thinking: false,
  reasoningMode: 'auto' as const,
  agentMode: 'sa' as const,
  permissionMode: 'default' as const,
};

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
});

function output(): string {
  return logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
}

describe('/goal create', () => {
  it('creates a goal and persists', async () => {
    const ctx = makeContext(makeLineage());
    const callbacks = makeCallbacks();
    await goalCommand.handler(['build', 'the', 'thing'], ctx, callbacks, CONFIG);
    expect(output()).toMatch(/created: "build the thing"/);
    expect(callbacks.saveSession).toHaveBeenCalled();
    const goal = readLatestGoalState(ctx.lineage!);
    expect(goal?.objective).toBe('build the thing');
    expect(goal?.status).toBe('active');
    expect(goal?.tokenBudget).toBeNull();
  });

  it('parses --tokens N', async () => {
    const ctx = makeContext(makeLineage());
    await goalCommand.handler(
      ['build', 'the', 'thing', '--tokens', '50000'],
      ctx,
      makeCallbacks(),
      CONFIG,
    );
    const goal = readLatestGoalState(ctx.lineage!);
    expect(goal?.tokenBudget).toBe(50000);
    expect(output()).toMatch(/budget: 50000 tokens/);
  });

  it('parses --tokens=N form', async () => {
    const ctx = makeContext(makeLineage());
    await goalCommand.handler(['x', '--tokens=12345'], ctx, makeCallbacks(), CONFIG);
    const goal = readLatestGoalState(ctx.lineage!);
    expect(goal?.tokenBudget).toBe(12345);
  });

  it('rejects bad --tokens value', async () => {
    const ctx = makeContext(makeLineage());
    await goalCommand.handler(['x', '--tokens', '-5'], ctx, makeCallbacks(), CONFIG);
    expect(output()).toMatch(/--tokens value must be a positive integer/);
    expect(readLatestGoalState(ctx.lineage!)).toBeNull();
  });

  it('rejects unknown flag', async () => {
    const ctx = makeContext(makeLineage());
    await goalCommand.handler(['x', '--magic'], ctx, makeCallbacks(), CONFIG);
    expect(output()).toMatch(/unknown flag: --magic/);
  });

  it('rejects --tokens with no value following', async () => {
    const ctx = makeContext(makeLineage());
    await goalCommand.handler(['x', '--tokens'], ctx, makeCallbacks(), CONFIG);
    expect(output()).toMatch(/--tokens requires a value/);
    expect(readLatestGoalState(ctx.lineage!)).toBeNull();
  });

  it('after a complete goal, create emits a cleared event before the new created entry', async () => {
    const lineage = makeLineage();
    const old = buildCreatedGoal('first goal', null);
    const withOld = appendGoalEntry(lineage, { ...old, status: 'complete' }, 'complete');
    const ctx = makeContext(withOld);
    const callbacks = makeCallbacks();
    await goalCommand.handler(['second', 'goal'], ctx, callbacks, CONFIG);
    expect(output()).toMatch(/created: "second goal"/);
    const goalEntries = ctx.lineage!.entries.filter((e) => e.type === 'goal');
    // 1 complete (pre-existing) + 1 cleared (emitted) + 1 created (new) = 3
    expect(goalEntries.length).toBe(3);
    const events = goalEntries.map((e) => (e as { event: string }).event);
    expect(events).toEqual(['complete', 'cleared', 'created']);
    const latest = readLatestGoalState(ctx.lineage!);
    expect(latest?.objective).toBe('second goal');
    expect(latest?.status).toBe('active');
  });

  it('refuses to create when an active goal already exists', async () => {
    const lineage = makeLineage();
    const created = buildCreatedGoal('existing', null);
    const withGoal = appendGoalEntry(lineage, created, 'created');
    const ctx = makeContext(withGoal);
    const before = readLatestGoalState(ctx.lineage!);
    await goalCommand.handler(['new objective'], ctx, makeCallbacks(), CONFIG);
    expect(output()).toMatch(/goal is already active/);
    const after = readLatestGoalState(ctx.lineage!);
    expect(after?.objective).toBe(before?.objective);
  });
});

describe('/goal status', () => {
  it('says "no goal" when none set', async () => {
    const ctx = makeContext(makeLineage());
    await goalCommand.handler(['status'], ctx, makeCallbacks(), CONFIG);
    expect(output()).toMatch(/No goal set/);
  });

  it('defaults to status when no args', async () => {
    const ctx = makeContext(makeLineage());
    await goalCommand.handler([], ctx, makeCallbacks(), CONFIG);
    expect(output()).toMatch(/No goal set/);
  });

  it('renders status when goal is set', async () => {
    const lineage = makeLineage();
    const goal = buildCreatedGoal('do the thing', 1000);
    const withGoal = appendGoalEntry(lineage, goal, 'created');
    const ctx = makeContext(withGoal);
    await goalCommand.handler(['status'], ctx, makeCallbacks(), CONFIG);
    const out = output();
    expect(out).toMatch(/Goal:/);
    expect(out).toMatch(/do the thing/);
    expect(out).toMatch(/Status:/);
    expect(out).toMatch(/active/);
    expect(out).toMatch(/Token budget:/);
    expect(out).toMatch(/remaining 1000/);
  });
});

describe('/goal pause + resume', () => {
  it('pauses an active goal', async () => {
    const lineage = makeLineage();
    const goal = buildCreatedGoal('x', null);
    const withGoal = appendGoalEntry(lineage, goal, 'created');
    const ctx = makeContext(withGoal);
    const callbacks = makeCallbacks();
    await goalCommand.handler(['pause'], ctx, callbacks, CONFIG);
    expect(output()).toMatch(/paused/);
    expect(readLatestGoalState(ctx.lineage!)?.status).toBe('paused');
    expect(callbacks.saveSession).toHaveBeenCalled();
  });

  it('refuses to pause when no goal exists', async () => {
    const ctx = makeContext(makeLineage());
    await goalCommand.handler(['pause'], ctx, makeCallbacks(), CONFIG);
    expect(output()).toMatch(/no goal to pause/);
  });

  it('refuses to pause from non-active status', async () => {
    const lineage = makeLineage();
    const goal = buildCreatedGoal('x', null);
    const withGoal = appendGoalEntry(lineage, { ...goal, status: 'paused' }, 'paused');
    const ctx = makeContext(withGoal);
    await goalCommand.handler(['pause'], ctx, makeCallbacks(), CONFIG);
    expect(output()).toMatch(/cannot pause from status 'paused'/);
  });

  it('resumes a paused goal', async () => {
    const lineage = makeLineage();
    const goal = buildCreatedGoal('x', null);
    const withGoal = appendGoalEntry(lineage, { ...goal, status: 'paused' }, 'paused');
    const ctx = makeContext(withGoal);
    await goalCommand.handler(['resume'], ctx, makeCallbacks(), CONFIG);
    expect(output()).toMatch(/resumed/);
    expect(readLatestGoalState(ctx.lineage!)?.status).toBe('active');
  });
});

describe('/goal clear', () => {
  it('clears the active goal', async () => {
    const lineage = makeLineage();
    const goal = buildCreatedGoal('x', null);
    const withGoal = appendGoalEntry(lineage, goal, 'created');
    const ctx = makeContext(withGoal);
    await goalCommand.handler(['clear'], ctx, makeCallbacks(), CONFIG);
    expect(output()).toMatch(/cleared/);
    expect(readLatestGoalState(ctx.lineage!)).toBeNull();
  });

  it('says "no goal" when nothing to clear', async () => {
    const ctx = makeContext(makeLineage());
    await goalCommand.handler(['clear'], ctx, makeCallbacks(), CONFIG);
    expect(output()).toMatch(/no goal to clear/);
  });
});

describe('/goal help', () => {
  it('prints help with subcommands', async () => {
    const ctx = makeContext(makeLineage());
    await goalCommand.handler(['help'], ctx, makeCallbacks(), CONFIG);
    const out = output();
    expect(out).toMatch(/\/goal/);
    expect(out).toMatch(/status/);
    expect(out).toMatch(/pause/);
    expect(out).toMatch(/resume/);
    expect(out).toMatch(/clear/);
  });
});

describe('/goal — missing lineage', () => {
  it('surfaces a clear error when no lineage is attached', async () => {
    const ctx = makeContext(undefined);
    await goalCommand.handler(['status'], ctx, makeCallbacks(), CONFIG);
    expect(output()).toMatch(/no active session lineage/);
  });
});

/** FEATURE_298 T34 — goal persistence is Host-owned via the binding. */
describe('/goal Host binding (T34)', () => {
  interface GoalBindingCalls {
    readonly create: ReturnType<typeof vi.fn>;
    readonly pause: ReturnType<typeof vi.fn>;
    readonly resume: ReturnType<typeof vi.fn>;
    readonly clear: ReturnType<typeof vi.fn>;
    readonly read: ReturnType<typeof vi.fn>;
  }

  function makeBinding(goal: KodaXGoalState | null): GoalBindingCalls & {
    readonly goal: CommandCallbacks['goal'];
    readonly state: { goal: KodaXGoalState | null };
  } {
    const state = { goal };
    const calls: GoalBindingCalls = {
      create: vi.fn(async (input: { sessionId: string; objective: string; tokenBudget?: number }) => {
        state.goal = buildCreatedGoal(input.objective, input.tokenBudget ?? null);
        return state.goal;
      }),
      pause: vi.fn(async () => {
        if (state.goal) state.goal = { ...state.goal, status: 'paused' };
        return state.goal!;
      }),
      resume: vi.fn(async () => {
        if (state.goal) state.goal = { ...state.goal, status: 'active' };
        return state.goal!;
      }),
      clear: vi.fn(async () => {
        state.goal = null;
      }),
      read: vi.fn(async () => state.goal),
    };
    return { ...calls, goal: calls, state };
  }

  function boundCallbacks(
    binding: { readonly goal: CommandCallbacks['goal'] },
    extra: Partial<CommandCallbacks> = {},
  ): CommandCallbacks {
    return { ...makeCallbacks(), goal: binding.goal, ...extra };
  }

  it('routes create through the binding without a local lineage write', async () => {
    const ctx = makeContext(makeLineage());
    const lineageBefore = ctx.lineage;
    const binding = makeBinding(null);
    const callbacks = boundCallbacks(binding);
    await goalCommand.handler(['ship', 'it'], ctx, callbacks, CONFIG);
    expect(binding.create).toHaveBeenCalledWith({
      sessionId: 'test',
      objective: 'ship it',
    });
    expect(callbacks.saveSession).not.toHaveBeenCalled();
    expect(ctx.lineage).toBe(lineageBefore);
    expect(output()).toMatch(/created: "ship it"/);
  });

  it('passes the token budget through to the binding', async () => {
    const binding = makeBinding(null);
    await goalCommand.handler(
      ['harden', 'auth', '--tokens', '50000'],
      makeContext(makeLineage()),
      boundCallbacks(binding),
      CONFIG,
    );
    expect(binding.create).toHaveBeenCalledWith({
      sessionId: 'test',
      objective: 'harden auth',
      tokenBudget: 50000,
    });
  });

  it('works without local lineage in bound mode', async () => {
    const binding = makeBinding(null);
    const ctx = makeContext(undefined);
    await goalCommand.handler(['objective'], ctx, boundCallbacks(binding), CONFIG);
    expect(binding.create).toHaveBeenCalled();
    expect(output()).not.toMatch(/no active session lineage/);
  });

  it('clears a complete goal before creating over it', async () => {
    const binding = makeBinding({ ...buildCreatedGoal('done thing', null), status: 'complete' });
    await goalCommand.handler(
      ['next thing'],
      makeContext(makeLineage()),
      boundCallbacks(binding),
      CONFIG,
    );
    expect(binding.clear).toHaveBeenCalledWith('test');
    expect(binding.create).toHaveBeenCalledWith({ sessionId: 'test', objective: 'next thing' });
  });

  it('refuses to create over an active Host goal', async () => {
    const binding = makeBinding(buildCreatedGoal('busy thing', null));
    await goalCommand.handler(
      ['another'],
      makeContext(makeLineage()),
      boundCallbacks(binding),
      CONFIG,
    );
    expect(binding.create).not.toHaveBeenCalled();
    expect(output()).toMatch(/already active/);
  });

  it('reads status from the binding without local lineage', async () => {
    const binding = makeBinding(buildCreatedGoal('observed goal', 1234));
    await goalCommand.handler(['status'], makeContext(undefined), boundCallbacks(binding), CONFIG);
    expect(output()).toMatch(/observed goal/);
    expect(output()).toMatch(/active/);
  });

  it('routes pause/resume/clear through the binding with Host-state guards', async () => {
    const binding = makeBinding(buildCreatedGoal('lifecycle goal', null));

    await goalCommand.handler(['pause'], makeContext(makeLineage()), boundCallbacks(binding), CONFIG);
    expect(binding.pause).toHaveBeenCalledWith('test');
    expect(output()).toMatch(/paused/);

    await goalCommand.handler(['resume'], makeContext(makeLineage()), boundCallbacks(binding), CONFIG);
    expect(binding.resume).toHaveBeenCalledWith('test');
    expect(output()).toMatch(/resumed/);

    await goalCommand.handler(['clear'], makeContext(makeLineage()), boundCallbacks(binding), CONFIG);
    expect(binding.clear).toHaveBeenCalledWith('test');
    expect(output()).toMatch(/cleared/);
  });

  it('refuses to pause when the Host goal is not active', async () => {
    const binding = makeBinding({ ...buildCreatedGoal('paused goal', null), status: 'paused' });
    await goalCommand.handler(['pause'], makeContext(makeLineage()), boundCallbacks(binding), CONFIG);
    expect(binding.pause).not.toHaveBeenCalled();
    expect(output()).toMatch(/cannot pause/);
  });

  it('refreshes local lineage from storage after a bound mutation', async () => {
    const refreshed = makeLineage();
    const binding = makeBinding(null);
    const refreshSessionLineage = vi.fn(async () => refreshed);
    const ctx = makeContext(makeLineage());
    await goalCommand.handler(
      ['refreshed goal'],
      ctx,
      boundCallbacks(binding, { refreshSessionLineage }),
      CONFIG,
    );
    expect(refreshSessionLineage).toHaveBeenCalled();
    expect(ctx.lineage).toBe(refreshed);
  });

  it('keeps the unbound local path intact', async () => {
    const ctx = makeContext(makeLineage());
    const callbacks = makeCallbacks();
    await goalCommand.handler(['local goal'], ctx, callbacks, CONFIG);
    expect(callbacks.saveSession).toHaveBeenCalled();
    const goal = readLatestGoalState(ctx.lineage!);
    expect(goal?.objective).toBe('local goal');
  });
});
