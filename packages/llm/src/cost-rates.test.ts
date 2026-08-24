/**
 * Tests for cost-rates.ts
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_COST_RATES, getCostRate, calculateCost, type CostRate } from './cost-rates.js';

describe('cost-rates', () => {
  describe('DEFAULT_COST_RATES', () => {
    it('should have rates for all 16 providers', () => {
      const providers = [
        'anthropic',
        'openai',
        'deepseek',
        'kimi',
        'kimi-code',
        'qwen',
        'qwen-token-plan',
        'zhipu',
        'zhipu-coding',
        'zai-coding',
        'minimax-coding',
        'mimo-coding',
        'mimo',
        'ark-coding',
        'gemini-cli',
        'codex-cli',
      ];
      providers.forEach((provider) => {
        expect(DEFAULT_COST_RATES).toHaveProperty(provider);
      });
    });

    it('should have ark-coding subscription placeholder rates for all 11 routed models', () => {
      const ark = DEFAULT_COST_RATES['ark-coding'];
      expect(ark).toBeDefined();
      // 2026-07-03 catalog refresh: Ark retired glm-5.1 / glm-4.7 /
      // deepseek-v3.2 (wire returns UnsupportedModel 404); GLM-5.2
      // promoted to default (wire alias glm-latest); Doubao Seed
      // Code (next-gen, no "2.0" suffix) added.
      const expectedModels = [
        'glm-5.2',
        'kimi-k2.7-code',
        'kimi-k2.6',
        'MiniMax-M3',
        'MiniMax-M2.7',
        'deepseek-v4-pro',
        'deepseek-v4-flash',
        'doubao-seed-2.0-code',
        'doubao-seed-2.0-pro',
        'doubao-seed-2.0-lite',
        'doubao-seed-code',
      ];
      expectedModels.forEach((model) => {
        expect(ark[model]).toBeDefined();
        expect(ark[model].inputPer1M).toBeGreaterThan(0);
        expect(ark[model].outputPer1M).toBeGreaterThan(0);
      });
    });

    it('should price every routed Kimi model, including public K3', () => {
      const kimi = DEFAULT_COST_RATES.kimi;
      expect(Object.keys(kimi)).toEqual([
        'kimi-k3',
        'kimi-k2.7-code',
        'kimi-k2.7-code-highspeed',
        'kimi-k2.6',
        'kimi-k2.5',
      ]);
      expect(kimi['kimi-k3']).toEqual({
        inputPer1M: 2.8,
        outputPer1M: 14,
        cachePer1M: 0.28,
      });
      expect(kimi['kimi-k2.7-code']).toEqual({
        inputPer1M: 0.91,
        outputPer1M: 3.78,
        cachePer1M: 0.182,
      });
      expect(kimi['kimi-k2.7-code-highspeed']).toEqual({
        inputPer1M: 1.82,
        outputPer1M: 7.56,
        cachePer1M: 0.364,
      });
    });

    it('should track every Kimi Code subscription route without zero-cost fallthrough', () => {
      const kimiCode = DEFAULT_COST_RATES['kimi-code'];
      expect(Object.keys(kimiCode)).toEqual([
        'kimi-for-coding',
        'k3',
        'k3-256k',
        'kimi-for-coding-highspeed',
      ]);
      expect(kimiCode['k3-256k']).toEqual(kimiCode['kimi-for-coding']);
      expect(kimiCode.k3).toEqual({
        inputPer1M: 0.01,
        outputPer1M: 0.03,
      });
      expect(kimiCode['kimi-for-coding-highspeed']).toEqual({
        inputPer1M: 0.015,
        outputPer1M: 0.045,
      });
    });

    it('should have Anthropic models with cache pricing', () => {
      const anthropic = DEFAULT_COST_RATES.anthropic;
      expect(anthropic['claude-opus-4-6']).toBeDefined();
      expect(anthropic['claude-opus-4-6'].cachePer1M).toBe(0.5);
      expect(anthropic['claude-haiku-4-5']).toBeDefined();
      expect(anthropic['claude-haiku-4-5'].cachePer1M).toBe(0.08);
    });

    it('should have OpenAI models without cache pricing', () => {
      const openai = DEFAULT_COST_RATES.openai;
      expect(openai['gpt-5.4']).toBeDefined();
      expect(openai['gpt-5.4'].cachePer1M).toBeUndefined();
    });

    it('should have DeepSeek V4 models with cache pricing', () => {
      const deepseek = DEFAULT_COST_RATES.deepseek;
      expect(deepseek['deepseek-v4-flash']).toEqual({
        inputPer1M: 0.14,
        outputPer1M: 0.28,
        cachePer1M: 0.0028,
      });
      expect(deepseek['deepseek-v4-pro']).toEqual({
        inputPer1M: 0.435,
        outputPer1M: 0.87,
        cachePer1M: 0.003625,
      });
      // Vision model is priced identically to flash; images are billed as
      // size-derived tokens (≤384/image) at text rates.
      expect(deepseek['deepseek-v4-flash-vision-exp']).toEqual({
        inputPer1M: 0.14,
        outputPer1M: 0.28,
        cachePer1M: 0.0028,
      });
    });

    it('should price both Qwen 3.8 Token Plan model IDs', () => {
      const tokenPlan = DEFAULT_COST_RATES['qwen-token-plan'];
      expect(tokenPlan['qwen3.8-max']).toEqual(tokenPlan['qwen3.8-max-preview']);
      expect(tokenPlan['qwen3.8-max']).toEqual({
        inputPer1M: 0.005,
        outputPer1M: 0.015,
      });
    });

    it('should keep GLM-5.3 accounting non-zero on all three Zhipu routes', () => {
      for (const provider of ['zhipu', 'zhipu-coding', 'zai-coding'] as const) {
        expect(DEFAULT_COST_RATES[provider]['glm-5.3']).toEqual({
          inputPer1M: 0.05,
          outputPer1M: 0.1,
        });
      }
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

    it('should bill cached input once using separate read and write rates', () => {
      const rate: CostRate = {
        inputPer1M: 1.0,
        outputPer1M: 2.0,
        cacheReadPer1M: 0.1,
        cacheWritePer1M: 1.25,
      };
      const cost = calculateCost(
        rate,
        3_000_000,
        1_000_000,
        1_000_000,
        1_000_000,
      );
      expect(cost).toBeCloseTo(4.35); // 1 uncached + 0.1 read + 1.25 write + 2 output
    });

    it('should calculate cost without cache tokens when rate has no cache pricing', () => {
      const rate: CostRate = { inputPer1M: 1.0, outputPer1M: 2.0 };
      const cost = calculateCost(rate, 1_000_000, 1_000_000, 1_000_000);
      expect(cost).toBe(3.0);
    });

    it('should retain cachePer1M as the fallback for both cache categories', () => {
      const rate: CostRate = { inputPer1M: 1.0, outputPer1M: 2.0, cachePer1M: 0.5 };
      const cost = calculateCost(rate, 2_000_000, 1_000_000, 500_000, 500_000);
      expect(cost).toBeCloseTo(3.5); // 1 uncached + 0.5 cached + 2 output
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
      expect(cost).toBeCloseTo(7.275); // 4.75 uncached + 2.5 output + 0.025 cache
    });
  });
});
