/**
 * Denial Tracker — FEATURE_092 Phase 2b.4 (v0.7.33).
 *
 * Tracks classifier blocks per session. When either threshold is crossed,
 * threshold state is exposed for diagnostics and does not mutate the selected
 * Auto engine.
 *
 *   - 3 consecutive blocks → likely an unproductive loop (agent not adapting)
 *   - 10 blocks in the last 50 completed reviews → broader review loop
 *
 * Both are session-scoped, shared with subagents (per design doc, to defend
 * against threshold-bypass via spawning).
 *
 * Pure functional API: each operation returns a new tracker. No mutation.
 */

export const CONSECUTIVE_THRESHOLD = 3;
export const RECENT_DENIAL_THRESHOLD = 10;
export const RECENT_WINDOW_SIZE = 50;

export interface DenialTracker {
  readonly consecutive: number;
  /** Lifetime diagnostic only; never trips the breaker by itself. */
  readonly cumulative: number;
  /** Bounded completed-review window. `true` means the reviewer denied. */
  readonly recent?: readonly boolean[];
}

const EMPTY: DenialTracker = { consecutive: 0, cumulative: 0, recent: [] };

function appendReview(t: DenialTracker, denied: boolean): readonly boolean[] {
  return [...(t.recent ?? []), denied].slice(-RECENT_WINDOW_SIZE);
}

export function createDenialTracker(): DenialTracker {
  return EMPTY;
}

export function recordBlock(t: DenialTracker): DenialTracker {
  return {
    consecutive: t.consecutive + 1,
    cumulative: t.cumulative + 1,
    recent: appendReview(t, true),
  };
}

export function recordAllow(t: DenialTracker): DenialTracker {
  return {
    consecutive: 0,
    cumulative: t.cumulative,
    recent: appendReview(t, false),
  };
}

export function shouldFallback(t: DenialTracker): boolean {
  const recentDenials = (t.recent ?? []).filter(Boolean).length;
  return t.consecutive >= CONSECUTIVE_THRESHOLD
    || recentDenials >= RECENT_DENIAL_THRESHOLD;
}
