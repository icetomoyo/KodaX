import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithProviderCredential, runWithProviderRequestObserver, runWithScopedConfig, withProviderRequestCredential,
  type KodaXBaseProvider, type KodaXProviderStreamOptions, type ProviderRequestObservation } from '@kodax-ai/llm';
import type { KodaXOptions } from '../types.js';
import { cancelPromptCacheWarming, runWithPromptCacheWarming, streamKeepingCacheWarm } from './prompt-cache-warmer.js';

const MINUTE = 60_000;

function usage(inputTokens: number) {
  return { textBlocks: [], toolBlocks: [], thinkingBlocks: [], usage: { inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 } };
}

function fakeProvider(overrides: { model?: string; capability?: string; shortTtl?: '5m' | undefined; promptTokens?: number } = {}) {
  const calls: KodaXProviderStreamOptions[] = [];
  const provider = {
    name: 'anthropic',
    getModel: () => overrides.model ?? 'claude-sonnet-4-6',
    getCacheCapabilities: () => ({ dialect: 'anthropic', ...('shortTtl' in overrides ? overrides.shortTtl ? { shortTtl: overrides.shortTtl } : {} : { shortTtl: '5m' }) }),
    getReasoningCapability: () => overrides.capability ?? 'native-adaptive',
    getReasoningProfile: () => undefined,
    stream: vi.fn(async (_m: unknown, _t: unknown, _s: unknown, _r: unknown, options: KodaXProviderStreamOptions) => {
      calls.push(options);
      return usage(overrides.promptTokens ?? 100_000);
    }),
  };
  return { provider: provider as unknown as KodaXBaseProvider, calls };
}

/** Opus 5.5 at 400k tokens: an idle refresh saves 0.15 x (6.25 - 0.5) x 0.4 - 0.2 = 0.145 dollars. */
const LARGE = { model: 'claude-opus-5-5', promptTokens: 400_000 };

function modelTurn(provider: KodaXBaseProvider, extra: Partial<KodaXProviderStreamOptions> = {}) {
  return withProviderRequestCredential(provider, 'primary', undefined, signal =>
    streamKeepingCacheWarm(provider, [{ role: 'user', content: 'hi' }], [], 'system', true,
      { promptCacheKey: 'key', modelOverride: undefined, maxOutputTokensOverride: 32_000, ...extra }, signal));
}

/** One Run: a model turn, then `workMs` without model requests (a long tool, or a person deciding). */
function runWithGap(provider: KodaXBaseProvider, workMs: number, options: Partial<KodaXOptions> = {}) {
  const onTextDelta = vi.fn();
  return runWithPromptCacheWarming(options as KodaXOptions, async () => {
    await modelTurn(provider, { onTextDelta });
    await vi.advanceTimersByTimeAsync(workMs);
    return onTextDelta;
  });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cancelPromptCacheWarming(); vi.useRealTimers(); });

describe('prompt cache warming during a Run', () => {
  it('resends the last request with a one-token cap and no callbacks before the entry expires', async () => {
    const { provider, calls } = fakeProvider();
    const onTextDelta = await runWithGap(provider, 5 * MINUTE);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ promptCacheKey: 'key', maxOutputTokensOverride: 1, singleAttempt: true });
    expect(calls[1]!.onTextDelta).toBeUndefined();
    expect(onTextDelta).not.toHaveBeenCalled();
  });

  it('sends nothing when the next model turn starts before the refresh is due', async () => {
    const { provider, calls } = fakeProvider();
    await runWithPromptCacheWarming({} as KodaXOptions, async () => {
      await modelTurn(provider);
      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      await modelTurn(provider);
      await vi.advanceTimersByTimeAsync(4 * MINUTE);
    });
    expect(calls).toHaveLength(2);
  });

  it('sends nothing while a model turn is still streaming', async () => {
    const { provider, calls } = fakeProvider();
    await runWithPromptCacheWarming({} as KodaXOptions, async () => {
      await modelTurn(provider);
      vi.mocked(provider.stream).mockImplementationOnce(async (_m, _t, _s, _r, options) => {
        calls.push(options!);
        await new Promise(resolve => setTimeout(resolve, 6 * MINUTE));
        return usage(100_000);
      });
      const slow = modelTurn(provider);
      await vi.advanceTimersByTimeAsync(6 * MINUTE);
      await slow;
    });
    expect(calls).toHaveLength(2);
  });

  it('keeps warming for sixty minutes after the last real request', async () => {
    // Refreshes every 4.5 minutes reach 58.5 minutes; each saves 0.315 dollars on a 100k Sonnet prompt.
    const { provider, calls } = fakeProvider();
    await runWithGap(provider, 120 * MINUTE);
    expect(calls).toHaveLength(1 + 13);
  });

  it('does not warm a prompt whose loss is under five cents', async () => {
    // Sonnet 4.6: (3.75 - 0.3) per million tokens, so 10k tokens risk 3.5 cents.
    const { provider, calls } = fakeProvider({ promptTokens: 10_000 });
    await runWithGap(provider, 10 * MINUTE);
    expect(calls).toHaveLength(1);
  });

  it('skips models whose thinking budget follows the output cap', async () => {
    const { provider, calls } = fakeProvider({ capability: 'native-budget' });
    await runWithGap(provider, 10 * MINUTE);
    expect(calls).toHaveLength(1);
  });

  it('skips models without a declared cache lifetime', async () => {
    const { provider, calls } = fakeProvider({ shortTtl: undefined });
    await runWithGap(provider, 10 * MINUTE);
    expect(calls).toHaveLength(1);
  });

  it('follows the prompt-cache off switch and the cacheWarming off setting', async () => {
    const { provider, calls } = fakeProvider();
    await runWithScopedConfig({ disablePromptCache: true }, () => runWithGap(provider, 10 * MINUTE));
    await runWithScopedConfig({ cacheWarming: 'off' }, () => runWithGap(provider, 10 * MINUTE));
    expect(calls).toHaveLength(2);
  });

  it('stops warming after a failed refresh', async () => {
    const { provider, calls } = fakeProvider();
    vi.mocked(provider.stream).mockImplementation(async (_m, _t, _s, _r, options) => {
      calls.push(options!);
      if (calls.length > 1) throw new Error('refused');
      return usage(100_000);
    });
    await runWithGap(provider, 30 * MINUTE);
    expect(calls).toHaveLength(2);
  });

  it('does not refresh an entry that has likely expired already', async () => {
    const { provider, calls } = fakeProvider();
    await runWithPromptCacheWarming({} as KodaXOptions, async () => {
      await modelTurn(provider);
      vi.setSystemTime(Date.now() + 290_000);
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
    });
    expect(calls).toHaveLength(1);
  });

  it('reports refreshes to the request observer as cache_refresh, apart from model turns', async () => {
    const { provider } = fakeProvider();
    const facts: ProviderRequestObservation[] = [];
    await runWithProviderRequestObserver(fact => facts.push(fact), () => runWithGap(provider, 5 * MINUTE));
    const purposes = facts.filter(fact => fact.state === 'succeeded').map(fact => fact.purpose);
    expect(purposes).toEqual(['primary', 'cache_refresh']);
  });
});

describe('prompt cache warming after a Run, while the Session is idle', () => {
  const session = { session: { id: 'session-1' } } as Partial<KodaXOptions>;

  it('keeps a large prompt warm for thirty minutes after the last request', async () => {
    const { provider, calls } = fakeProvider(LARGE);
    await runWithGap(provider, 0, session);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    // Refreshes at 4.5, 9 ... 27 minutes.
    expect(calls).toHaveLength(1 + 6);
  });

  it('lets an idle prompt expire when a 15% chance of reuse does not pay for refreshing it', async () => {
    const { provider, calls } = fakeProvider();
    await runWithGap(provider, 0, session);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(calls).toHaveLength(1);
  });

  it('does not warm after the Run with the run setting, or without a Session', async () => {
    const { provider, calls } = fakeProvider(LARGE);
    await runWithScopedConfig({ cacheWarming: 'run' }, () => runWithGap(provider, 0, session));
    await runWithGap(provider, 0);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(calls).toHaveLength(2);
  });

  it('stops when the Session is cancelled, for example after compaction', async () => {
    const { provider, calls } = fakeProvider(LARGE);
    await runWithGap(provider, 0, session);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    cancelPromptCacheWarming('session-1');
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(calls).toHaveLength(2);
  });

  it('hands over to the next Run of the same Session', async () => {
    const { provider, calls } = fakeProvider(LARGE);
    await runWithGap(provider, 0, session);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    await runWithGap(provider, 0, session);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    // The second Run's request read the entry itself, so no refresh was due yet.
    expect(calls).toHaveLength(2);
  });

  it('gives a nested Run its own warmer, which stops when it ends', async () => {
    const { provider, calls } = fakeProvider(LARGE);
    await runWithPromptCacheWarming({} as KodaXOptions, async () => {
      await runWithGap(provider, 0, session);
    });
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(calls).toHaveLength(1);
  });

  it('skips idle refreshes once a borrowed key has ended with its Run', async () => {
    const { provider, calls } = fakeProvider(LARGE);
    const facts: ProviderRequestObservation[] = [];
    await runWithProviderRequestObserver(fact => facts.push(fact), () =>
      runWithProviderCredential('anthropic', 'borrowed-key', () => runWithGap(provider, 0, session)));
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(calls).toHaveLength(1);
    expect(facts.filter(fact => fact.state === 'failed')).toEqual([]);
  });
});
