/**
 * KodaX Cost Rates - Multi-Provider pricing table
 *
 * 成本费率表 - 所有 Provider 的计费标准
 * 支持内置 Provider 的成本追踪，用户可以覆盖默认费率
 */

import type { KodaXCacheWriteUsage } from './types.js';
export interface CostRate {
  /** Input band covered by this estimate. Outside it, the nullable calculator returns unknown. */
  readonly maxPricedInputTokens?: number;
  readonly cacheWritePer1MByTtl?: Readonly<Partial<Record<Exclude<keyof KodaXCacheWriteUsage, 'unknown'>, number>>>;
  readonly basis?: 'estimate' | 'nominal';
  readonly inputPer1M: number; // USD per 1M input tokens
  readonly outputPer1M: number; // USD per 1M output tokens
  /** @deprecated Use cacheReadPer1M/cacheWritePer1M when the provider prices them separately. */
  readonly cachePer1M?: number;
  readonly cacheReadPer1M?: number;
  readonly cacheWritePer1M?: number;
}

// Default rates for all built-in providers (approximate, user can override)
// Estimates, not bills. Selected native routes rechecked 2026-11-01; see docs/LLM_INTEGRATION.md.
export const DEFAULT_COST_RATES: Readonly<Record<string, Readonly<Record<string, CostRate>>>> = {
  anthropic: {
    'claude-opus-4-8': {
      inputPer1M: 5.0,
      outputPer1M: 25.0,
      cachePer1M: 0.5,
      cacheReadPer1M: 0.5,
      cacheWritePer1M: 6.25,
      cacheWritePer1MByTtl: { '5m': 6.25, '1h': 10 },
    },
    'claude-opus-4-7': {
      inputPer1M: 5.0,
      outputPer1M: 25.0,
      cachePer1M: 0.5,
      cacheReadPer1M: 0.5,
      cacheWritePer1M: 6.25,
    },
    'claude-opus-4-6': {
      inputPer1M: 5.0,
      outputPer1M: 25.0,
      cachePer1M: 0.5,
      cacheReadPer1M: 0.5,
      cacheWritePer1M: 6.25,
      cacheWritePer1MByTtl: { '5m': 6.25, '1h': 10 },
    },
    'claude-sonnet-4-6': {
      inputPer1M: 3.0,
      outputPer1M: 15.0,
      cachePer1M: 0.3,
      cacheReadPer1M: 0.3,
      cacheWritePer1M: 3.75,
      cacheWritePer1MByTtl: { '5m': 3.75, '1h': 6 },
    },
    'claude-haiku-4-5': {
      inputPer1M: 1,
      outputPer1M: 5,
      cachePer1M: 0.1,
      cacheReadPer1M: 0.1,
      cacheWritePer1M: 1.25,
      cacheWritePer1MByTtl: { '5m': 1.25, '1h': 2 },
    },
  },
  openai: {
    'gpt-5.3-codex': { inputPer1M: 1.75, outputPer1M: 14, cacheReadPer1M: 0.175 },
    // Higher-context/session and regional charges need more facts than token counts.
    'gpt-5.4': { inputPer1M: 2.5, outputPer1M: 15, cacheReadPer1M: 0.25, maxPricedInputTokens: 272_000 },
    'gpt-5.3-codex-spark': { inputPer1M: 10.0, outputPer1M: 40.0 },
  },
  deepseek: {
    // Official USD off-peak estimates (2026-11-01); peak is 2x.
    // https://api-docs.deepseek.com/quick_start/pricing/
    'deepseek-flash': { inputPer1M: 0.15, outputPer1M: 0.60, cachePer1M: 0.003 },
    'deepseek-v4-pro': { inputPer1M: 0.66, outputPer1M: 1.98, cachePer1M: 0.022 },
  },
  kimi: {
    // Domestic K3.1 CNY prices, 2026-10-24, using this table's fixed 0.14 USD/CNY
    // estimation convention. Not official USD or live FX; user overrides win.
    'kimi-k3.1-pro': { inputPer1M: 1.82, outputPer1M: 9.52, cacheReadPer1M: 0.182,
      cacheWritePer1M: 1.82, cacheWritePer1MByTtl: { '5m': 1.82, '1h': 3.64 }, basis: 'estimate' },
    'kimi-k3.1-pro-highspeed': { inputPer1M: 3.64, outputPer1M: 19.04, cacheReadPer1M: 0.182,
      cacheWritePer1M: 3.64, cacheWritePer1MByTtl: { '5m': 3.64, '1h': 7.28 }, basis: 'estimate' },
    // Official prices are published in CNY; converted at ¥1 ≈ $0.14,
    // using this table's fixed estimation convention. cachePer1M is
    // the automatic context-cache hit price.
    'kimi-k3': { inputPer1M: 2.8, outputPer1M: 14.0, cachePer1M: 0.28 },
    'kimi-k2.7-code': { inputPer1M: 0.91, outputPer1M: 3.78, cachePer1M: 0.182 },
    'kimi-k2.7-code-highspeed': { inputPer1M: 1.82, outputPer1M: 7.56, cachePer1M: 0.364 },
    'kimi-k2.6': { inputPer1M: 0.91, outputPer1M: 3.78, cachePer1M: 0.154 },
    'kimi-k2.5': { inputPer1M: 0.56, outputPer1M: 2.94, cachePer1M: 0.098 },
  },
  'kimi-code': {
    // Subscription usage-value estimates (pi IMPLIED_COSTS), not membership bills.
    'k3.1-pro': { inputPer1M: 2, outputPer1M: 10, cacheReadPer1M: 0.2, basis: 'nominal' },
    'k3.1-pro-highspeed': { inputPer1M: 4, outputPer1M: 20, cacheReadPer1M: 0.2, basis: 'nominal' },
    // Kimi-for-Coding is a subscription endpoint — the per-token rate
    // shown here is a nominal placeholder for cost-tracker accounting;
    // real-world cost is the flat membership fee plus request-quota.
    'kimi-for-coding': { inputPer1M: 0.005, outputPer1M: 0.015 },
    // K3 1M consumes roughly 2x the membership quota of K3 256K.
    'k3': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'k3-256k': { inputPer1M: 0.005, outputPer1M: 0.015 },
    // HighSpeed consumes roughly 3x the membership quota of Standard.
    'kimi-for-coding-highspeed': { inputPer1M: 0.015, outputPer1M: 0.045 },
  },
  qwen: {
    'qwen3.5-plus': { inputPer1M: 0.003, outputPer1M: 0.006 },
  },
  'qwen-token-plan': {
    // Token Plan is Credits-based rather than pay-per-token. These nominal
    // placeholders keep cost tracking non-zero; actual consumption lives in
    // the Alibaba Cloud subscription console.
    'qwen3.8-max': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'qwen3.8-max-preview': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'qwen3.7-max': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'qwen3.7-plus': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'qwen3.6-flash': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'glm-5.2': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'deepseek-v4-pro': { inputPer1M: 0.005, outputPer1M: 0.015 },
  },
  zhipu: {
    // GLM-5.3 public API pricing is not published yet; keep the existing
    // flagship nominal rate so pre-registered selections never look free.
    'glm-5.3': { inputPer1M: 0.05, outputPer1M: 0.1 },
    // 2026-08-26 official announcement (docs.bigmodel.cn glm-5.3-flash):
    // $0.15 input / $0.50 output / $0.03 cached input per 1M tokens —
    // GLM-5.3 list price / 10. First GLM with published cache pricing.
    'glm-5.3-flash': { inputPer1M: 0.15, outputPer1M: 0.5, cachePer1M: 0.03 },
    'glm-5': { inputPer1M: 0.05, outputPer1M: 0.1 },
    'glm-5.1': { inputPer1M: 0.05, outputPer1M: 0.1 },
    'glm-5-turbo': { inputPer1M: 0.01, outputPer1M: 0.03 },
  },
  'zhipu-coding': {
    // Subscription routes use nominal rates for local accounting; actual
    // billing is plan/quota based. Historical GLM-5.2 requests auto-route to 5.3.
    'glm-5.3': { inputPer1M: 0.05, outputPer1M: 0.1 },
    // Flash is on the Coding Plan with 3x plan quota; nominal accounting
    // mirrors the published per-token rates (same as the zhipu entry).
    'glm-5.3-flash': { inputPer1M: 0.15, outputPer1M: 0.5, cachePer1M: 0.03 },
    'glm-5.2': { inputPer1M: 0.05, outputPer1M: 0.1 },
    'glm-5-turbo': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'glm-4.7': { inputPer1M: 0.01, outputPer1M: 0.03 },
  },
  'zai-coding': {
    // Zhipu Coding Plan overseas mirror (api.z.ai). Same model lineup
    // and per-token rates as zhipu-coding — both routes proxy to the
    // same upstream backend. Mirror keeps cost-tracker output
    // comparable when users split between the CN and overseas endpoint.
    'glm-5.3': { inputPer1M: 0.05, outputPer1M: 0.1 },
    'glm-5.3-flash': { inputPer1M: 0.15, outputPer1M: 0.5, cachePer1M: 0.03 },
    'glm-5.2': { inputPer1M: 0.05, outputPer1M: 0.1 },
    'glm-5-turbo': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'glm-4.7': { inputPer1M: 0.01, outputPer1M: 0.03 },
  },
  'minimax-coding': {
    // Nominal subscription accounting; historical entries do not guarantee
    // current M Plan entitlement or model availability.
    'MiniMax-M3.1-Flash': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'MiniMax-M3': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'MiniMax-M2.7': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'MiniMax-M2.7-highspeed': { inputPer1M: 0.01, outputPer1M: 0.03 },
  },
  'mimo-coding': {
    // MiMo Token Plan is a flat-rate subscription — per-token rates here are
    // a nominal placeholder for cost-tracker accounting; real-world cost is
    // the monthly fee plus request-quota.
    'mimo-v2.6-pro': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'mimo-v2.6-flash': { inputPer1M: 0.01, outputPer1M: 0.03 },
    // Retained only for historical usage accounting; V2.5 is retired.
    'mimo-v2.5-pro': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'mimo-v2.5': { inputPer1M: 0.01, outputPer1M: 0.03 },
  },
  mimo: {
    // Xiaomi MiMo public pay-per-token Anthropic-compat endpoint
    // (https://platform.xiaomimimo.com/docs/zh-CN/api/chat/anthropic-api).
    // Same model family as mimo-coding but billed per token. Placeholders
    // mirror mimo-coding so cost-tracker output is non-zero until the
    // user supplies real CNY rates via `~/.kodax/config.json`.
    'mimo-v2.6-pro': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'mimo-v2.6-flash': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'mimo-v2.5-pro': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'mimo-v2.5': { inputPer1M: 0.01, outputPer1M: 0.03 },
  },
  'ark-coding': {
    // Volcengine Ark Coding Plan is a 5-hour sliding-window subscription —
    // per-token rates here are nominal placeholders for cost-tracker
    // accounting; real-world cost is the Lite/Pro membership fee plus
    // sliding-window quota. Listed at ~10% of the standard pay-per-token
    // Ark API rates per the Plan announcement.
    // 2026-07-03 catalog refresh: Ark retired glm-5.1 / glm-4.7 /
    // deepseek-v3.2 (wire returns UnsupportedModel 404). GLM-5.2
    // promoted to default (with wire alias glm-latest). Doubao Seed Code
    // (no "2.0" suffix) added as the next-gen coding variant on the
    // Doubao route (probe-max-tokens.mjs green).
    // 2026-08-15: GLM-5.3 added and promoted to default. Live probe of the
    // Coding Plan wire: glm-5.3 returns HTTP 200; glm-latest and glm-5.2
    // both currently resolve upstream to glm-5.3 as well.
    'glm-5.3': { inputPer1M: 0.005, outputPer1M: 0.015 },
    // 2026-10-28 catalog additions retain nominal subscription accounting;
    // these placeholders do not represent model-specific AFP deductions.
    'glm-5.3-flash': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'kimi-k3.1-pro': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'kimi-k3': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'kimi-k2.8-preview': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'deepseek-v4.1-flash': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'deepseek-v4.1-flash-economy': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'glm-5.2': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'kimi-k2.7-code': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'kimi-k2.6': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'MiniMax-M3': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'MiniMax-M2.7': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'deepseek-v4-pro': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'deepseek-v4-flash': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'doubao-seed-2.0-code': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'doubao-seed-2.0-pro': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'doubao-seed-2.0-lite': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'doubao-seed-code': { inputPer1M: 0.005, outputPer1M: 0.015 },
  },
  // CLI bridge providers - no direct cost (user pays their own CLI usage)
  'gemini-cli': {},
  'codex-cli': {},
};

export function getCostRate(
  provider: string,
  model: string,
  userOverrides?: Readonly<Record<string, Readonly<Record<string, CostRate>>>>,
): CostRate | undefined {
  // User overrides take priority
  const overrideRate = userOverrides?.[provider]?.[model];
  if (overrideRate) return overrideRate;
  return DEFAULT_COST_RATES[provider]?.[model];
}
// These existing tables explicitly declare subscription/placeholder accounting.
// Keep their numeric values for compatibility while exposing their meaning.
const NOMINAL_PROVIDERS = new Set(['kimi-code', 'qwen-token-plan', 'zhipu-coding', 'zai-coding', 'minimax-coding', 'mimo-coding', 'mimo', 'ark-coding']);
export function getCostRateBasis(provider: string, model: string,
  userOverrides?: Readonly<Record<string, Readonly<Record<string, CostRate>>>>): 'estimate' | 'nominal' | 'unknown' {
  const rate = getCostRate(provider, model, userOverrides);
  if (!rate) return 'unknown';
  if (userOverrides?.[provider]?.[model]) return rate.basis ?? 'estimate';
  return rate.basis ?? (NOMINAL_PROVIDERS.has(provider) || (provider === 'zhipu' && model === 'glm-5.3') ? 'nominal' : 'estimate');
}

export function calculateCost(
  rate: CostRate,
  totalInputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  const uncachedInputTokens = Math.max(
    0,
    totalInputTokens - cacheReadTokens - cacheWriteTokens,
  );
  const cacheReadRate = rate.cacheReadPer1M ?? rate.cachePer1M ?? rate.inputPer1M;
  const cacheWriteRate = rate.cacheWritePer1M ?? rate.cachePer1M ?? rate.inputPer1M;
  const inputCost = (uncachedInputTokens / 1_000_000) * rate.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * rate.outputPer1M;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * cacheReadRate;
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * cacheWriteRate;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/** Keep the legacy numeric calculator intact; unknown lifetime pricing is explicitly nullable here. */
export function calculateCostWithCacheLifetimes(rate: CostRate, input: number, output: number, reads: number, writes: number,
  lifetimes: KodaXCacheWriteUsage | undefined): number | null {
  if (rate.maxPricedInputTokens !== undefined && input > rate.maxPricedInputTokens) return null;
  if (!lifetimes) return calculateCost(rate, input, output, reads, writes);
  let categorized = 0, writeCost = 0;
  for (const [ttl, count] of Object.entries(lifetimes)) {
    if (!Number.isFinite(count) || count < 0) return null;
    if (count === 0) continue;
    if (ttl === 'unknown') return null;
    const price = rate.cacheWritePer1MByTtl?.[ttl as Exclude<keyof KodaXCacheWriteUsage, 'unknown'>]
      ?? (ttl === '5m' ? rate.cacheWritePer1M : undefined);
    if (price === undefined || !Number.isFinite(price) || price < 0) return null;
    categorized += count; writeCost += count * price / 1_000_000;
  }
  if (categorized !== writes || !Number.isFinite(categorized)) return null;
  return calculateCost(rate, input - categorized, output, reads, writes - categorized) + writeCost;
}
