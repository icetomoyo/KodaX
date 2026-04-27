/**
 * Contract test for CAP-034: repoIntelligenceTrace emission
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-034-repointelligencetrace-emission
 *
 * Test obligations:
 * - CAP-REPOINTEL-TRACE-001: all 4 trace sites emit when handler wired
 *
 * Risk: LOW
 *
 * Class: 2
 *
 * Verified location: agent-runtime/middleware/repo-intelligence.ts:74-88
 *   (emitRepoIntelligenceTrace + shouldEmitRepoIntelligenceTrace gate)
 *
 * Time-ordering constraint: emitted at 4 specific repo-intel sites
 * (routing/preturn/module/impact). The shape of the emitted event is
 * pinned by `createRepoIntelligenceTraceEvent` in
 * `repo-intelligence/trace-events.ts`.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6u.
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  KodaXEvents,
  KodaXOptions,
  KodaXRepoIntelligenceCarrier,
  KodaXRepoIntelligenceTraceEvent,
} from '../../types.js';

import {
  emitRepoIntelligenceTrace,
  shouldEmitRepoIntelligenceTrace,
} from '../middleware/repo-intelligence.js';

// emitRepoIntelligenceTrace accepts the substrate-side stage set
// (routing/preturn/module/impact). The wider KodaXRepoIntelligenceTraceEvent
// stage union also includes 'task-snapshot', which is emitted only by
// emitManagedRepoIntelligenceTrace from the managed-task path (not in scope
// for this CAP).
type SubstrateStage = 'routing' | 'preturn' | 'module' | 'impact';
const STAGES: SubstrateStage[] = ['routing', 'preturn', 'module', 'impact'];

function makeCarrier(): KodaXRepoIntelligenceCarrier {
  return {
    capability: {
      mode: 'premium-native',
      engine: 'premium',
      bridge: 'native',
      level: 'enhanced',
      status: 'ok',
      warnings: [],
    },
    trace: {
      mode: 'premium-native',
      engine: 'premium',
      bridge: 'native',
      triggeredAt: new Date('2026-04-27T00:00:00Z').toISOString(),
      source: 'premium',
      daemonLatencyMs: 12,
      cliLatencyMs: 4,
      cacheHit: true,
      capsuleBytes: 1024,
      capsuleEstimatedTokens: 256,
    },
  };
}

describe('CAP-034: repoIntelligenceTrace emission contract', () => {
  it('CAP-REPOINTEL-TRACE-001: all 4 repo-intel trace sites (routing/preturn/module/impact) emit events when onRepoIntelligenceTrace is wired', () => {
    const onRepoIntelligenceTrace = vi.fn<(event: KodaXRepoIntelligenceTraceEvent) => void>();
    const events: KodaXEvents = { onRepoIntelligenceTrace };
    const options = {
      provider: 'unused',
      model: 'unused',
      context: { repoIntelligenceTrace: true },
    } as unknown as KodaXOptions;
    const carrier = makeCarrier();

    // Gate must report ON when explicitly enabled in options.context.
    expect(shouldEmitRepoIntelligenceTrace(options)).toBe(true);

    // Fire all 4 stages — each must produce exactly one onRepoIntelligenceTrace call.
    for (const stage of STAGES) {
      emitRepoIntelligenceTrace(events, options, stage, carrier, `detail=${stage}`);
    }

    expect(onRepoIntelligenceTrace).toHaveBeenCalledTimes(STAGES.length);
    const observed = onRepoIntelligenceTrace.mock.calls.map(([event]) => event.stage);
    expect(observed).toEqual(STAGES);

    // Spot-check shape: each emitted event preserves carrier capability and
    // carries a non-empty summary that includes the stage label.
    for (let i = 0; i < STAGES.length; i++) {
      const event = onRepoIntelligenceTrace.mock.calls[i]![0];
      expect(event.stage).toBe(STAGES[i]);
      expect(event.summary).toContain(`stage=${STAGES[i]}`);
      expect(event.capability).toBe(carrier.capability);
      expect(event.trace).toBe(carrier.trace);
    }
  });

  it('CAP-REPOINTEL-TRACE-002: gate suppresses emission when neither options.context.repoIntelligenceTrace nor env flag is set', () => {
    const onRepoIntelligenceTrace = vi.fn<(event: KodaXRepoIntelligenceTraceEvent) => void>();
    const events: KodaXEvents = { onRepoIntelligenceTrace };
    const options = {
      provider: 'unused',
      model: 'unused',
      context: {},
    } as unknown as KodaXOptions;
    // Defensive: ensure env flag is not leaking from another test.
    const prev = process.env.KODAX_REPO_INTELLIGENCE_TRACE;
    delete process.env.KODAX_REPO_INTELLIGENCE_TRACE;
    try {
      expect(shouldEmitRepoIntelligenceTrace(options)).toBe(false);
      for (const stage of STAGES) {
        emitRepoIntelligenceTrace(events, options, stage, makeCarrier());
      }
      expect(onRepoIntelligenceTrace).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env.KODAX_REPO_INTELLIGENCE_TRACE = prev;
    }
  });
});
