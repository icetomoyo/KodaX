/**
 * KodaX Cost Rates - Multi-Provider pricing table
 *
 * 成本费率表 - 所有 Provider 的计费标准
 * 支持 11 个内置 Provider 的成本追踪，用户可以覆盖默认费率
 */

export interface CostRate {
  readonly inputPer1M: number; // USD per 1M input tokens
  readonly outputPer1M: number; // USD per 1M output tokens
  readonly cachePer1M?: number; // USD per 1M cached tokens
}

// Default rates for all built-in providers (approximate, user can override)
// Rates are from official pricing pages as of 2026-04
export const DEFAULT_COST_RATES: Readonly<Record<string, Readonly<Record<string, CostRate>>>> = {
  anthropic: {
    'claude-opus-4-6': { inputPer1M: 15.0, outputPer1M: 75.0, cachePer1M: 1.875 },
    'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0, cachePer1M: 0.375 },
    'claude-haiku-4-5': { inputPer1M: 0.8, outputPer1M: 4.0, cachePer1M: 0.08 },
  },
  openai: {
    'gpt-5.4': { inputPer1M: 30.0, outputPer1M: 120.0 },
    'gpt-5.3-codex-spark': { inputPer1M: 10.0, outputPer1M: 40.0 },
  },
  deepseek: {
    // V4 series. DeepSeek publishes pricing in CNY/M tokens; values below are
    // converted at ¥1 ≈ $0.14 (official USD rates not yet posted as of 2026-04).
    // Update once api-docs.deepseek.com lists USD rates directly.
    //   v4-flash: ¥1 / ¥0.2 cached / ¥2 out
    //   v4-pro:   ¥12 / ¥1 cached / ¥24 out
    'deepseek-v4-flash': { inputPer1M: 0.14, outputPer1M: 0.28, cachePer1M: 0.028 },
    'deepseek-v4-pro': { inputPer1M: 1.68, outputPer1M: 3.36, cachePer1M: 0.14 },
  },
  kimi: {
    'k2.5': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'kimi-k2.6': { inputPer1M: 0.005, outputPer1M: 0.015 },
  },
  'kimi-code': {
    // Kimi-for-Coding is a subscription endpoint — the per-token rate
    // shown here is a nominal placeholder for cost-tracker accounting;
    // real-world cost is the flat membership fee plus request-quota.
    'kimi-for-coding': { inputPer1M: 0.005, outputPer1M: 0.015 },
  },
  qwen: {
    'qwen3.5-plus': { inputPer1M: 0.003, outputPer1M: 0.006 },
  },
  zhipu: {
    'glm-5': { inputPer1M: 0.05, outputPer1M: 0.1 },
    'glm-5.1': { inputPer1M: 0.05, outputPer1M: 0.1 },
    'glm-5-turbo': { inputPer1M: 0.01, outputPer1M: 0.03 },
  },
  'zhipu-coding': {
    'glm-5': { inputPer1M: 0.05, outputPer1M: 0.1 },
    'glm-5.1': { inputPer1M: 0.05, outputPer1M: 0.1 },
    'glm-5-turbo': { inputPer1M: 0.01, outputPer1M: 0.03 },
  },
  'minimax-coding': {
    'MiniMax-M2.7': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'MiniMax-M2.7-highspeed': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'MiniMax-M2.5': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'MiniMax-M2.5-highspeed': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'MiniMax-M2.1': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'MiniMax-M2.1-highspeed': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'MiniMax-M2': { inputPer1M: 0.01, outputPer1M: 0.03 },
  },
  'mimo-coding': {
    // MiMo Token Plan is a flat-rate subscription — per-token rates here are
    // a nominal placeholder for cost-tracker accounting; real-world cost is
    // the monthly fee plus request-quota.
    'mimo-v2.5-pro': { inputPer1M: 0.01, outputPer1M: 0.03 },
    'mimo-v2.5': { inputPer1M: 0.01, outputPer1M: 0.03 },
  },
  'ark-coding': {
    // Volcengine Ark Coding Plan is a 5-hour sliding-window subscription —
    // per-token rates here are nominal placeholders for cost-tracker
    // accounting; real-world cost is the Lite/Pro membership fee plus
    // sliding-window quota. Listed at ~10% of the standard pay-per-token
    // Ark API rates per the Plan announcement.
    'glm-5.1': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'glm-4.7': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'kimi-k2.6': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'kimi-k2.5': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'minimax-latest': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'deepseek-v3.2': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'doubao-seed-2.0-code': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'doubao-seed-2.0-pro': { inputPer1M: 0.005, outputPer1M: 0.015 },
    'doubao-seed-2.0-lite': { inputPer1M: 0.005, outputPer1M: 0.015 },
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

export function calculateCost(
  rate: CostRate,
  inputTokens: number,
  outputTokens: number,
  cacheTokens = 0,
): number {
  const inputCost = (inputTokens / 1_000_000) * rate.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * rate.outputPer1M;
  const cacheCost = rate.cachePer1M ? (cacheTokens / 1_000_000) * rate.cachePer1M : 0;
  return inputCost + outputCost + cacheCost;
}
