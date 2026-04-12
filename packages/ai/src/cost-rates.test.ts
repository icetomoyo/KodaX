/**
 * Tests for cost-rates.ts
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_COST_RATES, getCostRate, calculateCost, type CostRate } from './cost-rates.js';

describe('cost-rates', () => {
  describe('DEFAULT_COST_RATES', () => {
    it('should have rates for all 11 providers', () => {
      const providers = [
        'anthropic',
        'openai',
        'deepseek',
        'kimi',
        'kimi-code',
        'qwen',
        'zhipu',
        'zhipu-coding',
        'minimax-coding',
        'gemini-cli',
        'codex-cli',
      ];
      providers.forEach((provider) => {
        expect(DEFAULT_COST_RATES).toHaveProperty(provider);
      });
    });

    it('should have Anthropic models with cache pricing', () => {
      const anthropic = DEFAULT_COST_RATES.anthropic;
      expect(anthropic['claude-opus-4-6']).toBeDefined();
      expect(anthropic['claude-opus-4-6'].cachePer1M).toBe(1.875);
      expect(anthropic['claude-haiku-4-5']).toBeDefined();
      expect(anthropic['claude-haiku-4-5'].cachePer1M).toBe(0.08);
    });

    it('should have OpenAI models without cache pricing', () => {
      const openai = DEFAULT_COST_RATES.openai;
      expect(openai['gpt-5.4']).toBeDefined();
      expect(openai['gpt-5.4'].cachePer1M).toBeUndefined();
    });

    it('should have empty entries for CLI bridge providers', () => {
      expect(DEFAULT_COST_RATES['gemini-cli']).toEqual({});
      expect(DEFAULT_COST_RATES['codex-cli']).toEqual({});
    });
  });

  describe('getCostRate', () => {
    it('should return rate from default rates for known provider/model', () => {
      const rate = getCostRate('anthropic', 'claude-haiku-4-5');
      expect(rate).toBeDefined();
      expect(rate?.inputPer1M).toBe(0.8);
      expect(rate?.outputPer1M).toBe(4.0);
      expect(rate?.cachePer1M).toBe(0.08);
    });

    it('should return undefined for unknown provider', () => {
      const rate = getCostRate('unknown', 'some-model');
      expect(rate).toBeUndefined();
    });

    it('should return undefined for unknown model', () => {
      const rate = getCostRate('anthropic', 'unknown-model');
      expect(rate).toBeUndefined();
    });

    it('should prioritize user overrides over default rates', () => {
      const overrides: Readonly<Record<string, Readonly<Record<string, CostRate>>>> = {
        anthropic: {
          'claude-haiku-4-5': { inputPer1M: 100, outputPer1M: 200, cachePer1M: 50 },
        },
      };
      const rate = getCostRate('anthropic', 'claude-haiku-4-5', overrides);
      expect(rate).toEqual({ inputPer1M: 100, outputPer1M: 200, cachePer1M: 50 });
    });

    it('should use default if override not provided for specific provider/model', () => {
      const overrides: Readonly<Record<string, Readonly<Record<string, CostRate>>>> = {
        openai: {
          'gpt-5.4': { inputPer1M: 100, outputPer1M: 200 },
        },
      };
      const rate = getCostRate('anthropic', 'claude-haiku-4-5', overrides);
      expect(rate?.inputPer1M).toBe(0.8);
    });
  });

  describe('calculateCost', () => {
    it('should calculate cost with input and output tokens', () => {
      const rate: CostRate = { inputPer1M: 1.0, outputPer1M: 2.0 };
      const cost = calculateCost(rate, 1_000_000, 1_000_000);
      expect(cost).toBe(3.0);
    });

    it('should calculate cost with cache tokens', () => {
      const rate: CostRate = { inputPer1M: 1.0, outputPer1M: 2.0, cachePer1M: 0.5 };
      const cost = calculateCost(rate, 1_000_000, 1_000_000, 1_000_000);
      expect(cost).toBe(3.5);
    });

    it('should calculate cost without cache tokens when rate has no cache pricing', () => {
      const rate: CostRate = { inputPer1M: 1.0, outputPer1M: 2.0 };
      const cost = calculateCost(rate, 1_000_000, 1_000_000, 1_000_000);
      expect(cost).toBe(3.0);
    });

    it('should handle partial token amounts', () => {
      const rate: CostRate = { inputPer1M: 10.0, outputPer1M: 20.0 };
      const cost = calculateCost(rate, 500_000, 250_000);
      expect(cost).toBeCloseTo(10.0); // 5 + 5
    });

    it('should handle zero tokens', () => {
      const rate: CostRate = { inputPer1M: 10.0, outputPer1M: 20.0 };
      const cost = calculateCost(rate, 0, 0);
      expect(cost).toBe(0);
    });

    it('should calculate with real Anthropic rates', () => {
      const rate = DEFAULT_COST_RATES.anthropic['claude-opus-4-6']!;
      const cost = calculateCost(rate, 1_000_000, 100_000, 50_000);
      expect(cost).toBeCloseTo(22.59375); // 15 (input) + 7.5 (output) + 0.09375 (cache)
    });
  });
});
