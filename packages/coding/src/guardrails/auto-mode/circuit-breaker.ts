/**
 * Circuit Breaker — FEATURE_092 Phase 2b.4 (v0.7.33).
 *
 * Sliding-window error counter for classifier failures (timeouts, 5xx, 429,
 * unparseable outputs). When ≥ 5 errors land within a 10-minute window, the
 * auto-mode engine downgrades from `llm` to `rules` (mode stays `auto`) so
 * the user is not blocked by a degraded classifier path.
 *
 * Pure functional API: each operation returns a new breaker. No mutation.
 * Memory bound: stale timestamps are pruned on each recordError call so
 * the timestamps array never grows unbounded.
 */

export const ERROR_THRESHOLD = 5;
export const WINDOW_MS = 10 * 60 * 1000;

export interface CircuitBreaker {
  readonly timestamps: readonly number[];
}

const EMPTY: CircuitBreaker = { timestamps: [] };

export function createCircuitBreaker(): CircuitBreaker {
  return EMPTY;
}

export function recordError(b: CircuitBreaker, now: number): CircuitBreaker {
  const cutoff = now - WINDOW_MS;
  const fresh = b.timestamps.filter((t) => t >= cutoff);
  return { timestamps: [...fresh, now] };
}

export function shouldFallback(b: CircuitBreaker, now: number): boolean {
  const cutoff = now - WINDOW_MS;
  let count = 0;
  for (const t of b.timestamps) {
    if (t >= cutoff) count += 1;
  }
  return count >= ERROR_THRESHOLD;
}
