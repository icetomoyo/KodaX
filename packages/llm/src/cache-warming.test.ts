import { describe, expect, it } from 'vitest';
import { validateCacheCapabilities } from './providers/cache-policy.js';
import { getCostRate } from './cost-rates.js';
import { getProvider } from './providers/registry.js';
import {
  cacheRefreshDelayMs,
  cacheRefreshPrices,
  promptCacheLifetime,
  promptCacheLifetimeMs,
  replaysWithOutputCap,
} from './cache-warming.js';

describe('prompt cache lifetime', () => {
  it('reads the short or long lifetime the request writes', () => {
    const capabilities = { dialect: 'anthropic' as const, shortTtl: '5m' as const, longTtl: '1h' as const };
    expect(promptCacheLifetime(capabilities, undefined, false)).toBe('5m');
    expect(promptCacheLifetime(capabilities, 'long', false)).toBe('1h');
  });

  it('has no lifetime when caching is off or the lifetime is not declared', () => {
    const capabilities = { dialect: 'anthropic' as const, shortTtl: '5m' as const };
    expect(promptCacheLifetime(capabilities, 'none', false)).toBeUndefined();
    expect(promptCacheLifetime(capabilities, 'short', true)).toBeUndefined();
    expect(promptCacheLifetime({ dialect: 'affinity' }, 'short', false)).toBeUndefined();
    expect(promptCacheLifetime(undefined, 'short', false)).toBeUndefined();
  });

  it('converts lifetimes to milliseconds', () => {
    expect(promptCacheLifetimeMs('5m')).toBe(300_000);
    expect(promptCacheLifetimeMs('1h')).toBe(3_600_000);
  });

  it('declares five minutes for the direct Anthropic API only', () => {
    expect(getProvider('anthropic').getCacheCapabilities()?.shortTtl).toBe('5m');
    expect(getProvider('zhipu-coding').getCacheCapabilities()?.shortTtl).toBeUndefined();
  });

  it('accepts a short lifetime only where the dialect has one', () => {
    expect(() => validateCacheCapabilities({ dialect: 'anthropic', shortTtl: '5m' })).not.toThrow();
    expect(() => validateCacheCapabilities({ dialect: 'openai-options', shortTtl: '5m' })).toThrow();
  });
});

describe('cache refresh timing', () => {
  it('refreshes at 90% of the lifetime', () => {
    expect(cacheRefreshDelayMs(300_000)).toBe(270_000);
  });

  it('keeps at least ten seconds before the entry expires', () => {
    expect(cacheRefreshDelayMs(60_000)).toBe(50_000);
  });

  it('does not refresh a lifetime of ten seconds or less', () => {
    expect(cacheRefreshDelayMs(10_000)).toBeUndefined();
  });
});

describe('replaying with a one-token output cap', () => {
  const provider = (capability: string, profile?: Record<string, string>) => ({
    getReasoningCapability: () => capability as never,
    getReasoningProfile: () => profile as never,
  });

  it('is safe for adaptive thinking and for requests without thinking', () => {
    expect(replaysWithOutputCap(provider('native-adaptive'), 'm', { enabled: true, mode: 'auto' } as never)).toBe(true);
    expect(replaysWithOutputCap(provider('native-budget'), 'm', false)).toBe(true);
  });

  it('is unsafe when the thinking budget comes from the output cap', () => {
    expect(replaysWithOutputCap(provider('native-budget'), 'm', true)).toBe(false);
    expect(replaysWithOutputCap(provider('none', { effortStrategy: 'provider-budget' }), 'm', true)).toBe(false);
    expect(replaysWithOutputCap(provider('none', { effortStrategy: 'none', thinkingStrategy: 'anthropic-budget' }), 'm', true)).toBe(false);
  });

  it('follows the catalog: Claude Haiku 4.5 uses a budget, Sonnet 5.5 does not', () => {
    const anthropic = getProvider('anthropic');
    expect(replaysWithOutputCap(anthropic, 'claude-haiku-4-5', true)).toBe(false);
    expect(replaysWithOutputCap(anthropic, 'claude-sonnet-5-5', true)).toBe(true);
  });
});

describe('cache refresh prices', () => {
  it('prices a refresh as a cache read plus one output token', () => {
    const rate = getCostRate('anthropic', 'claude-sonnet-4-6')!;
    const prices = cacheRefreshPrices(rate, 100_000, '5m')!;
    expect(prices.refresh).toBeCloseTo(100_000 * 0.3 / 1e6 + 15 / 1e6, 9);
    expect(prices.loss).toBeCloseTo(100_000 * (3.75 - 0.3) / 1e6, 9);
  });

  it('uses the write price of the lifetime the entry has', () => {
    const rate = getCostRate('anthropic', 'claude-sonnet-4-6')!;
    expect(cacheRefreshPrices(rate, 100_000, '1h')!.loss).toBeCloseTo(100_000 * (6 - 0.3) / 1e6, 9);
  });

  it('has no prices for an empty prompt or a lifetime without a write price', () => {
    const rate = getCostRate('anthropic', 'claude-sonnet-4-6')!;
    expect(cacheRefreshPrices(rate, 0, '5m')).toBeUndefined();
    expect(cacheRefreshPrices({ inputPer1M: 1, outputPer1M: 1, cacheReadPer1M: 0.1 }, 1000, '1h')).toBeUndefined();
  });
});
