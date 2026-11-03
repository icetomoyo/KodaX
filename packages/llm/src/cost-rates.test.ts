/**
 * Tests for cost-rates.ts
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_COST_RATES, getCostRate, calculateCost, calculateCostWithCacheLifetimes, type CostRate } from './cost-rates.js';

it('prices the default OpenAI route and keeps unrepresented long-context charges unknown', () => {
  expect(getCostRate('openai', 'gpt-5.3-codex')).toMatchObject({ inputPer1M: 1.75, outputPer1M: 14, cacheReadPer1M: 0.175 });
  const rate = getCostRate('openai', 'gpt-5.4')!;
  expect(calculateCostWithCacheLifetimes(rate, 272_000, 1_000, 100_000, 0, undefined)).toBeCloseTo(0.47);
  expect(calculateCostWithCacheLifetimes(rate, 272_001, 1_000, 100_000, 0, undefined)).toBeNull();
});

it('prices Claude cache writes using their actual lifetime', () => {
  const haiku = getCostRate('anthropic', 'claude-haiku-4-5')!;
  expect(calculateCostWithCacheLifetimes(haiku, 1_000_000, 0, 0, 1_000_000, { '5m': 1_000_000 })).toBe(1.25);
  expect(calculateCostWithCacheLifetimes(haiku, 1_000_000, 0, 0, 1_000_000, { '1h': 1_000_000 })).toBe(2);
  expect(getCostRate('anthropic', 'claude-sonnet-4-6')?.cacheReadPer1M).toBe(0.3);
});

it('selects the Haiku 5.5 price band before subtracting cache writes', () => {
  expect(getCostRate('anthropic', 'claude-opus-5-5')?.cacheReadPer1M).toBe(0.2);
  expect(getCostRate('anthropic', 'claude-sonnet-5-5')?.cacheReadPer1M).toBe(0.1);
  const rate = getCostRate('anthropic', 'claude-haiku-5-5')!;
  expect(rate).toBeDefined();
  expect(calculateCost(rate, 100_000, 1_000)).toBeCloseTo(0.0105);
  expect(calculateCost(rate, 100_001, 1_000)).toBeCloseTo(0.0525005);
  expect(calculateCostWithCacheLifetimes(rate, 200_000, 1_000, 0, 200_000, { '1h': 200_000 })).toBeCloseTo(0.2025);
});

it('keeps new Kimi API estimates separate from Coding subscription accounting', () => {
  expect(getCostRate('kimi', 'kimi-k3.1-pro')).toMatchObject({ inputPer1M: 1.82, outputPer1M: 9.52, basis: 'estimate' });
  expect(getCostRate('kimi-code', 'k3.1-pro')).toMatchObject({ inputPer1M: 2, outputPer1M: 10, basis: 'nominal' });
  expect(getCostRate('kimi', 'k3.1-pro')).toBeUndefined();
});

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

    it.each([
      'deepseek-v4.1-flash', 'deepseek-v4.1-flash-economy',
      'glm-5.3-flash', 'kimi-k3.1-pro', 'kimi-k3', 'kimi-k2.8-preview',
    ])('keeps subscription accounting nonzero for Ark %s', (model) => {
      const rate = getCostRate('ark-coding', model);
      expect(rate?.inputPer1M).toBeGreaterThan(0);
      expect(rate?.outputPer1M).toBeGreaterThan(0);
    });

    it('should price every routed Kimi model, including public K3', () => {
      const kimi = DEFAULT_COST_RATES.kimi;
      expect(Object.keys(kimi)).toEqual([
        'kimi-k3.1-pro',
        'kimi-k3.1-pro-highspeed',
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
        'k3.1-pro',
        'k3.1-pro-highspeed',
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
      expect(anthropic['claude-haiku-4-5'].cachePer1M).toBe(0.1);
    });

    it('should have OpenAI models without cache pricing', () => {
      const openai = DEFAULT_COST_RATES.openai;
      expect(openai['gpt-5.4']).toBeDefined();
      expect(openai['gpt-5.4'].cachePer1M).toBeUndefined();
    });

    it('should have DeepSeek flash/V4 models with cache pricing', () => {
      const deepseek = DEFAULT_COST_RATES.deepseek;
      // Official USD off-peak estimates, 2026-11-01; peak is twice these rates.
      expect(deepseek['deepseek-flash']).toEqual({
        inputPer1M: 0.15,
        outputPer1M: 0.60,
        cachePer1M: 0.003,
      });
      // Native Pro has its own price; do not substitute the Flash route.
      expect(deepseek['deepseek-v4-pro']).toEqual({
        inputPer1M: 0.66,
        outputPer1M: 1.98,
        cachePer1M: 0.022,
      });
      // Retired ids (superseded by deepseek-flash) are no longer priced.
      expect(deepseek['deepseek-v4-flash']).toBeUndefined();
      expect(deepseek['deepseek-v4-flash-vision-exp']).toBeUndefined();
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

    it('should price glm-5.3-flash from the official announcement on all three Zhipu routes', () => {
      // 2026-08-26 announcement: $0.15 input / $0.50 output / $0.03 cached
      // input per million tokens (GLM-5.3 list price / 10).
      for (const provider of ['zhipu', 'zhipu-coding', 'zai-coding'] as const) {
        expect(DEFAULT_COST_RATES[provider]['glm-5.3-flash']).toEqual({
          inputPer1M: 0.15,
          outputPer1M: 0.5,
          cachePer1M: 0.03,
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
      expect(rate?.inputPer1M).toBe(1);
      expect(rate?.outputPer1M).toBe(5);
      expect(rate?.cachePer1M).toBe(0.1);
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
      expect(rate?.inputPer1M).toBe(1);
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
