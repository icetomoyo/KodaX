/**
 * Denial Tracker — FEATURE_092 Phase 2b.4 (v0.7.33).
 *
 * Tracks classifier blocks per session. When either threshold is crossed,
 * the auto-mode engine downgrades from `llm` to `rules` (mode stays `auto`).
 *
 *   - 3 consecutive blocks → likely an unproductive loop (agent not adapting)
 *   - 20 cumulative blocks → broader classifier-noise pattern in this session
 *
 * Both are session-scoped, shared with subagents (per design doc, to defend
 * against threshold-bypass via spawning).
 *
 * Pure functional API: each operation returns a new tracker. No mutation.
 */

export const CONSECUTIVE_THRESHOLD = 3;
export const CUMULATIVE_THRESHOLD = 20;

export interface DenialTracker {
  readonly consecutive: number;
  readonly cumulative: number;
}

const EMPTY: DenialTracker = { consecutive: 0, cumulative: 0 };

export function createDenialTracker(): DenialTracker {
  return EMPTY;
}

export function recordBlock(t: DenialTracker): DenialTracker {
  return {
    consecutive: t.consecutive + 1,
    cumulative: t.cumulative + 1,
  };
}

export function recordAllow(t: DenialTracker): DenialTracker {
  if (t.consecutive === 0) return t;
  return {
    consecutive: 0,
    cumulative: t.cumulative,
  };
}

export function shouldFallback(t: DenialTracker): boolean {
  return t.consecutive >= CONSECUTIVE_THRESHOLD || t.cumulative >= CUMULATIVE_THRESHOLD;
}
