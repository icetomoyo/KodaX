// Prompt cache warming policy (FEATURE_316, after pi's packages/ai/src/cache-warming.ts):
// how long an entry lives, when to refresh it, whether a refresh can replay the
// request unchanged, and what a refresh and a lost entry cost. Callers own the timers.
import { calculateCost, calculateCostWithCacheLifetimes, type CostRate } from './cost-rates.js';
import { normalizeReasoningRequest } from './reasoning.js';
import type {
  KodaXCacheCapabilities,
  KodaXProviderStreamOptions,
  KodaXReasoningCapability,
  KodaXReasoningProfile,
  KodaXReasoningRequest,
} from './types.js';

/** `off`: never. `run`: while a Run is active. `idle`: also while the Session waits for its next Run. */
export type CacheWarmingMode = 'off' | 'run' | 'idle';

/** `run` while the Run that sent the request is active; `idle` after it ended. */
export type CacheWarmingPhase = 'run' | 'idle';

/** Warming during a Run stops this long after the real request it keeps warm. */
export const CACHE_WARMING_MAX_RUN_AGE_MS = 60 * 60_000;

/** Idle warming stops sooner: the chance of another request falls with time. */
export const CACHE_WARMING_MAX_IDLE_AGE_MS = 30 * 60_000;

/** A refresh goes out only when it is expected to save at least this many dollars. */
export const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05;

/** pi's measured chance that an idle Session sends its next request before the entry expires. */
export const CACHE_WARMING_IDLE_CONTINUATION_PROBABILITY = 0.15;

export type PromptCacheLifetime = NonNullable<KodaXCacheCapabilities['shortTtl'] | KodaXCacheCapabilities['longTtl']>;

/** The lifetime of the entry a request writes. Undefined when caching is off or the catalog declares none. */
export function promptCacheLifetime(
  capabilities: KodaXCacheCapabilities | undefined,
  retention: KodaXProviderStreamOptions['cacheRetention'],
  disabled: boolean,
): PromptCacheLifetime | undefined {
  if (disabled || retention === 'none') return undefined;
  return retention === 'long' ? capabilities?.longTtl : capabilities?.shortTtl;
}

export function promptCacheLifetimeMs(lifetime: PromptCacheLifetime): number {
  const amount = Number.parseInt(lifetime, 10);
  return amount * (lifetime.endsWith('h') ? 3_600_000 : 60_000);
}

/** Refresh at 90% of the lifetime, and at least ten seconds before the entry expires. */
export function cacheRefreshDelayMs(lifetimeMs: number): number | undefined {
  if (lifetimeMs <= 10_000) return undefined;
  return Math.floor(Math.min(lifetimeMs * 0.9, lifetimeMs - 10_000));
}

interface ReasoningSource {
  getReasoningCapability(model?: string): KodaXReasoningCapability;
  getReasoningProfile(model?: string): KodaXReasoningProfile | undefined;
}

/**
 * Whether a one-token output cap leaves the request otherwise unchanged. A thinking
 * budget is clamped to the output cap, so the replay would send a different budget,
 * which changes the cache key and can be rejected outright.
 */
export function replaysWithOutputCap(
  provider: ReasoningSource,
  model: string | undefined,
  reasoning: boolean | KodaXReasoningRequest | undefined,
): boolean {
  if (!normalizeReasoningRequest(reasoning).enabled) return true;
  const profile = provider.getReasoningProfile(model);
  if (profile) {
    return profile.effortStrategy !== 'provider-budget'
      && profile.thinkingStrategy !== 'anthropic-budget'
      && profile.thinkingStrategy !== 'provider-budget';
  }
  return provider.getReasoningCapability(model) !== 'native-budget';
}

export interface CacheRefreshPrices {
  /** One refresh: a cache read of the prompt plus one output token. */
  readonly refresh: number;
  /** What the next request pays extra when the entry is gone: a rewrite instead of a read. */
  readonly loss: number;
}

/** Undefined when the prompt is empty or the rate has no write price for this lifetime. */
export function cacheRefreshPrices(
  rate: CostRate,
  promptTokens: number,
  lifetime: PromptCacheLifetime,
): CacheRefreshPrices | undefined {
  if (promptTokens <= 0 || lifetime === '24h') return undefined;
  const read = calculateCost(rate, promptTokens, 0, promptTokens, 0);
  const write = calculateCostWithCacheLifetimes(rate, promptTokens, 0, 0, promptTokens, { [lifetime]: promptTokens });
  if (write === null) return undefined;
  return { refresh: calculateCost(rate, promptTokens, 1, promptTokens, 0), loss: Math.max(0, write - read) };
}

export interface CacheWarmingDecision {
  readonly phase: CacheWarmingPhase;
  /** Chance that a real request arrives before the entry expires. */
  readonly continuationProbability: number;
  /** `continuationProbability * loss - refresh`. */
  readonly expectedSavings: number;
  readonly action: 'warm' | 'stop';
}

/** Whether the next refresh pays for itself (pi's `evaluateCacheWarming`). */
export function decideCacheWarming(prices: CacheRefreshPrices, phase: CacheWarmingPhase): CacheWarmingDecision {
  const continuationProbability = phase === 'idle' ? CACHE_WARMING_IDLE_CONTINUATION_PROBABILITY : 1;
  const expectedSavings = continuationProbability * prices.loss - prices.refresh;
  const action = expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? 'warm' : 'stop';
  return { phase, continuationProbability, expectedSavings, action };
}
