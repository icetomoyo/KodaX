/**
 * Unit tests for `buildRunnerGoalAdapter` — the runner-driven goal
 * lifecycle adapter that owns the composition of FEATURE_164 base
 * drain + FEATURE_192 goal accounting/continuation + FEATURE_123
 * per-turn flood counter reset.
 */

import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { GoalRuntimeBinding } from '../goal/runtime-wiring.js';
import { buildRunnerGoalAdapter } from './runner-goal-adapter.js';

function makeTokenStateRef() {
  return { current: { lastUsage: undefined } };
}

function makeBaseCtx() {
  return { sendMessageTurnCounter: { count: 0 } };
}

const NOOP_STOP_HOOK = async () => undefined;

const NOOP_BEFORE_NEXT_TURN = async () => [] as readonly { role: 'user'; content: string }[];

describe('buildRunnerGoalAdapter — no goal runtime', () => {
  it('returns base drain unchanged when goalRuntime is undefined', async () => {
    const base = vi.fn(async () => [
      { role: 'user' as const, content: 'drained-msg' },
    ]);
    const { beforeNextTurn } = buildRunnerGoalAdapter({
      goalRuntime: undefined,
      tokenStateRef: makeTokenStateRef(),
      baseCtx: makeBaseCtx(),
      baseBeforeNextTurn: base,
      composedStopHook: NOOP_STOP_HOOK,
    });
    const result = await beforeNextTurn({ transcript: [], iteration: 0 });
    expect(base).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ role: 'user', content: 'drained-msg' }]);
  });

  it('returns composedStopHook unchanged when goalRuntime is undefined', async () => {
    const inner = vi.fn(async () => 'inner says retry');
    const { stopHook } = buildRunnerGoalAdapter({
      goalRuntime: undefined,
      tokenStateRef: makeTokenStateRef(),
      baseCtx: makeBaseCtx(),
      baseBeforeNextTurn: NOOP_BEFORE_NEXT_TURN,
      composedStopHook: inner,
    });
    const r = await stopHook({
      transcript: [],
      lastAssistantText: '',
      signal: { aborted: false } as AbortSignal,
      reanimateCount: 0,
      reanimateBudget: 3,
    });
    expect(inner).toHaveBeenCalled();
    expect(r).toBe('inner says retry');
  });
});

describe('buildRunnerGoalAdapter — FEATURE_123 counter reset', () => {
  it('resets sendMessageTurnCounter.count to 0 after beforeNextTurn fires (no goal)', async () => {
    const baseCtx = { sendMessageTurnCounter: { count: 5 } };
    const { beforeNextTurn } = buildRunnerGoalAdapter({
      goalRuntime: undefined,
      tokenStateRef: makeTokenStateRef(),
      baseCtx,
      baseBeforeNextTurn: NOOP_BEFORE_NEXT_TURN,
      composedStopHook: NOOP_STOP_HOOK,
    });
    await beforeNextTurn({ transcript: [], iteration: 0 });
    expect(baseCtx.sendMessageTurnCounter.count).toBe(0);
  });

  it('does nothing when sendMessageTurnCounter is unset (sync-mode dispatch)', async () => {
    const baseCtx = {}; // no counter
    const { beforeNextTurn } = buildRunnerGoalAdapter({
      goalRuntime: undefined,
      tokenStateRef: makeTokenStateRef(),
      baseCtx,
      baseBeforeNextTurn: NOOP_BEFORE_NEXT_TURN,
      composedStopHook: NOOP_STOP_HOOK,
    });
    // Just shouldn't throw.
    await expect(
      beforeNextTurn({ transcript: [], iteration: 0 }),
    ).resolves.toEqual([]);
  });
});

describe('buildRunnerGoalAdapter — goal runtime wrap', () => {
  type GoalState = ReturnType<GoalRuntimeBinding['lifecycleCtx']['getGoal']>;

  function activeGoal(): NonNullable<GoalState> {
    return {
      id: 'g1',
      objective: 'finish the work',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tokensUsed: 0,
      tokenBudget: null,
      timeUsedSeconds: 0,
      budgetLimited: false,
      blockerTurnCount: 0,
      lastBlockerKind: null,
    };
  }

  function makeGoalRuntime(overrides?: {
    getGoal?: () => GoalState;
    persistEvent?: GoalRuntimeBinding['lifecycleCtx']['persistEvent'];
  }): GoalRuntimeBinding {
    return {
      goalContext: {
        readGoal: async () => null,
        createGoal: async () => {
          throw new Error('not implemented');
        },
        requestComplete: async () => ({ ok: false, reason: 'no goal' }),
        requestBlocked: async () => ({
          ok: false,
          statusMessage: 'no goal',
          counter: { current: 0, required: 3 },
        }),
      },
      lifecycleCtx: {
        getGoal: overrides?.getGoal ?? (() => null),
        persistEvent: overrides?.persistEvent ?? (async () => {}),
        buildContinuationPrompt: () => 'CONTINUE',
        getLatestUsage: () => undefined,
        getTurnStartMs: () => undefined,
        hasPendingUserInput: () => false,
      },
    };
  }

  it('preserves the latest tool names through the goal lifecycle wrapper', async () => {
    const base = vi.fn(async () => []);
    const { beforeNextTurn } = buildRunnerGoalAdapter({
      goalRuntime: makeGoalRuntime({ getGoal: () => activeGoal() }),
      tokenStateRef: makeTokenStateRef(),
      baseCtx: makeBaseCtx(),
      baseBeforeNextTurn: base,
      composedStopHook: NOOP_STOP_HOOK,
    });

    await beforeNextTurn({
      transcript: [],
      iteration: 0,
      lastTurnToolNames: ['wait_agent'],
    });

    expect(base).toHaveBeenCalledWith(expect.objectContaining({
      lastTurnToolNames: ['wait_agent'],
    }));
  });

  it('advances turnStartMsRef after every beforeNextTurn fire so next-turn wall-time delta starts fresh', async () => {
    const recordedTurnStarts: number[] = [];
    const goalRuntime = makeGoalRuntime({
      getGoal: () => activeGoal(),
      persistEvent: async (next) => {
        if (next) recordedTurnStarts.push(next.updatedAt);
      },
    });
    const tokenStateRef = makeTokenStateRef();
    tokenStateRef.current.lastUsage = {
      inputTokens: 50,
      outputTokens: 25,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    } as never;
    const { beforeNextTurn } = buildRunnerGoalAdapter({
      goalRuntime,
      tokenStateRef,
      baseCtx: makeBaseCtx(),
      baseBeforeNextTurn: NOOP_BEFORE_NEXT_TURN,
      composedStopHook: NOOP_STOP_HOOK,
    });
    const t0 = Date.now();
    await beforeNextTurn({ transcript: [], iteration: 0 });
    await new Promise((r) => setTimeout(r, 10));
    await beforeNextTurn({ transcript: [], iteration: 1 });
    expect(recordedTurnStarts.length).toBeGreaterThanOrEqual(2);
    expect(recordedTurnStarts[1]).toBeGreaterThan(recordedTurnStarts[0]);
    expect(recordedTurnStarts[0]).toBeGreaterThanOrEqual(t0);
  });

  it('wrappedStopHook returns continuation prompt when inner returns undefined + goal active', async () => {
    const goalRuntime = makeGoalRuntime({ getGoal: () => activeGoal() });
    const inner = vi.fn(async () => undefined);
    const { stopHook } = buildRunnerGoalAdapter({
      goalRuntime,
      tokenStateRef: makeTokenStateRef(),
      baseCtx: makeBaseCtx(),
      baseBeforeNextTurn: NOOP_BEFORE_NEXT_TURN,
      composedStopHook: inner,
    });
    const r = await stopHook({
      transcript: [],
      lastAssistantText: 'done for now',
      signal: { aborted: false } as AbortSignal,
      reanimateCount: 0,
      reanimateBudget: 3,
    });
    expect(inner).toHaveBeenCalled();
    expect(r).toBe('CONTINUE');
  });

  it('wrappedStopHook returns undefined when goal status is "complete"', async () => {
    const goalRuntime = makeGoalRuntime({
      getGoal: () => ({ ...activeGoal(), status: 'complete' }),
    });
    const { stopHook } = buildRunnerGoalAdapter({
      goalRuntime,
      tokenStateRef: makeTokenStateRef(),
      baseCtx: makeBaseCtx(),
      baseBeforeNextTurn: NOOP_BEFORE_NEXT_TURN,
      composedStopHook: async () => undefined,
    });
    const r = await stopHook({
      transcript: [],
      lastAssistantText: '',
      signal: { aborted: false } as AbortSignal,
      reanimateCount: 0,
      reanimateBudget: 3,
    });
    expect(r).toBeUndefined();
  });

  it('parks for child work before an active goal can reanimate the root', async () => {
    const goalRuntime = makeGoalRuntime({ getGoal: () => activeGoal() });
    const { stopHook } = buildRunnerGoalAdapter({ goalRuntime,
      tokenStateRef: makeTokenStateRef(), baseCtx: makeBaseCtx(),
      baseBeforeNextTurn: NOOP_BEFORE_NEXT_TURN, composedStopHook: NOOP_STOP_HOOK,
      hasPendingWork: () => true,
    });
    expect(await stopHook({ transcript: [], lastAssistantText: 'Waiting.', signal: new AbortController().signal,
      reanimateCount: 0, reanimateBudget: 3 })).toBeUndefined();
  });

  it('wrappedStopHook prefers inner stop hook result when defined (priority over goal continuation)', async () => {
    const goalRuntime = makeGoalRuntime({ getGoal: () => activeGoal() });
    const inner = vi.fn(async () => 'verifier says revise');
    const { stopHook } = buildRunnerGoalAdapter({
      goalRuntime,
      tokenStateRef: makeTokenStateRef(),
      baseCtx: makeBaseCtx(),
      baseBeforeNextTurn: NOOP_BEFORE_NEXT_TURN,
      composedStopHook: inner,
    });
    const r = await stopHook({
      transcript: [],
      lastAssistantText: '',
      signal: { aborted: false } as AbortSignal,
      reanimateCount: 0,
      reanimateBudget: 3,
    });
    expect(r).toBe('verifier says revise');
  });
});
