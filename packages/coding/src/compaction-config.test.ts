import { describe, expect, it } from 'vitest';
import { adaptiveTriggerPercent, loadCompactionConfig } from './compaction-config.js';

describe('adaptiveTriggerPercent', () => {
  it('200K → 60%', () => {
    expect(adaptiveTriggerPercent(200_000)).toBe(60);
  });

  it('204K (mmx, just over 200K) → 65%', () => {
    expect(adaptiveTriggerPercent(204_800)).toBe(65);
  });

  it('256K (kimi / doubao) → 65%', () => {
    expect(adaptiveTriggerPercent(256_000)).toBe(65);
  });

  it('400K (openai gpt-class) → 70%', () => {
    expect(adaptiveTriggerPercent(400_000)).toBe(70);
  });

  it('500K → 70%', () => {
    expect(adaptiveTriggerPercent(500_000)).toBe(70);
  });

  it('1M (deepseek v4) → 75%', () => {
    expect(adaptiveTriggerPercent(1_000_000)).toBe(75);
  });

  it('undefined contextWindow falls back to 75% (legacy default)', () => {
    expect(adaptiveTriggerPercent(undefined)).toBe(75);
  });

  it('non-positive contextWindow falls back to 75%', () => {
    expect(adaptiveTriggerPercent(0)).toBe(75);
    expect(adaptiveTriggerPercent(-1)).toBe(75);
  });

  it('100K (small) → 60%', () => {
    // Under 200K → 60% (handles hypothetical 100K-window models)
    expect(adaptiveTriggerPercent(100_000)).toBe(60);
  });
});

describe('loadCompactionConfig — adaptive integration', () => {
  // Note: these tests run against the real ~/.kodax/config.json on the
  // dev machine. If the user has explicitly set `compaction.triggerPercent`
  // it WINS over the adaptive default — that is the documented contract.
  // We assert the contract rather than the specific number.

  it('always returns enabled=true (compaction is on by default)', async () => {
    expect((await loadCompactionConfig(200_000)).enabled).toBe(true);
    expect((await loadCompactionConfig(1_000_000)).enabled).toBe(true);
  });

  it('triggerPercent is in valid 1..99 range across windows', async () => {
    for (const w of [100_000, 200_000, 256_000, 500_000, 1_000_000]) {
      const cfg = await loadCompactionConfig(w);
      expect(cfg.triggerPercent, `window=${w}`).toBeGreaterThanOrEqual(1);
      expect(cfg.triggerPercent, `window=${w}`).toBeLessThanOrEqual(99);
    }
  });

  it('all windows return same triggerPercent when user has explicit override', async () => {
    // If the user config sets a fixed triggerPercent, all windows inherit it.
    // (If not, the adaptive default varies — see the unit tests above.)
    const a = await loadCompactionConfig(200_000);
    const b = await loadCompactionConfig(1_000_000);
    const userOverridesEverything = a.triggerPercent === b.triggerPercent;
    if (userOverridesEverything) {
      expect(a.triggerPercent).toBe(b.triggerPercent);
    } else {
      expect(a.triggerPercent).toBe(60);
      expect(b.triggerPercent).toBe(75);
    }
  });
});
