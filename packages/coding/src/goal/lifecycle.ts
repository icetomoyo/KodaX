/**
 * FEATURE_192 v0.7.44 Phase B — Goal lifecycle hook composer.
 *
 * Wraps the existing `Runner.run` lifecycle hooks (`beforeNextTurn`,
 * `stopHook`) with goal-aware behaviour. Does NOT modify substrate —
 * the agent runtime exposes `beforeNextTurn` (FEATURE_164 v0.7.41) and
 * `stopHook` (FEATURE_184 v0.7.42) as already-stable hook surfaces;
 * this module is a thin composer the caller (REPL / driver) opts into.
 *
 * Wiring:
 *   - turn-end accounting → `beforeNextTurn` (fires after each tool
 *     execution, before the next LLM call)
 *   - agent_end continuation → `stopHook` (fires on text-only
 *     termination, can return a continuation prompt to reanimate)
 *
 * `enabled: false` returns pass-through wrappers — useful for hosts
 * that build the binding eagerly but want to no-op when no goal is
 * active. Goal feature ships default ON in v0.7.44; the `enabled`
 * knob is for embedders, not user-facing gating.
 */

import type {
  AgentMessage,
  StopHookContext,
  StopHookFn,
  StopHookResult,
} from '@kodax-ai/agent';
import type { KodaXGoalState } from '@kodax-ai/agent';
import type { KodaXTokenUsage } from '@kodax-ai/llm';
import { applyAccountingDelta } from './state.js';
import { turnWallTimeDelta } from './accounting.js';

/** Capture before a provider call so an in-flight response cannot charge a replacement goal. */
export interface GoalUsageSink {
  (usage: KodaXTokenUsage): void;
  readonly capture?: () => (usage: KodaXTokenUsage) => void;
}

/**
 * Caller-supplied accessors for the goal lifecycle context. The
 * composer does NOT own goal state — it reads via getters and writes
 * via the persist callback. This keeps the composer reentrant and
 * test-friendly (no global mutable cache).
 */
export interface GoalLifecycleContext {
  /** Returns the current goal state, or null when no active goal. */
  readonly getGoal: () => KodaXGoalState | null;
  /**
   * Returns the latest LLM token usage from the just-completed turn.
   * Returns undefined when usage is unavailable (e.g. mid-turn
   * before any LLM call). Optional — accounting is skipped when null.
   */
  readonly getLatestUsage?: () => KodaXTokenUsage | undefined;
  /**
   * Returns the wall-clock timestamp (Date.now() ms) at the start of
   * the turn just completed. The composer pairs this with Date.now()
   * at hook fire time to derive `timeUsedSeconds` delta. Optional —
   * when unset, wall-time is not charged (mirror legacy behaviour;
   * callers without a per-turn clock anchor get token accounting only).
   */
  readonly getTurnStartMs?: () => number | undefined;
  /**
   * Returns the current permission mode. When `'plan'`, accounting is
   * skipped (plan mode runs are not charged against the goal budget).
   * Optional — when not provided, accounting always runs on active goals.
   */
  readonly getPermissionMode?: () => string | undefined;
  /**
   * Persist a goal state transition. Caller wires this to
   * `appendGoalEntry` + session storage. The composer awaits — failures
   * propagate to the runner (deliberate: a broken persist is a real
   * bug worth surfacing, not silently swallowing).
   */
  readonly persistEvent: (
    state: KodaXGoalState | null,
    event: 'updated' | 'budget_limited' | 'complete' | 'blocked',
  ) => Promise<void>;
  /**
   * Build the continuation prompt body the stop-hook returns when the
   * active goal should resume. Caller controls the prompt content so
   * the same composer works for both Codex-parity literal continuation
   * and any future variants.
   */
  readonly buildContinuationPrompt: (goal: KodaXGoalState) => string;
  /**
   * Returns true when the queue has pending user-priority messages.
   * When pending messages exist, the goal SHOULD NOT autonomously
   * continue — the user is steering and the next turn will pick up
   * their input naturally. Optional — defaults to "no pending".
   */
  readonly hasPendingUserInput?: () => boolean;
  /**
   * Records one descendant Agent provider call against the active goal.
   * Never persists: descendants run concurrently with the root, so the
   * root folds the pending total in at its own settlement point.
   */
  readonly chargeDescendantUsage?: GoalUsageSink;
  /** Reads the descendant tokens pending for `goalId` without consuming them. */
  readonly getDescendantTokens?: (goalId: string) => number;
  /** Acknowledge only the amount included in a successful journal write. */
  readonly acknowledgeDescendantTokens?: (goalId: string, tokens: number) => void;
}

interface BeforeNextTurnFnCtx {
  readonly transcript: readonly AgentMessage[];
  readonly iteration: number;
  readonly lastTurnToolNames?: readonly string[];
}

type BeforeNextTurnFn = (ctx: BeforeNextTurnFnCtx) => Promise<readonly AgentMessage[]>;

/**
 * Wrap an existing `beforeNextTurn` callback with goal accounting.
 * Returned hook:
 *   1. Calls into the goal lifecycle ctx FIRST (read latest usage,
 *      apply token delta, persist on budget cross)
 *   2. Delegates to the inner hook for the original behaviour
 *      (mid-turn user-prompt injection, etc.)
 *
 * Errors thrown by `persistEvent` propagate. Errors from `inner` also
 * propagate. We don't swallow either — goal lifecycle bugs are real.
 */
export function withGoalBeforeNextTurn(
  ctx: GoalLifecycleContext,
  inner: BeforeNextTurnFn,
  options: { enabled: boolean } = { enabled: true },
): BeforeNextTurnFn {
  if (!options.enabled) return inner;
  return async (turnCtx) => {
    // Read fresh goal state at fire time. We intentionally do NOT
    // cache across the await — any REPL command (pause/resume/clear)
    // that ran between the previous turn-end and this one MUST be
    // observed here, not by an earlier snapshot.
    const goal = ctx.getGoal();
    if (goal && goal.status === 'active') {
      const mode = ctx.getPermissionMode?.();
      if (mode !== 'plan') {
        const usage = ctx.getLatestUsage?.();
        const descendantTokens = ctx.getDescendantTokens?.(goal.id) ?? 0;
        if (usage || descendantTokens > 0) {
          const turnStartMs = ctx.getTurnStartMs?.();
          const wallSeconds =
            turnStartMs !== undefined
              ? turnWallTimeDelta(turnStartMs, Date.now())
              : 0;
          const result = applyAccountingDelta(goal, usage, wallSeconds, Date.now(),
            descendantTokens);
          // Persist whenever the state moved — otherwise the per-turn
          // delta is lost and `/goal status` shows 0 tokens / 0 seconds
          // until the budget actually trips. The event kind reflects
          // whether the budget threshold was just crossed:
          //   - budget_limited: this turn's delta crossed `tokenBudget`
          //   - updated:        regular per-turn accounting, status unchanged
          // We skip the persist entirely when `nextState === goal`
          // (delta was zero) so a quiet turn doesn't append a noop
          // entry to the lineage.
          if (result.nextState !== goal) {
            await ctx.persistEvent(
              result.nextState,
              result.budgetLimited ? 'budget_limited' : 'updated',
            );
            ctx.acknowledgeDescendantTokens?.(goal.id, descendantTokens);
          }
        }
      }
    }
    return inner(turnCtx);
  };
}

/**
 * Wrap an existing `stopHook` with goal-driven continuation.
 *
 * Returned hook fires the extension Stop hook first; its reanimate or abort decision takes precedence. If the inner hook returns `undefined` AND
 * there's an active goal AND no pending user input, the wrapper
 * returns a continuation string so the Runner reanimates the loop —
 * Codex `/goal` parity.
 *
 * Budget exhaustion semantics: when the active goal has already
 * flipped to `budget_limited`, the wrapper does NOT continue. The user
 * must explicitly resume (`/goal resume`) or set a new budget.
 *
 * Reanimate budget: the Runner caps reanimate via
 * `stopHookReanimateBudget` (default 2). The composer does not need to
 * track its own budget — exceeding the budget is converted by the
 * Runner to an abort with reason "reanimate budget exhausted", which
 * surfaces to the user.
 */
export function withGoalStopHook(
  ctx: GoalLifecycleContext,
  inner: StopHookFn | undefined,
  options: { enabled: boolean } = { enabled: true },
): StopHookFn {
  if (!options.enabled) {
    return inner ?? (async () => undefined);
  }
  return async (stopCtx: StopHookContext): Promise<StopHookResult> => {
    if (inner) {
      const innerResult = await inner(stopCtx);
      if (innerResult !== undefined) return innerResult;
    }
    const goal = ctx.getGoal();
    if (!goal) return undefined;
    if (goal.status !== 'active') return undefined;
    if (ctx.hasPendingUserInput?.()) return undefined;
    return ctx.buildContinuationPrompt(goal);
  };
}
