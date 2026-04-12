/**
 * Tests for cost-tracker.ts
 */

import { describe, it, expect } from 'vitest';
import {
  createCostTracker,
  recordUsage,
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
      expect(record.cost).toBeCloseTo(4.8); // 0.8 + 4.0
    });

    it('should handle cache tokens', () => {
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 500_000,
        cacheWriteTokens: 500_000,
      });

      const record = tracker.records[0];
      const expected = 15 + 7.5 + 1.875; // input + output + cache (1M * 1.875 per 1M)
      expect(record.cost).toBeCloseTo(expected);
    });

    it('should set cost to 0 for unknown provider/model', () => {
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'unknown',
        model: 'unknown-model',
        inputTokens: 1000,
        outputTokens: 500,
      });

      const record = tracker.records[0];
      expect(record.cost).toBe(0);
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
      expect(summary.totalCost).toBeCloseTo(4.8); // 0.8 + 4.0
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

    it('should include cache information if present', () => {
      let tracker = createCostTracker();
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 1000,
      });

      const report = formatCostReport(getSummary(tracker));
      expect(report).toContain('Cache: 1,000 tokens');
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
      // OpenAI is more expensive per token
      tracker = recordUsage(tracker, {
        provider: 'openai',
        model: 'gpt-5.4',
        inputTokens: 100_000,
        outputTokens: 100_000,
      });
      // Anthropic Haiku is cheaper
      tracker = recordUsage(tracker, {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });

      const report = formatCostReport(getSummary(tracker));
      const openaiIndex = report.indexOf('openai:');
      const anthropicIndex = report.indexOf('anthropic:');
      expect(openaiIndex).toBeLessThan(anthropicIndex);
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
