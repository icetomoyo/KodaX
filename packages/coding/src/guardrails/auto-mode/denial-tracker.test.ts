import { describe, expect, it } from 'vitest';
import {
  createDenialTracker,
  recordBlock,
  recordAllow,
  shouldFallback,
  CONSECUTIVE_THRESHOLD,
  CUMULATIVE_THRESHOLD,
} from './denial-tracker.js';

describe('denial-tracker', () => {
  it('initializes with zero counters', () => {
    const t = createDenialTracker();
    expect(t.consecutive).toBe(0);
    expect(t.cumulative).toBe(0);
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

  it('shouldFallback returns true when cumulative threshold reached, even if consecutive resets in between', () => {
    let t = createDenialTracker();
    for (let i = 0; i < CUMULATIVE_THRESHOLD; i += 1) {
      t = recordBlock(t);
      if (i % 2 === 0) t = recordAllow(t); // alternate allow keeps consecutive low
    }
    expect(shouldFallback(t)).toBe(true);
    expect(t.consecutive).toBeLessThan(CONSECUTIVE_THRESHOLD);
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

  it('CONSECUTIVE_THRESHOLD is 3 and CUMULATIVE_THRESHOLD is 20 (per design doc)', () => {
    expect(CONSECUTIVE_THRESHOLD).toBe(3);
    expect(CUMULATIVE_THRESHOLD).toBe(20);
  });
});
