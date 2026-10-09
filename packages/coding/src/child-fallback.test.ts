import { afterEach, describe, expect, it, vi } from 'vitest';

import { KodaXNetworkError, KodaXProviderError, KodaXRateLimitError, runWithProviderRequestObserver,
  withProviderRequestCredential, type ProviderRequestObservation } from '@kodax-ai/llm';

import {
  invokeChildWithFallback,
  isFallbackEligibleError,
  resolveFallbackChain,
} from './child-fallback.js';
import type { KodaXOptions, KodaXResult } from './types.js';

const okResult = (lastText = 'done'): KodaXResult => ({
  success: true,
  lastText,
  messages: [{ role: 'assistant', content: lastText }],
  sessionId: 's',
});

const baseOptions = (overrides: Partial<KodaXOptions> = {}): KodaXOptions =>
  ({ provider: 'zhipu-coding', model: 'glm-4.6', agentMode: 'sa', ...overrides }) as KodaXOptions;

describe('resolveFallbackChain', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns [] when unset (fallback OFF)', () => {
    expect(resolveFallbackChain()).toEqual([]);
  });

  it('parses, trims, and drops empty entries', () => {
    vi.stubEnv('KODAX_FALLBACK_PROVIDERS', ' kimi-code , , ark-coding ');
    expect(resolveFallbackChain()).toEqual(['kimi-code', 'ark-coding']);
  });
});

describe('isFallbackEligibleError', () => {
  it('is true only for hard provider-availability errors', () => {
    expect(isFallbackEligibleError(new KodaXRateLimitError('429'))).toBe(true);
    expect(isFallbackEligibleError(new KodaXNetworkError('ECONNRESET'))).toBe(true);
    expect(isFallbackEligibleError(new KodaXProviderError('500'))).toBe(true);
  });

  it('is false for generic errors (task outcome / logic)', () => {
    expect(isFallbackEligibleError(new Error('boom'))).toBe(false);
    expect(isFallbackEligibleError('nope')).toBe(false);
  });
});

describe('invokeChildWithFallback', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('attributes cross-provider fallback to one route without expanding credential purpose', async () => {
    vi.stubEnv('KODAX_FALLBACK_PROVIDERS', 'kimi-code');
    const facts: ProviderRequestObservation[] = [];
    await runWithProviderRequestObserver(fact => facts.push(fact), () => invokeChildWithFallback(baseOptions(), 'brief',
      async selection => withProviderRequestCredential(selection.provider!, 'primary', undefined, async () => {
        if (selection.provider === 'zhipu-coding') throw new KodaXNetworkError('offline');
        return okResult();
      })));
    const final = [...new Map(facts.map(fact => [fact.requestId, fact])).values()];
    expect(final).toHaveLength(2);
    expect(final[0]).toMatchObject({ purpose: 'primary', route: { attempt: 1 } });
    expect(final[1]).toMatchObject({ purpose: 'primary', route: { chainId: final[0]!.route!.chainId,
      attempt: 2, fromProvider: 'zhipu-coding' } });
  });

  it('returns the primary result without any fallback on success', async () => {
    const run = vi.fn().mockResolvedValue(okResult('primary'));
    const onFallback = vi.fn();
    const result = await invokeChildWithFallback(baseOptions(), 'brief', run, { onFallback });
    expect(result.lastText).toBe('primary');
    expect(run).toHaveBeenCalledTimes(1);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('falls back to the next provider on a rate-limit-exhausted error', async () => {
    vi.stubEnv('KODAX_FALLBACK_PROVIDERS', 'kimi-code,ark-coding');
    const run = vi
      .fn()
      .mockRejectedValueOnce(new KodaXRateLimitError('exhausted'))
      .mockResolvedValueOnce(okResult('from-kimi'));
    const onFallback = vi.fn();

    const result = await invokeChildWithFallback(baseOptions(), 'brief', run, { onFallback });

    expect(result.lastText).toBe('from-kimi');
    expect(run).toHaveBeenCalledTimes(2);
    // fallback attempt uses the next provider and clears the primary model id.
    expect(run.mock.calls[1]![0]).toMatchObject({ provider: 'kimi-code', model: undefined });
    expect(onFallback).toHaveBeenCalledWith({
      fromProvider: 'zhipu-coding',
      toProvider: 'kimi-code',
      reason: 'rate-limit exhausted',
    });
  });

  it('walks the whole chain and throws the last error when all fail', async () => {
    vi.stubEnv('KODAX_FALLBACK_PROVIDERS', 'kimi-code,ark-coding');
    const run = vi
      .fn()
      .mockRejectedValueOnce(new KodaXRateLimitError('p0'))
      .mockRejectedValueOnce(new KodaXNetworkError('p1'))
      .mockRejectedValueOnce(new KodaXProviderError('p2-last'));

    await expect(invokeChildWithFallback(baseOptions(), 'brief', run)).rejects.toThrow('p2-last');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('skips a fallback entry equal to the primary provider', async () => {
    vi.stubEnv('KODAX_FALLBACK_PROVIDERS', 'zhipu-coding,kimi-code');
    const run = vi
      .fn()
      .mockRejectedValueOnce(new KodaXRateLimitError('exhausted'))
      .mockResolvedValueOnce(okResult('from-kimi'));

    const result = await invokeChildWithFallback(baseOptions(), 'brief', run);
    expect(result.lastText).toBe('from-kimi');
    expect(run.mock.calls[1]![0]).toMatchObject({ provider: 'kimi-code' });
  });

  it('skips fallback providers outside the Runtime Actor authority ceiling', async () => {
    vi.stubEnv('KODAX_FALLBACK_PROVIDERS', 'kimi-code,ark-coding');
    const run = vi
      .fn()
      .mockRejectedValueOnce(new KodaXRateLimitError('exhausted'))
      .mockResolvedValueOnce(okResult('from-ark'));

    const result = await invokeChildWithFallback(baseOptions(), 'brief', run, {
      isProviderAllowed: (candidate) => candidate === 'ark-coding',
    });

    expect(result.lastText).toBe('from-ark');
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0]).toMatchObject({ provider: 'ark-coding' });
  });

  it('does NOT fall back on an ineligible error (task outcome / logic)', async () => {
    vi.stubEnv('KODAX_FALLBACK_PROVIDERS', 'kimi-code');
    const run = vi.fn().mockRejectedValue(new Error('child logic error'));
    await expect(invokeChildWithFallback(baseOptions(), 'brief', run)).rejects.toThrow('child logic error');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back when the request was aborted', async () => {
    vi.stubEnv('KODAX_FALLBACK_PROVIDERS', 'kimi-code');
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn().mockRejectedValue(new KodaXRateLimitError('429'));
    await expect(
      invokeChildWithFallback(baseOptions({ abortSignal: controller.signal }), 'brief', run),
    ).rejects.toThrow('429');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back on a returned success:false (provider was reachable)', async () => {
    vi.stubEnv('KODAX_FALLBACK_PROVIDERS', 'kimi-code');
    const run = vi.fn().mockResolvedValue({ ...okResult(), success: false, lastText: 'task failed' });
    const result = await invokeChildWithFallback(baseOptions(), 'brief', run);
    expect(result.success).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
