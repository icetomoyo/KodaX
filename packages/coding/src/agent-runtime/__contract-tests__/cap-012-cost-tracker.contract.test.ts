/**
 * Contract test for CAP-012: per-session CostTracker
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-012-per-session-costtracker
 *
 * Test obligations:
 * - CAP-COST-TRACKER-001: recordUsage accumulates across turns
 * - CAP-COST-TRACKER-002: REPL /cost reads live snapshot via events.getCostReport.current
 *
 * Risk: HIGH_RISK_PARITY — `runner-driven.ts:2270-2273` parity-restore evidence:
 * "Legacy agent.ts:1681 creates one per session"
 *
 * Verified location: agent.ts:1435 (matches legacy semantics)
 *
 * STATUS: ACTIVE since FEATURE_100 P2. The cost-tracker implementation lives
 * in `@kodax/ai`; the substrate-internal re-export at
 * `agent-runtime/middleware/cost-tracker.ts` is what other middleware
 * modules import against. This contract pins the immutable functional API
 * (each call returns a NEW tracker, never mutates).
 */

import { describe, expect, it } from 'vitest';

import {
  createCostTracker,
  recordUsage,
  getSummary,
  formatCostReport,
} from '../middleware/cost-tracker.js';

describe('CAP-012: per-session CostTracker contract', () => {
  it('CAP-COST-TRACKER-001a: createCostTracker() returns an empty tracker; getSummary reflects zero state', () => {
    const tracker = createCostTracker();
    const summary = getSummary(tracker);
    expect(summary.callCount).toBe(0);
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.totalOutputTokens).toBe(0);
    expect(summary.totalCost).toBe(0);
  });

  it('CAP-COST-TRACKER-001b: recordUsage accumulates across multiple turns; tracker is immutable (never mutated in place)', () => {
    const t0 = createCostTracker();

    const t1 = recordUsage(t0, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      inputTokens: 1000,
      outputTokens: 200,
      role: 'sa',
    });
    const t2 = recordUsage(t1, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      inputTokens: 2000,
      outputTokens: 500,
      cacheReadTokens: 100,
      role: 'sa',
    });

    // Original empty tracker untouched
    expect(getSummary(t0).callCount).toBe(0);
    // Each call produces a new tracker with one more record
    expect(getSummary(t1).callCount).toBe(1);
    expect(getSummary(t2).callCount).toBe(2);

    const summary = getSummary(t2);
    expect(summary.totalInputTokens).toBe(3000);
    expect(summary.totalOutputTokens).toBe(700);
    expect(summary.totalCacheTokens).toBe(100);
  });

  it('CAP-COST-TRACKER-001c: getSummary aggregates per-provider and per-role breakdowns', () => {
    let tracker = createCostTracker();
    tracker = recordUsage(tracker, { provider: 'deepseek', model: 'deepseek-v4-flash', inputTokens: 100, outputTokens: 50, role: 'sa' });
    tracker = recordUsage(tracker, { provider: 'deepseek', model: 'deepseek-v4-flash', inputTokens: 200, outputTokens: 80, role: 'sa' });
    tracker = recordUsage(tracker, { provider: 'kimi-code', model: 'kimi-k2', inputTokens: 300, outputTokens: 100, role: 'generator' });

    const summary = getSummary(tracker);
    expect(summary.byProvider.deepseek?.calls).toBe(2);
    expect(summary.byProvider.deepseek?.inputTokens).toBe(300);
    expect(summary.byProvider['kimi-code']?.calls).toBe(1);
    expect(summary.byRole.sa?.calls).toBe(2);
    expect(summary.byRole.generator?.calls).toBe(1);
  });

  it('CAP-COST-TRACKER-002: formatCostReport(getSummary(tracker)) renders the snapshot string the REPL /cost command displays', () => {
    let tracker = createCostTracker();
    tracker = recordUsage(tracker, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      inputTokens: 50_000,
      outputTokens: 12_000,
    });
    const report = formatCostReport(getSummary(tracker));
    // Sanity: report mentions call count + token totals
    expect(report).toMatch(/\b1 calls?\b/);
    expect(report).toContain('50,000');
    expect(report).toContain('12,000');
  });

  it('CAP-COST-TRACKER-003: tracker is per-session — separate createCostTracker() invocations get independent state', () => {
    const sessionA = recordUsage(createCostTracker(), {
      provider: 'deepseek', model: 'deepseek-v4-flash', inputTokens: 100, outputTokens: 50,
    });
    const sessionB = recordUsage(createCostTracker(), {
      provider: 'kimi-code', model: 'kimi-k2', inputTokens: 999, outputTokens: 444,
    });

    // Sessions don't bleed into each other
    expect(getSummary(sessionA).totalInputTokens).toBe(100);
    expect(getSummary(sessionB).totalInputTokens).toBe(999);
    expect(getSummary(sessionA).byProvider['kimi-code']).toBeUndefined();
    expect(getSummary(sessionB).byProvider.deepseek).toBeUndefined();
  });
});
