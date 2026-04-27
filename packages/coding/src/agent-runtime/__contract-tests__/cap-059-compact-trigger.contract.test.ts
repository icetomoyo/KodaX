/**
 * Contract test for CAP-059: compaction trigger decision
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-059-compaction-trigger-decision
 *
 * Test obligations:
 * - CAP-COMPACT-TRIGGER-001: trigger fires at threshold
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/compaction-trigger.ts:shouldCompact
 * (extracted from agent.ts:598-600 — pre-FEATURE_100 baseline —
 * during FEATURE_100 P3.4a).
 *
 * Time-ordering constraint: AFTER microcompact (CAP-014); BEFORE
 * intelligentCompact orchestration (CAP-060).
 *
 * Active here:
 *   - config-disabled short-circuit returns false even when over threshold
 *   - currentTokens > triggerTokens fires
 *   - currentTokens at-or-below triggerTokens does not fire
 *
 * STATUS: ACTIVE since FEATURE_100 P3.4a.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXMessage } from '@kodax/ai';
import type { CompactionConfig } from '@kodax/agent';

import { shouldCompact } from '../compaction-trigger.js';

function makeConfig(overrides: Partial<CompactionConfig> = {}): CompactionConfig {
  return {
    enabled: true,
    triggerPercent: 75,
    keepRecentTurns: 3,
    ...overrides,
  } as CompactionConfig;
}

const messages: KodaXMessage[] = [{ role: 'user', content: 'hello' }];

describe('CAP-059: shouldCompact — config-enabled short-circuit', () => {
  it('CAP-COMPACT-TRIGGER-DISABLED: enabled=false → returns false even when currentTokens far exceed threshold', () => {
    expect(
      shouldCompact({
        messages,
        compactionConfig: makeConfig({ enabled: false }),
        contextWindow: 1000,
        currentTokens: 999, // 99.9%, way over 75%
      }),
    ).toBe(false);
  });
});

describe('CAP-059: shouldCompact — threshold gate', () => {
  it('CAP-COMPACT-TRIGGER-001: currentTokens > triggerTokens (= contextWindow × triggerPercent/100) → true', () => {
    // 1000 × 75% = 750; 800 > 750 fires.
    expect(
      shouldCompact({
        messages,
        compactionConfig: makeConfig({ triggerPercent: 75 }),
        contextWindow: 1000,
        currentTokens: 800,
      }),
    ).toBe(true);
  });

  it('CAP-COMPACT-TRIGGER-AT-OR-BELOW: currentTokens at-or-below threshold → false', () => {
    expect(
      shouldCompact({
        messages,
        compactionConfig: makeConfig({ triggerPercent: 75 }),
        contextWindow: 1000,
        currentTokens: 750, // exactly at threshold (>, not >=, so equal is false)
      }),
    ).toBe(false);
    expect(
      shouldCompact({
        messages,
        compactionConfig: makeConfig({ triggerPercent: 75 }),
        contextWindow: 1000,
        currentTokens: 100, // well below
      }),
    ).toBe(false);
  });

  it('CAP-COMPACT-TRIGGER-RESPECTS-PERCENT: changing triggerPercent shifts the threshold proportionally', () => {
    // 1000 × 50% = 500; 600 > 500 fires for 50% threshold but not for 75%.
    expect(
      shouldCompact({
        messages,
        compactionConfig: makeConfig({ triggerPercent: 50 }),
        contextWindow: 1000,
        currentTokens: 600,
      }),
    ).toBe(true);
    expect(
      shouldCompact({
        messages,
        compactionConfig: makeConfig({ triggerPercent: 75 }),
        contextWindow: 1000,
        currentTokens: 600,
      }),
    ).toBe(false);
  });
});
