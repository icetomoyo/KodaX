import { describe, expect, it } from 'vitest';
import {
  createCircuitBreaker,
  recordError,
  shouldFallback,
  ERROR_THRESHOLD,
  WINDOW_MS,
} from './circuit-breaker.js';

describe('circuit-breaker', () => {
  it('initializes empty', () => {
    const b = createCircuitBreaker();
    expect(b.timestamps).toEqual([]);
    expect(shouldFallback(b, Date.now())).toBe(false);
  });

  it('does not trip below the threshold', () => {
    let b = createCircuitBreaker();
    const now = 1000;
    for (let i = 0; i < ERROR_THRESHOLD - 1; i += 1) {
      b = recordError(b, now);
    }
    expect(shouldFallback(b, now)).toBe(false);
  });

  it('trips when ERROR_THRESHOLD errors fall within the window', () => {
    let b = createCircuitBreaker();
    const now = 10_000;
    for (let i = 0; i < ERROR_THRESHOLD; i += 1) {
      b = recordError(b, now);
    }
    expect(shouldFallback(b, now)).toBe(true);
  });

  it('forgets errors older than WINDOW_MS', () => {
    let b = createCircuitBreaker();
    const t0 = 0;
    for (let i = 0; i < ERROR_THRESHOLD; i += 1) {
      b = recordError(b, t0);
    }
    expect(shouldFallback(b, t0)).toBe(true);

    // Advance past the window — old errors no longer count
    const tAfter = t0 + WINDOW_MS + 1000;
    expect(shouldFallback(b, tAfter)).toBe(false);
  });

  it('trips on 5 errors spread across 10min, then untrips after the window slides past', () => {
    let b = createCircuitBreaker();
    const start = 0;
    // Five errors at t=0, 60s, 120s, 180s, 240s — all within 10min window
    for (let i = 0; i < ERROR_THRESHOLD; i += 1) {
      b = recordError(b, start + i * 60_000);
    }
    expect(shouldFallback(b, start + 5 * 60_000)).toBe(true);

    // At t = 10min + 1s, only 4 errors are still within the trailing window
    expect(shouldFallback(b, start + WINDOW_MS + 1_000)).toBe(false);
  });

  it('discards stale timestamps when recording new errors (memory bound)', () => {
    let b = createCircuitBreaker();
    b = recordError(b, 0);
    b = recordError(b, 1000);
    b = recordError(b, WINDOW_MS + 5000); // first two now stale
    // Implementation should prune; only the recent one remains in storage
    expect(b.timestamps.length).toBeLessThanOrEqual(2);
  });

  it('returns a new breaker each time (immutable)', () => {
    const b1 = createCircuitBreaker();
    const b2 = recordError(b1, 0);
    expect(b2).not.toBe(b1);
    expect(b1.timestamps).toEqual([]);
    expect(b2.timestamps.length).toBeGreaterThan(0);
  });

  it('ERROR_THRESHOLD is 5 and WINDOW_MS is 10 minutes (per design doc)', () => {
    expect(ERROR_THRESHOLD).toBe(5);
    expect(WINDOW_MS).toBe(10 * 60 * 1000);
  });
});
