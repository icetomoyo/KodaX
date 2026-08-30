import { describe, expect, it } from 'vitest';
import {
  createDenialTracker,
  recordBlock,
  recordAllow,
  shouldFallback,
  CONSECUTIVE_THRESHOLD,
  RECENT_DENIAL_THRESHOLD,
  RECENT_WINDOW_SIZE,
} from './denial-tracker.js';

describe('denial-tracker', () => {
  it('initializes with zero counters', () => {
    const t = createDenialTracker();
    expect(t.consecutive).toBe(0);
    expect(t.cumulative).toBe(0);
    expect(t.recent).toEqual([]);
    expect(shouldFallback(t)).toBe(false);
  });

  it('recordBlock increments both consecutive and cumulative', () => {
    let t = createDenialTracker();
    t = recordBlock(t);
    expect(t.consecutive).toBe(1);
    expect(t.cumulative).toBe(1);
    t = recordBlock(t);
    expect(t.consecutive).toBe(2);
    expect(t.cumulative).toBe(2);
  });

  it('recordAllow resets consecutive but preserves cumulative', () => {
    let t = createDenialTracker();
    t = recordBlock(t);
    t = recordBlock(t);
    t = recordAllow(t);
    expect(t.consecutive).toBe(0);
    expect(t.cumulative).toBe(2);
  });

  it('shouldFallback returns true when consecutive threshold reached', () => {
    let t = createDenialTracker();
    for (let i = 0; i < CONSECUTIVE_THRESHOLD; i += 1) {
      t = recordBlock(t);
    }
    expect(shouldFallback(t)).toBe(true);
  });

  it('shouldFallback returns true for 10 denials in the last 50 completed reviews', () => {
    let t = createDenialTracker();
    for (let i = 0; i < RECENT_DENIAL_THRESHOLD; i += 1) {
      t = recordBlock(t);
      t = recordAllow(t);
    }
    expect(shouldFallback(t)).toBe(true);
    expect(t.consecutive).toBeLessThan(CONSECUTIVE_THRESHOLD);
  });

  it('forgets denials that leave the 50-review window', () => {
    let t = createDenialTracker();
    for (let i = 0; i < RECENT_DENIAL_THRESHOLD; i += 1) t = recordBlock(t);
    for (let i = 0; i < RECENT_WINDOW_SIZE; i += 1) t = recordAllow(t);
    expect(t.cumulative).toBe(RECENT_DENIAL_THRESHOLD);
    expect(t.recent).toHaveLength(RECENT_WINDOW_SIZE);
    expect(shouldFallback(t)).toBe(false);
  });

  it('shouldFallback returns false below both thresholds', () => {
    let t = createDenialTracker();
    t = recordBlock(t);
    t = recordAllow(t);
    t = recordBlock(t);
    expect(shouldFallback(t)).toBe(false);
  });

  it('returns a new tracker each time (immutable)', () => {
    const t1 = createDenialTracker();
    const t2 = recordBlock(t1);
    expect(t2).not.toBe(t1);
    expect(t1.cumulative).toBe(0);
    expect(t2.cumulative).toBe(1);
  });

  it('uses the FEATURE_297 denial thresholds', () => {
    expect(CONSECUTIVE_THRESHOLD).toBe(3);
    expect(RECENT_DENIAL_THRESHOLD).toBe(10);
    expect(RECENT_WINDOW_SIZE).toBe(50);
  });
});
