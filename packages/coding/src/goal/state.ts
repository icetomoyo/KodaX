/**
 * FEATURE_192 v0.7.44 Phase B — Goal state transitions.
 *
 * Pure transition functions over `KodaXGoalState`. Each transition
 * returns a fresh `KodaXGoalState` (immutable update); the caller is
 * responsible for persisting via `appendGoalEntry` from
 * `@kodax-ai/agent`.
 *
 * The runtime path is:
 *   1. REPL slash command (or tool) calls a transition function here
 *   2. Result is passed to `appendGoalEntry(lineage, state, event)`
 *   3. Updated lineage is persisted via the session storage
 *
 * No in-memory singleton: lineage IS the truth, and
 * `readLatestGoalState(lineage)` is the read API. The cost of walking
 * lineage entries per read is bounded (active branches stay small
 * relative to lineage length, and reads are not per-tool-call hot).
 */

import { randomBytes } from 'node:crypto';
import type { KodaXGoalState, KodaXGoalStatus } from '@kodax-ai/agent';
import { goalTokenDelta, shouldFlipBudgetLimited } from './accounting.js';
import type { KodaXTokenUsage } from '@kodax-ai/llm';

function newGoalId(now: number): string {
  // 8 hex chars = 32 bits of entropy — enough to distinguish goals
  // created within the same millisecond on a single-user CLI. Keeping
  // the prefix human-readable (`<ms>-<rand>`) helps debug log diving.
  return `${now}-${randomBytes(4).toString('hex')}`;
}

/**
 * Build a fresh `created` goal state. Caller persists with
 * `appendGoalEntry(lineage, state, 'created')`.
 *
 * Throws when `objective` is empty/whitespace or when `tokenBudget`
 * is a non-positive finite number. `tokenBudget === null` is the
 * canonical "no budget" form.
 */
export function buildCreatedGoal(
  objective: string,
  tokenBudget: number | null,
  now: number = Date.now(),
): KodaXGoalState {
  const trimmed = objective.trim();
  if (trimmed.length === 0) {
    throw new Error('Goal objective must be a non-empty string');
  }
  if (tokenBudget !== null) {
    if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
      throw new Error(
        `Goal tokenBudget must be a positive finite number, got ${tokenBudget}`,
      );
    }
  }
  return Object.freeze({
    version: 1 as const,
    id: newGoalId(now),
    objective: trimmed,
    status: 'active' as KodaXGoalStatus,
    tokenBudget,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    blockerTurnCount: 0,
    lastBlockerKind: null,
    createdAt: now,
    updatedAt: now,
  });
}

interface ApplyAccountingResult {
  readonly nextState: KodaXGoalState;
  /**
   * True when applying this delta crossed the configured budget — the
   * caller persists with `event: 'budget_limited'` instead of skipping
   * persistence. False when budget is null or the delta stayed under.
   */
  readonly budgetLimited: boolean;
}

/**
 * Apply per-turn token + wall-time deltas to an active goal. Returns
 * the updated state (same id, same objective, bumped counters) plus a
 * `budgetLimited` flag the caller uses to decide whether to persist
 * with a status change.
 *
 * Guards:
 *   - Returns nextState unchanged when status !== 'active' (paused /
 *     blocked / complete / budget_limited do not accumulate).
 *   - Token delta = 0 when usage is missing — see accounting.ts.
 *   - Wall-time delta is in whole seconds; sub-second drift is dropped.
 *
 * NOTE: callers must NOT persist a new lineage entry on every turn —
 * we only persist on status transitions. The in-progress accounting
 * lives in memory until the next event. Process exit between turns
 * loses the in-flight delta; that's an accepted tradeoff to keep
 * lineage tidy (every turn writing a goal entry would balloon the
 * file). Re-init from the latest persisted entry on restart.
 */
export function applyAccountingDelta(
  current: KodaXGoalState,
  usage: KodaXTokenUsage | undefined,
  wallTimeDeltaSeconds: number,
  now: number = Date.now(),
): ApplyAccountingResult {
  if (current.status !== 'active') {
    return { nextState: current, budgetLimited: false };
  }
  const tokenDelta = goalTokenDelta(usage);
  const wall = Math.max(0, Math.floor(wallTimeDeltaSeconds));
  if (tokenDelta === 0 && wall === 0) {
    return { nextState: current, budgetLimited: false };
  }
  const budgetLimited = shouldFlipBudgetLimited(
    current.tokensUsed,
    tokenDelta,
    current.tokenBudget,
  );
  const nextState: KodaXGoalState = Object.freeze({
    ...current,
    tokensUsed: current.tokensUsed + tokenDelta,
    timeUsedSeconds: current.timeUsedSeconds + wall,
    status: budgetLimited ? ('budget_limited' as KodaXGoalStatus) : current.status,
    updatedAt: now,
  });
  return { nextState, budgetLimited };
}

/**
 * Transition to `paused`. Allowed only from `active`. Throws on
 * invalid source state so callers learn about the bug instead of
 * silently producing a no-op entry.
 */
export function buildPausedGoal(
  current: KodaXGoalState,
  now: number = Date.now(),
): KodaXGoalState {
  if (current.status !== 'active') {
    throw new Error(
      `Cannot pause goal from status '${current.status}'; only 'active' is pausable.`,
    );
  }
  return Object.freeze({ ...current, status: 'paused', updatedAt: now });
}

/**
 * Transition to `active` from `paused`. The reverse of buildPausedGoal.
 */
export function buildResumedGoal(
  current: KodaXGoalState,
  now: number = Date.now(),
): KodaXGoalState {
  if (current.status !== 'paused') {
    throw new Error(
      `Cannot resume goal from status '${current.status}'; only 'paused' is resumable.`,
    );
  }
  return Object.freeze({ ...current, status: 'active', updatedAt: now });
}

/**
 * Transition to `blocked` with the validated blocker_kind. Caller MUST
 * verify the 3-turn rule via `recordBlockerAttempt` BEFORE invoking
 * this — invoking here unconditionally would let the model rush the
 * blocked state. Throws when called from a non-active source.
 */
export function buildBlockedGoal(
  current: KodaXGoalState,
  blockerKind: string,
  blockerTurnCount: number,
  now: number = Date.now(),
): KodaXGoalState {
  if (current.status !== 'active') {
    throw new Error(
      `Cannot mark goal blocked from status '${current.status}'; only 'active' transitions to 'blocked'.`,
    );
  }
  return Object.freeze({
    ...current,
    status: 'blocked',
    lastBlockerKind: blockerKind,
    blockerTurnCount,
    updatedAt: now,
  });
}

export function buildCompleteGoal(
  current: KodaXGoalState,
  now: number = Date.now(),
): KodaXGoalState {
  if (current.status !== 'active') {
    throw new Error(
      `Cannot mark goal complete from status '${current.status}'; only 'active' transitions to 'complete'.`,
    );
  }
  return Object.freeze({
    ...current,
    status: 'complete',
    updatedAt: now,
  });
}

/**
 * Visible-for-tests: re-export tokenBudget validation so the slash
 * command can pre-validate user input without instantiating a goal.
 */
export function isValidTokenBudget(value: unknown): value is number | null {
  if (value === null) return true;
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
