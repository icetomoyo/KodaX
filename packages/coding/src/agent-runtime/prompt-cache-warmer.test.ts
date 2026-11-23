import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithProviderRequestObserver, runWithScopedConfig, withProviderRequestCredential, type KodaXBaseProvider,
  type KodaXProviderStreamOptions, type ProviderRequestObservation } from '@kodax-ai/llm';
import type { KodaXEvents } from '../types.js';
import { runWithPromptCacheWarming, streamKeepingCacheWarm } from './prompt-cache-warmer.js';

const MINUTE = 60_000;

function fakeProvider(overrides: { model?: string; capability?: string; shortTtl?: '5m' | undefined } = {}) {
  const calls: KodaXProviderStreamOptions[] = [];
  const provider = {
    name: 'anthropic',
    getModel: () => overrides.model ?? 'claude-sonnet-4-6',
    getCacheCapabilities: () => ({ dialect: 'anthropic', ...('shortTtl' in overrides ? overrides.shortTtl ? { shortTtl: overrides.shortTtl } : {} : { shortTtl: '5m' }) }),
    getReasoningCapability: () => overrides.capability ?? 'native-adaptive',
    getReasoningProfile: () => undefined,
    stream: vi.fn(async (_m: unknown, _t: unknown, _s: unknown, _r: unknown, options: KodaXProviderStreamOptions) => {
      calls.push(options);
      return { textBlocks: [], toolBlocks: [], thinkingBlocks: [], usage: { inputTokens: 100_000, outputTokens: 10, totalTokens: 100_010 } };
    }),
  };
  return { provider: provider as unknown as KodaXBaseProvider, calls };
}

/** One Run: a model turn, then a wait of `waitMs` that starts `idleMs` after the request. */
async function runWithWait(provider: KodaXBaseProvider, waitMs: number, options: { idleMs?: number; reasoning?: boolean } = {}) {
  const onTextDelta = vi.fn();
  return runWithPromptCacheWarming({ events: {
    beforeToolExecute: () => new Promise<boolean>(resolve => setTimeout(() => resolve(true), waitMs)),
  } as KodaXEvents }, async ({ events }) => {
    await withProviderRequestCredential(provider, 'primary', undefined, signal =>
      streamKeepingCacheWarm(provider, [{ role: 'user', content: 'hi' }], [], 'system', options.reasoning ?? true,
        { promptCacheKey: 'key', modelOverride: undefined, maxOutputTokensOverride: 32_000, onTextDelta }, signal));
    if (options.idleMs) await vi.advanceTimersByTimeAsync(options.idleMs);
    const waiting = events!.beforeToolExecute!('bash', {});
    await vi.advanceTimersByTimeAsync(waitMs);
    expect(await waiting).toBe(true);
    return onTextDelta;
  });
}

describe('prompt cache warming while a Run waits', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resends the last request with a one-token cap and no callbacks before the entry expires', async () => {
    const { provider, calls } = fakeProvider();
    const onTextDelta = await runWithWait(provider, 5 * MINUTE);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ promptCacheKey: 'key', maxOutputTokensOverride: 1, singleAttempt: true });
    expect(calls[1]!.onTextDelta).toBeUndefined();
    expect(onTextDelta).not.toHaveBeenCalled();
  });

  it('sends nothing when the wait ends before the refresh is due', async () => {
    const { provider, calls } = fakeProvider();
    await runWithWait(provider, 4 * MINUTE);
    expect(calls).toHaveLength(1);
  });

  it('stops once the refreshes together would cost as much as one rewrite', async () => {
    // Sonnet 4.6: a read costs 0.3 and a 5-minute write 3.75 per million tokens, so 11 refreshes pay.
    const { provider, calls } = fakeProvider();
    await runWithWait(provider, 120 * MINUTE);
    expect(calls).toHaveLength(1 + 11);
  });

  it('stops sixty minutes after the last real request', async () => {
    // Opus 5.5 would pay for 23 refreshes; refreshes every 4.5 minutes reach 58.5 minutes.
    const { provider, calls } = fakeProvider({ model: 'claude-opus-5-5' });
    await runWithWait(provider, 120 * MINUTE);
    expect(calls).toHaveLength(1 + 13);
  });

  it('refreshes at once when the wait starts after the refresh was due but before the entry is likely gone', async () => {
    const { provider, calls } = fakeProvider();
    await runWithWait(provider, 1_000, { idleMs: 280_000 });
    expect(calls).toHaveLength(2);
  });

  it('does not refresh an entry that has likely expired already', async () => {
    const { provider, calls } = fakeProvider();
    await runWithWait(provider, 10 * MINUTE, { idleMs: 290_000 });
    expect(calls).toHaveLength(1);
  });

  it('skips models whose thinking budget follows the output cap', async () => {
    const { provider, calls } = fakeProvider({ capability: 'native-budget' });
    await runWithWait(provider, 10 * MINUTE);
    expect(calls).toHaveLength(1);
  });

  it('skips models without a declared cache lifetime', async () => {
    const { provider, calls } = fakeProvider({ shortTtl: undefined });
    await runWithWait(provider, 10 * MINUTE);
    expect(calls).toHaveLength(1);
  });

  it('follows the prompt-cache off switch', async () => {
    const { provider, calls } = fakeProvider();
    await runWithScopedConfig({ disablePromptCache: true }, () => runWithWait(provider, 10 * MINUTE));
    expect(calls).toHaveLength(1);
  });

  it('stops warming after a failed refresh', async () => {
    const { provider, calls } = fakeProvider();
    vi.mocked(provider.stream).mockImplementation(async (_m, _t, _s, _r, options) => {
      calls.push(options!);
      if (calls.length > 1) throw new Error('refused');
      return { textBlocks: [], toolBlocks: [], thinkingBlocks: [], usage: { inputTokens: 100_000, outputTokens: 1, totalTokens: 100_001 } };
    });
    await runWithWait(provider, 30 * MINUTE);
    expect(calls).toHaveLength(2);
  });

  it('reports refreshes to the Run request observer as cache_refresh, apart from model turns', async () => {
    const { provider } = fakeProvider();
    const facts: ProviderRequestObservation[] = [];
    await runWithProviderRequestObserver(fact => facts.push(fact), () => runWithWait(provider, 5 * MINUTE));
    const purposes = facts.filter(fact => fact.state === 'succeeded').map(fact => fact.purpose);
    expect(purposes).toEqual(['primary', 'cache_refresh']);
  });

  it('leaves absent callbacks absent', async () => {
    await runWithPromptCacheWarming({ events: { beforeToolExecute: async () => true } as KodaXEvents }, async ({ events }) => {
      expect(events?.requestToolApproval).toBeUndefined();
      expect(events?.askUser).toBeUndefined();
    });
  });
});
