/**
 * Contract test for CAP-062: graceful compact degradation gating.
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-062-graceful-compact-degradation-gating
 *
 * Test obligations:
 * - CAP-COMPACT-DEGRADE-002: gap ratio gate prevents needless degradation
 * - CAP-COMPACT-DEGRADE-003: gates on the third case — partial-success-still-high
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/middleware/compaction-orchestration.ts:applyGracefulDegradationGate
 * (extracted from agent.ts:716-732 — pre-FEATURE_100 baseline —
 * during FEATURE_100 P3.4c).
 *
 * Time-ordering constraint: AFTER LLM compact (CAP-060); BEFORE
 * `validateAndFixToolHistory` pre-stream.
 *
 * Active here:
 *   - `needsCompact === false` → identity (gate never fires)
 *   - estimateTokens(compacted) ≤ triggerTokens × gapRatio → identity
 *   - over-trigger but `gracefulCompactDegradation` returns same ref
 *     (no-op) → identity, didCompactMessages=false
 *   - over-trigger AND graceful actually pruned → emit
 *     onCompactStats + onCompact, return new compacted +
 *     didCompactMessages=true
 *
 * STATUS: ACTIVE since FEATURE_100 P3.4c.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXMessage } from '@kodax/ai';
import type { CompactionConfig } from '@kodax/agent';

// Mock the substrate's gracefulCompactDegradation primitive so tests
// stay fast and deterministic. CAP-028 owns its own contract — here
// we only verify the wiring around it.
vi.mock('../compaction-fallback.js', () => ({
  gracefulCompactDegradation: vi.fn(),
}));

import { gracefulCompactDegradation as mockedDegrade } from '../compaction-fallback.js';
import { applyGracefulDegradationGate } from '../middleware/compaction-orchestration.js';
import type { KodaXEvents } from '../../types.js';

const degradeMock = mockedDegrade as unknown as ReturnType<typeof vi.fn>;

function makeConfig(overrides: Partial<CompactionConfig> = {}): CompactionConfig {
  return {
    enabled: true,
    triggerPercent: 75,
    keepRecentTurns: 3,
    ...overrides,
  } as CompactionConfig;
}

const shortMessages: KodaXMessage[] = [
  { role: 'user', content: 'short' },
  { role: 'assistant', content: 'reply' },
];

describe('CAP-062: applyGracefulDegradationGate — needsCompact gate', () => {
  it('CAP-COMPACT-DEGRADE-NOT-NEEDED: needsCompact=false → identity, no events fire', () => {
    const events: KodaXEvents = { onCompactStats: vi.fn(), onCompact: vi.fn() };
    const out = applyGracefulDegradationGate({
      compacted: shortMessages,
      needsCompact: false,
      contextWindow: 1000,
      compactionConfig: makeConfig(),
      currentTokens: 100,
      events,
    });
    expect(out.compacted).toBe(shortMessages);
    expect(out.didCompactMessages).toBe(false);
    expect(events.onCompactStats).not.toHaveBeenCalled();
    expect(events.onCompact).not.toHaveBeenCalled();
  });
});

describe('CAP-062: applyGracefulDegradationGate — gap-ratio gate', () => {
  it('CAP-COMPACT-DEGRADE-002: estimateTokens(compacted) ≤ triggerTokens × gapRatio → identity (gate prevents needless degradation)', () => {
    // contextWindow=1000, triggerPercent=75 → triggerTokens=750
    // gapRatio=0.8 → gateThreshold=600
    // shortMessages estimates well below 600 → gate denies pruning.
    const out = applyGracefulDegradationGate({
      compacted: shortMessages,
      needsCompact: true,
      contextWindow: 1000,
      compactionConfig: makeConfig({ triggerPercent: 75, pruningGapRatio: 0.8 }),
      currentTokens: 800,
      events: {},
    });
    expect(out.compacted).toBe(shortMessages);
    expect(out.didCompactMessages).toBe(false);
  });

  it('CAP-COMPACT-DEGRADE-002b: gapRatio defaults to 0.8 when omitted from config', () => {
    // Same scenario as above but with gapRatio omitted — exercises
    // the `?? 0.8` fallback in the helper.
    const out = applyGracefulDegradationGate({
      compacted: shortMessages,
      needsCompact: true,
      contextWindow: 1000,
      compactionConfig: makeConfig({ triggerPercent: 75 }), // no pruningGapRatio
      currentTokens: 800,
      events: {},
    });
    expect(out.compacted).toBe(shortMessages);
    expect(out.didCompactMessages).toBe(false);
  });
});

describe('CAP-062: applyGracefulDegradationGate — over-trigger paths', () => {
  // Build a payload large enough that estimateTokens > triggerTokens × gapRatio,
  // ensuring the gate enters the prune branch.
  const overTriggerMessages: KodaXMessage[] = [
    { role: 'user', content: 'x'.repeat(2000) },
    { role: 'assistant', content: 'y'.repeat(2000) },
  ];

  it('CAP-COMPACT-DEGRADE-003a: over-trigger AND gracefulCompactDegradation returns same ref (no-op) → identity, didCompactMessages=false (third case prevents thrashing)', () => {
    degradeMock.mockReset();
    // Mock returns the same input ref → no pruning happened.
    degradeMock.mockImplementation((input: KodaXMessage[]) => input);

    const events: KodaXEvents = { onCompactStats: vi.fn(), onCompact: vi.fn() };
    const out = applyGracefulDegradationGate({
      compacted: overTriggerMessages,
      needsCompact: true,
      contextWindow: 1000, // tight enough that overTriggerMessages > gap
      compactionConfig: makeConfig({ triggerPercent: 50, pruningGapRatio: 0.5 }),
      currentTokens: 8000,
      events,
    });

    expect(degradeMock).toHaveBeenCalledOnce();
    expect(out.compacted).toBe(overTriggerMessages); // identity
    expect(out.didCompactMessages).toBe(false);
    expect(events.onCompactStats).not.toHaveBeenCalled();
    expect(events.onCompact).not.toHaveBeenCalled();
  });

  it('CAP-COMPACT-DEGRADE-003b: over-trigger AND gracefulCompactDegradation returned NEW ref (actually pruned) → didCompactMessages=true, onCompactStats + onCompact fire', () => {
    degradeMock.mockReset();
    const prunedMessages: KodaXMessage[] = [
      { role: 'user', content: 'pruned-down version' },
    ];
    degradeMock.mockReturnValueOnce(prunedMessages);

    const events: KodaXEvents = { onCompactStats: vi.fn(), onCompact: vi.fn() };
    const out = applyGracefulDegradationGate({
      compacted: overTriggerMessages,
      needsCompact: true,
      contextWindow: 1000,
      compactionConfig: makeConfig({ triggerPercent: 50, pruningGapRatio: 0.5 }),
      currentTokens: 8000,
      events,
    });

    expect(out.compacted).toBe(prunedMessages); // new ref
    expect(out.didCompactMessages).toBe(true);
    expect(events.onCompactStats).toHaveBeenCalledOnce();
    expect(events.onCompact).toHaveBeenCalledOnce();
  });
});
