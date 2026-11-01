/**
 * Tests for cost-tracker.ts
 */

import { describe, it, expect } from 'vitest';
import {
  createCostTracker,
  recordUsage,
  recordRetry,
  getSummary,
  formatCost,
  formatCostReport,
  type CostTracker,
} from './cost-tracker.js';
import { DEFAULT_COST_RATES, type CostRate } from './cost-rates.js';

describe('cost-tracker', () => {
  describe('createCostTracker', () => {
    it('should create an empty tracker', () => {
      const tracker = createCostTracker();
      expect(tracker.records).toEqual([]);
      expect(tracker.retries).toEqual([]);
    });
  });

  describe('FEATURE_130 recordRetry', () => {
    it('appends a retry record immutably', () => {
      const tracker1 = createCostTracker();
      const tracker2 = recordRetry(tracker1, {
        provider: 'anthropic',
        waitMs: 7000,
        reason: 'rate-limit',
        source: 'retry-after-seconds',
      });
      expect(tracker1.retries).toHaveLength(0);
      expect(tracker2.retries).toHaveLength(1);
      expect(tracker2.retries[0]).toMatchObject({
        provider: 'anthropic',
        waitMs: 7000,
        reason: 'rate-limit',
        source: 'retry-after-seconds',
      });
    });

    it('summary aggregates retry count and cumulative wait', () => {
      let tracker = createCostTracker();
      tracker = recordRetry(tracker, {
        provider: 'anthropic',
        waitMs: 1500,
        reason: 'rate-limit',
        source: 'retry-after-seconds',
      });
      tracker = recordRetry(tracker, {
        provider: 'openai',
        waitMs: 2500,
        reason: 'overloaded',
        source: 'exponential-backoff',
      });
      const summary = getSummary(tracker);
      expect(summary.retryCount).toBe(2);
      expect(summary.retryWaitMs).toBe(4000);
    });

    it('formatCostReport surfaces the retries line when present', () => {
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 100,
        outputTokens: 50,
      });
      tracker = recordRetry(tracker, {
        provider: 'anthropic',
        waitMs: 4500,
        reason: 'rate-limit',
        source: 'retry-after-ms',
      });
      const report = formatCostReport(getSummary(tracker));
      expect(report).toContain('Retries: 1');
      expect(report).toContain('4.5s');
    });
  });

  describe('recordUsage', () => {
    it('should create a new tracker with one record', () => {
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 1000,
        outputTokens: 500,
      });

      expect(tracker.records).toHaveLength(1);
      expect(tracker.records[0]).toMatchObject({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: expect.any(Number),
      });
    });

    it('should maintain immutability (not mutate original tracker)', () => {
      const tracker1 = createCostTracker();
      const tracker2 = recordUsage(tracker1, {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 1000,
        outputTokens: 500,
      });

      expect(tracker1.records).toHaveLength(0);
      expect(tracker2.records).toHaveLength(1);
      expect(tracker1).not.toBe(tracker2);
    });

    it('should accumulate multiple records', () => {
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 1000,
        outputTokens: 500,
      });
      tracker = recordUsage(tracker, {
        provider: 'openai',
        model: 'gpt-5.4',
        inputTokens: 2000,
        outputTokens: 1000,
      });

      expect(tracker.records).toHaveLength(2);
    });

    it('should calculate cost using default rates', () => {
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });

      const record = tracker.records[0];
      expect(record.cost).toBeCloseTo(6); // 1 + 5
    });

    it('should not bill cache tokens again as uncached input', () => {
      let tracker = createCostTracker();
      const overrides: Readonly<Record<string, Readonly<Record<string, CostRate>>>> = {
        anthropic: {
          'claude-opus-4-6': {
            inputPer1M: 5,
            outputPer1M: 25,
            cacheReadPer1M: 0.5,
            cacheWritePer1M: 6.25,
          },
        },
      };
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 2_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 500_000,
        cacheWriteTokens: 500_000,
      }, overrides);

      const record = tracker.records[0];
      const expected = 5 + 2.5 + 0.25 + 3.125;
      expect(record.cost).toBeCloseTo(expected);
    });

    it('keeps cost unknown for an unpriced provider/model', () => {
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'unknown',
        model: 'unknown-model',
        inputTokens: 1000,
        outputTokens: 500,
      });

      const record = tracker.records[0];
      expect(record.cost).toBeNull();
    });

    it('should record role if provided', () => {
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 1000,
        outputTokens: 500,
        role: 'planner',
      });

      expect(tracker.records[0].role).toBe('planner');
    });

    it('should support user cost overrides', () => {
      let tracker = createCostTracker();
      const overrides: Readonly<Record<string, Readonly<Record<string, CostRate>>>> = {
        anthropic: {
          'claude-haiku-4-5': { inputPer1M: 10.0, outputPer1M: 20.0 },
        },
      };
      tracker = recordUsage(
        tracker,
        {
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
        },
        overrides,
      );

      expect(tracker.records[0].cost).toBe(30.0);
    });

    it('should set timestamp', () => {
      const before = Date.now();
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 1000,
        outputTokens: 500,
      });
      const after = Date.now();

      const record = tracker.records[0];
      expect(record.timestamp).toBeGreaterThanOrEqual(before);
      expect(record.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('getSummary', () => {
    it('should return zero values for empty tracker', () => {
      const tracker = createCostTracker();
      const summary = getSummary(tracker);

      expect(summary.totalCost).toBe(0);
      expect(summary.totalInputTokens).toBe(0);
      expect(summary.totalOutputTokens).toBe(0);
      expect(summary.totalCacheTokens).toBe(0);
      expect(summary.callCount).toBe(0);
      expect(summary.byProvider).toEqual({});
      expect(summary.byRole).toEqual({});
    });

    it('should aggregate by provider', () => {
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 1000,
        outputTokens: 500,
      });
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 500,
        outputTokens: 250,
      });
      tracker = recordUsage(tracker, {
        provider: 'openai',
        model: 'gpt-5.4',
        inputTokens: 2000,
        outputTokens: 1000,
      });

      const summary = getSummary(tracker);
      expect(summary.byProvider['anthropic'].calls).toBe(2);
      expect(summary.byProvider['anthropic'].inputTokens).toBe(1500);
      expect(summary.byProvider['openai'].calls).toBe(1);
      expect(summary.byProvider['openai'].inputTokens).toBe(2000);
    });

    it('should aggregate by role with default for missing role', () => {
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 1000,
        outputTokens: 500,
        role: 'planner',
      });
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 500,
        outputTokens: 250,
      });

      const summary = getSummary(tracker);
      expect(summary.byRole['planner'].calls).toBe(1);
      expect(summary.byRole['default'].calls).toBe(1);
    });

    it('should calculate total cost correctly', () => {
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });

      const summary = getSummary(tracker);
      expect(summary.totalCost).toBeCloseTo(6); // 1 + 5
    });

    it('should aggregate cache tokens', () => {
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 1000,
        cacheWriteTokens: 500,
      });

      const summary = getSummary(tracker);
      expect(summary.totalCacheTokens).toBe(1500);
    });

    // FEATURE_116 (v0.7.37) — cacheHitRate field tests
    it('should report cacheHitRate=0 for an empty tracker', () => {
      const summary = getSummary(createCostTracker());
      expect(summary.cacheHitRate).toBe(0);
      expect(summary.totalCacheReadTokens).toBe(0);
      expect(summary.totalCacheWriteTokens).toBe(0);
    });

    it('should compute cacheHitRate from cumulative read / (read + write)', () => {
      let tracker = createCostTracker();
      // First call: pure write (cache miss / first turn — creating cache).
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 1000,
      });
      let summary = getSummary(tracker);
      expect(summary.totalCacheReadTokens).toBe(0);
      expect(summary.totalCacheWriteTokens).toBe(1000);
      expect(summary.cacheHitRate).toBe(0); // first turn: 0 / 1000 = 0

      // Second call: pure read (cache hit on stable prefix).
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 1000,
        cacheWriteTokens: 0,
      });
      summary = getSummary(tracker);
      expect(summary.totalCacheReadTokens).toBe(1000);
      expect(summary.totalCacheWriteTokens).toBe(1000);
      expect(summary.cacheHitRate).toBe(0.5);

      // Third call: another cache hit.
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 2000,
        cacheWriteTokens: 0,
      });
      summary = getSummary(tracker);
      expect(summary.totalCacheReadTokens).toBe(3000);
      expect(summary.cacheHitRate).toBeCloseTo(0.75); // 3000 / 4000
    });

    it('should not produce NaN when cache fields are absent', () => {
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'openai',
        model: 'gpt-5.4',
        inputTokens: 1000,
        outputTokens: 500,
      });
      const summary = getSummary(tracker);
      expect(summary.cacheHitRate).toBe(0);
      expect(Number.isFinite(summary.cacheHitRate)).toBe(true);
    });
  });

  describe('formatCost', () => {
    it('should format very small amounts with 4 decimals', () => {
      expect(formatCost(0.001)).toBe('$0.0010');
      expect(formatCost(0.0001)).toBe('$0.0001');
    });

    it('should format amounts < 1 with 3 decimals', () => {
      expect(formatCost(0.1)).toBe('$0.100');
      expect(formatCost(0.999)).toBe('$0.999');
    });

    it('should format amounts >= 1 with 2 decimals', () => {
      expect(formatCost(1.0)).toBe('$1.00');
      expect(formatCost(100.5678)).toBe('$100.57');
      expect(formatCost(9999.999)).toBe('$10000.00');
    });
  });

  describe('formatCostReport', () => {
    it('should format basic report with total cost', () => {
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });

      const report = formatCostReport(getSummary(tracker));
      expect(report).toContain('Session Cost:');
      expect(report).toContain('(1 calls)');
      expect(report).toContain('1,000,000 in / 1,000,000 out');
    });

    it('should include cache information with hit-rate breakdown if present', () => {
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 800,
        cacheWriteTokens: 200,
      });

      const report = formatCostReport(getSummary(tracker));
      // FEATURE_116 (v0.7.37): cache line shows total + read/write split + hit rate
      expect(report).toContain('Cache: 1,000 tokens');
      expect(report).toContain('800 read');
      expect(report).toContain('200 write');
      expect(report).toContain('80% hit rate');
    });

    it('should include provider breakdown when present', () => {
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 1000,
        outputTokens: 500,
      });
      tracker = recordUsage(tracker, {
        provider: 'openai',
        model: 'gpt-5.4',
        inputTokens: 2000,
        outputTokens: 1000,
      });

      const report = formatCostReport(getSummary(tracker));
      expect(report).toContain('By Provider:');
      expect(report).toContain('anthropic:');
      expect(report).toContain('openai:');
    });

    it('should include role breakdown when multiple roles present', () => {
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 1000,
        outputTokens: 500,
        role: 'planner',
      });
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 500,
        outputTokens: 250,
        role: 'reviewer',
      });

      const report = formatCostReport(getSummary(tracker));
      expect(report).toContain('By Role:');
      expect(report).toContain('planner:');
      expect(report).toContain('reviewer:');
    });

    it('should not include role breakdown with single role (default)', () => {
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 1000,
        outputTokens: 500,
      });

      const report = formatCostReport(getSummary(tracker));
      expect(report).not.toContain('By Role:');
    });

    it('should sort providers by cost descending', () => {
      let tracker = createCostTracker();
      // OpenAI costs $1.75 for this usage; Haiku below costs $6.
      tracker = recordUsage(tracker, {
        provider: 'openai',
        model: 'gpt-5.4',
        inputTokens: 100_000,
        outputTokens: 100_000,
      });
      // Sort by actual total, rather than the model's per-token rate.
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });

      const report = formatCostReport(getSummary(tracker));
      const openaiIndex = report.indexOf('openai:');
      const anthropicIndex = report.indexOf('anthropic:');
      expect(anthropicIndex).toBeLessThan(openaiIndex);
    });

    it('should format cost for each provider', () => {
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });

      const report = formatCostReport(getSummary(tracker));
      expect(report).toMatch(/anthropic: \$[0-9]+\.[0-9]{2}/);
    });
  });
});
