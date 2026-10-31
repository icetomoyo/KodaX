import { expect, it } from 'vitest';
import { createCostTracker, recordUsage, getSummary, formatCost, formatCostReport } from './index.js';

it('keeps unknown prices distinct from zero and reports a known subtotal', () => {
  const first = recordUsage(createCostTracker(), { provider: 'priced', model: 'known', inputTokens: 1_000_000, outputTokens: 0 },
    { priced: { known: { inputPer1M: 1, outputPer1M: 0 } } });
  const tracker = recordUsage(first, { provider: 'new-provider', model: 'unpriced-model', inputTokens: 100, outputTokens: 10 });
  expect(tracker.records[1]?.cost).toBeNull();
  const summary = getSummary(tracker);
  expect(summary.totalCost).toBeNull();
  expect(summary.knownCostSubtotal).toBe(1);
  expect(summary.unknownCostCalls).toBe(1);
  expect(summary.byProvider['new-provider']?.cost).toBeNull();
  expect(formatCost(null)).toBe('unknown');
  expect(formatCostReport(summary)).toContain('unknown');
  expect(formatCostReport(summary)).toContain('$1.00');
});

it('prices non-overlapping cache-write lifetimes separately and keeps a missing lifetime rate unknown', () => {
  const entry = { provider: 'priced', model: 'mixed-cache', inputTokens: 12000, outputTokens: 0, cacheReadTokens: 4000,
    cacheWriteTokens: 7000, cacheWriteTokensByTtl: { '30m': 3000, '12h': 4000 } };
  const rates = { priced: { 'mixed-cache': { inputPer1M: 1, outputPer1M: 0, cacheReadPer1M: 0.1,
    cacheWritePer1MByTtl: { '30m': 1.25, '12h': 2.5 } } } };
  const priced = recordUsage(createCostTracker(), entry, rates);
  expect(priced.records[0]?.cost).toBeCloseTo(0.01515, 10);
  expect(priced.records[0]?.cacheWriteTokensByTtl).toEqual({ '30m': 3000, '12h': 4000 });
  expect(recordUsage(createCostTracker(), entry, { priced: { 'mixed-cache': { inputPer1M: 1, outputPer1M: 0 } } }).records[0]?.cost).toBeNull();
});

it('labels declared subscription placeholders separately from configured token-price estimates', () => {
  const nominal = recordUsage(createCostTracker(), { provider: 'mimo-coding', model: 'mimo-v2.6-pro', inputTokens: 1_000_000, outputTokens: 0 });
  expect(nominal.records[0]?.costBasis).toBe('nominal');
  expect(formatCostReport(getSummary(nominal))).toContain('nominal');
  const free = recordUsage(nominal, { provider: 'mimo-coding', model: 'mimo-v2.6-pro', inputTokens: 1_000_000, outputTokens: 0 },
    { 'mimo-coding': { 'mimo-v2.6-pro': { inputPer1M: 0, outputPer1M: 0 } } });
  expect(free.records[1]?.cost).toBe(0); expect(free.records[1]?.costBasis).toBe('estimate');
  expect(getSummary(free).nominalCostCalls).toBe(1);
  expect(getSummary(free).costBasis).toBe('mixed');
});
