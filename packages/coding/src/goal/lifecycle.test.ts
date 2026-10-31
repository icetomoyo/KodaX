import { describe, it, expect, vi } from 'vitest';
import type {
  AgentMessage,
  KodaXGoalState,
  StopHookContext,
} from '@kodax-ai/agent';
import { buildCreatedGoal } from './state.js';
import {
  withGoalBeforeNextTurn,
  withGoalStopHook,
  type GoalLifecycleContext,
} from './lifecycle.js';

function makeCtx(
  overrides: Partial<GoalLifecycleContext> & {
    goal: KodaXGoalState | null;
  },
): GoalLifecycleContext {
  return {
    getGoal: () => overrides.goal,
    persistEvent: overrides.persistEvent ?? (async () => undefined),
    buildContinuationPrompt:
      overrides.buildContinuationPrompt ?? ((g) => `keep going on ${g.objective}`),
    getLatestUsage: overrides.getLatestUsage,
    getTurnStartMs: overrides.getTurnStartMs,
    getPermissionMode: overrides.getPermissionMode,
    hasPendingUserInput: overrides.hasPendingUserInput,
    takeDescendantTokens: overrides.takeDescendantTokens,
  };
}

const STOP_CTX: StopHookContext = {
  transcript: [],
  lastAssistantText: '',
  signal: 'natural-end',
  reanimateCount: 0,
  reanimateBudget: 2,
};

const TURN_CTX = { transcript: [] as readonly AgentMessage[], iteration: 0 };

describe('withGoalBeforeNextTurn', () => {
  it('passes through to inner when feature disabled', async () => {
    const inner = vi.fn(async () => []);
    const ctx = makeCtx({ goal: null });
    const wrapped = withGoalBeforeNextTurn(ctx, inner, { enabled: false });
    await wrapped(TURN_CTX);
    expect(inner).toHaveBeenCalledOnce();
  });

  it('passes through when no goal is active', async () => {
    const inner = vi.fn(async () => []);
    const ctx = makeCtx({ goal: null });
    const wrapped = withGoalBeforeNextTurn(ctx, inner);
    await wrapped(TURN_CTX);
    expect(inner).toHaveBeenCalledOnce();
  });

  it('skips accounting in plan mode', async () => {
    const inner = vi.fn(async () => []);
    const persist = vi.fn(async () => undefined);
    const ctx = makeCtx({
      goal: buildCreatedGoal('x', 100, 1_700_000_000_000),
      getLatestUsage: () => ({
        inputTokens: 1000,
        outputTokens: 100,
        totalTokens: 1100,
      }),
      getPermissionMode: () => 'plan',
      persistEvent: persist,
    });
    const wrapped = withGoalBeforeNextTurn(ctx, inner);
    await wrapped(TURN_CTX);
    expect(persist).not.toHaveBeenCalled();
    expect(inner).toHaveBeenCalledOnce();
  });

  it('persists budget_limited when token usage crosses budget', async () => {
    const persist = vi.fn(async () => undefined);
    const inner = vi.fn(async () => []);
    const ctx = makeCtx({
      goal: buildCreatedGoal('x', 100, 1_700_000_000_000),
      getLatestUsage: () => ({
        inputTokens: 500,
        outputTokens: 0,
        totalTokens: 500,
      }),
      persistEvent: persist,
    });
    const wrapped = withGoalBeforeNextTurn(ctx, inner);
    await wrapped(TURN_CTX);
    expect(persist).toHaveBeenCalledOnce();
    const [state, event] = persist.mock.calls[0];
    expect(event).toBe('budget_limited');
    expect((state as KodaXGoalState).status).toBe('budget_limited');
  });

  it("persists an 'updated' event on under-budget turns so /goal status reflects per-turn deltas", async () => {
    // Pre-fix-2026-05-27 behavior LOST the per-turn delta on non-flip
    // turns — `applyAccountingDelta` produced a `nextState` with
    // updated `tokensUsed` but the composer skipped persistEvent so
    // the lineage never recorded it; `/goal status` displayed 0 until
    // the budget actually tripped. Fixed by persisting `'updated'`
    // on every active-turn delta > 0 and `'budget_limited'` only on
    // the threshold-crossing turn.
    const persist = vi.fn(async () => undefined);
    const inner = vi.fn(async () => []);
    const ctx = makeCtx({
      goal: buildCreatedGoal('x', 10_000, 1_700_000_000_000),
      getLatestUsage: () => ({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      }),
      persistEvent: persist,
    });
    const wrapped = withGoalBeforeNextTurn(ctx, inner);
    await wrapped(TURN_CTX);
    expect(persist).toHaveBeenCalledTimes(1);
    const [state, event] = persist.mock.calls[0]!;
    expect(event).toBe('updated');
    expect((state as { tokensUsed: number }).tokensUsed).toBe(150);
  });

  it('folds settled descendant tokens into the root turn and can cross the budget', async () => {
    const persist = vi.fn(async () => undefined);
    const goal = buildCreatedGoal('x', 2000, 1_700_000_000_000);
    const takeDescendantTokens = vi.fn((goalId: string) => (goalId === goal.id ? 1900 : 0));
    const ctx = makeCtx({
      goal,
      getLatestUsage: () => ({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
      takeDescendantTokens,
      persistEvent: persist,
    });
    await withGoalBeforeNextTurn(ctx, vi.fn(async () => []))(TURN_CTX);
    expect(takeDescendantTokens).toHaveBeenCalledWith(goal.id);
    const [state, event] = persist.mock.calls[0]!;
    expect(event).toBe('budget_limited');
    expect((state as KodaXGoalState).tokensUsed).toBe(2050);
  });

  it('skips persistEvent entirely on a zero-delta turn (no noop entry in the lineage)', async () => {
    const persist = vi.fn(async () => undefined);
    const inner = vi.fn(async () => []);
    const ctx = makeCtx({
      goal: buildCreatedGoal('x', 10_000, 1_700_000_000_000),
      // No usage reported AND no turnStartMs — both deltas are 0.
      getLatestUsage: () => ({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
      persistEvent: persist,
    });
    const wrapped = withGoalBeforeNextTurn(ctx, inner);
    await wrapped(TURN_CTX);
    expect(persist).not.toHaveBeenCalled();
  });

  it('feeds turnWallTimeDelta into applyAccountingDelta when getTurnStartMs is provided', async () => {
    // We exercise the full path by setting a tiny budget so the wall-time
    // tracked turn flips budget_limited (proving accounting ran with the
    // wall-time field populated). The persisted nextState carries the
    // accumulated timeUsedSeconds.
    const persist = vi.fn(async () => undefined);
    const inner = vi.fn(async () => []);
    const tStart = Date.now() - 5_500; // ~5.5 s before fire
    const ctx = makeCtx({
      goal: buildCreatedGoal('x', 1, 1_700_000_000_000),
      getLatestUsage: () => ({
        inputTokens: 50,
        outputTokens: 0,
        totalTokens: 50,
      }),
      getTurnStartMs: () => tStart,
      persistEvent: persist,
    });
    const wrapped = withGoalBeforeNextTurn(ctx, inner);
    await wrapped(TURN_CTX);
    expect(persist).toHaveBeenCalledOnce();
    const [state] = persist.mock.calls[0];
    expect((state as KodaXGoalState).timeUsedSeconds).toBeGreaterThanOrEqual(5);
    expect((state as KodaXGoalState).timeUsedSeconds).toBeLessThanOrEqual(7);
  });

  it('propagates persistEvent errors', async () => {
    const persist = vi.fn(async () => {
      throw new Error('disk full');
    });
    const inner = vi.fn(async () => []);
    const ctx = makeCtx({
      goal: buildCreatedGoal('x', 1, 1_700_000_000_000),
      getLatestUsage: () => ({
        inputTokens: 100,
        outputTokens: 0,
        totalTokens: 100,
      }),
      persistEvent: persist,
    });
    const wrapped = withGoalBeforeNextTurn(ctx, inner);
    await expect(wrapped(TURN_CTX)).rejects.toThrow(/disk full/);
  });
});

describe('withGoalStopHook', () => {
  it('returns inner result when inner returns non-undefined', async () => {
    const ctx = makeCtx({ goal: buildCreatedGoal('x', null, 1_700_000_000_000) });
    const inner = vi.fn(async () => 'inner says retry');
    const wrapped = withGoalStopHook(ctx, inner);
    const r = await wrapped(STOP_CTX);
    expect(r).toBe('inner says retry');
  });

  it('returns continuation prompt when inner returns undefined + goal active', async () => {
    const goal = buildCreatedGoal('finish refactor', null, 1_700_000_000_000);
    const ctx = makeCtx({ goal });
    const inner = vi.fn(async () => undefined);
    const wrapped = withGoalStopHook(ctx, inner);
    const r = await wrapped(STOP_CTX);
    expect(r).toBe('keep going on finish refactor');
  });

  it('returns undefined when no goal', async () => {
    const ctx = makeCtx({ goal: null });
    const wrapped = withGoalStopHook(ctx, undefined);
    const r = await wrapped(STOP_CTX);
    expect(r).toBeUndefined();
  });

  it('returns undefined when goal is paused / blocked / complete / budget_limited', async () => {
    for (const status of ['paused', 'blocked', 'complete', 'budget_limited'] as const) {
      const goal: KodaXGoalState = {
        ...buildCreatedGoal('x', null, 1_700_000_000_000),
        status,
      };
      const ctx = makeCtx({ goal });
      const wrapped = withGoalStopHook(ctx, undefined);
      const r = await wrapped(STOP_CTX);
      expect(r).toBeUndefined();
    }
  });

  it('returns undefined when hasPendingUserInput is true', async () => {
    const ctx = makeCtx({
      goal: buildCreatedGoal('x', null, 1_700_000_000_000),
      hasPendingUserInput: () => true,
    });
    const wrapped = withGoalStopHook(ctx, undefined);
    const r = await wrapped(STOP_CTX);
    expect(r).toBeUndefined();
  });

  it('feature-disabled wrapper still runs the inner hook', async () => {
    const inner = vi.fn(async () => 'inner');
    const ctx = makeCtx({ goal: buildCreatedGoal('x', null) });
    const wrapped = withGoalStopHook(ctx, inner, { enabled: false });
    const r = await wrapped(STOP_CTX);
    expect(r).toBe('inner');
  });
});
