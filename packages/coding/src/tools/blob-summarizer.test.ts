import { createProviderCredentialLeaseScope, runWithProviderCredentialLeaseScope } from '@kodax-ai/llm';
/**
 * FEATURE_121 v0.7.40 — blob-summarizer unit tests (zero-cost mocked).
 */
import { describe, expect, it, vi } from 'vitest';

import type { KodaXBaseProvider, KodaXStreamResult } from '@kodax-ai/llm';

import {
  BlobSummarizerError,
  DEFAULT_SUMMARY_MAX_CHARS,
  LARGE_CONTENT_THRESHOLD_BYTES,
  createBlobSummarizer,
} from './blob-summarizer.js';

function makeMockProvider(impl: KodaXBaseProvider['stream']): KodaXBaseProvider {
  return {
    name: 'mock',
    config: {} as KodaXBaseProvider['config'],
    stream: vi.fn(impl) as KodaXBaseProvider['stream'],
  } as unknown as KodaXBaseProvider;
}

function makeStreamResult(text: string): KodaXStreamResult {
  return {
    textBlocks: text.length === 0 ? [] : [{ type: 'text', text }],
    toolBlocks: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    finishReason: 'stop',
  } as unknown as KodaXStreamResult;
}

describe('createBlobSummarizer', () => {
  it('returns trimmed summary text from the provider stream call', async () => {
    const stream = vi.fn(async () => makeStreamResult('  compressed summary text  '));
    const provider = { stream, name: 'mock' } as unknown as KodaXBaseProvider;

    const summarize = createBlobSummarizer({ provider, model: 'mock-model' });
    const result = await summarize('content '.repeat(20_000));

    expect(result).toBe('compressed summary text');
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('uses the configured model override for the provider stream call', async () => {
    const stream = vi.fn(async () => makeStreamResult('summary'));
    const provider = { stream, name: 'mock' } as unknown as KodaXBaseProvider;

    const summarize = createBlobSummarizer({ provider, model: 'selected-model' });
    await summarize('content');

    expect(stream).toHaveBeenCalledWith(
      expect.any(Array),
      [],
      expect.any(String),
      undefined,
      expect.objectContaining({ modelOverride: 'selected-model' }),
      expect.any(AbortSignal),
    );
  });

  it('propagates caller abort signal to the provider stream call mid-flight', async () => {
    // Mock provider hangs until the (forwarded) signal aborts, simulating
    // a long-running LLM call. This is the realistic shape: a caller mid-
    // task pressing Esc must terminate the in-flight summarize.
    let receivedSignal: AbortSignal | undefined;
    const provider = {
      name: 'mock',
      stream: vi.fn(async (
        _messages: unknown,
        _tools: unknown,
        _system: unknown,
        _reasoning: unknown,
        _streamOptions: unknown,
        signal?: AbortSignal,
      ) => {
        receivedSignal = signal;
        return new Promise<KodaXStreamResult>((resolve, reject) => {
          if (!signal) return resolve(makeStreamResult('hung'));
          signal.addEventListener('abort', () => {
            reject(new Error(`aborted: ${(signal.reason as Error)?.message ?? 'unknown'}`));
          }, { once: true });
        });
      }),
    } as unknown as KodaXBaseProvider;

    const callerCtrl = new AbortController();
    const summarize = createBlobSummarizer({ provider, model: 'mock-model' });

    const resultPromise = summarize('payload', { abortSignal: callerCtrl.signal })
      .catch((err) => err);

    // Give the provider mock a tick to register its abort listener.
    await new Promise((resolve) => setImmediate(resolve));
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(false);

    callerCtrl.abort(new Error('user aborted'));

    const result = await resultPromise;
    expect(result).toBeInstanceOf(BlobSummarizerError);
    expect((result as Error).message).toContain('user aborted');
    expect(receivedSignal!.aborted).toBe(true);
  });

  it('throws BlobSummarizerError when provider returns empty text', async () => {
    const provider = {
      name: 'mock',
      stream: vi.fn(async () => makeStreamResult('')),
    } as unknown as KodaXBaseProvider;

    const summarize = createBlobSummarizer({ provider, model: 'mock-model' });

    await expect(summarize('content')).rejects.toBeInstanceOf(BlobSummarizerError);
    await expect(summarize('content')).rejects.toThrow(/empty text/);
  });

  it('throws BlobSummarizerError when called with empty content', async () => {
    const provider = {
      name: 'mock',
      stream: vi.fn(async () => makeStreamResult('summary')),
    } as unknown as KodaXBaseProvider;

    const summarize = createBlobSummarizer({ provider, model: 'mock-model' });

    await expect(summarize('')).rejects.toBeInstanceOf(BlobSummarizerError);
    await expect(summarize('')).rejects.toThrow(/empty content/);
  });

  it('wraps provider errors in BlobSummarizerError with cause', async () => {
    const upstream = new Error('provider rate-limit');
    const provider = {
      name: 'mock',
      stream: vi.fn(async () => {
        throw upstream;
      }),
    } as unknown as KodaXBaseProvider;

    const summarize = createBlobSummarizer({ provider, model: 'mock-model' });

    await expect(summarize('content')).rejects.toMatchObject({
      name: 'BlobSummarizerError',
      message: expect.stringContaining('provider rate-limit'),
      cause: upstream,
    });
  });

  it('uses the supplied timeoutMs override (short timeout fires)', async () => {
    let providerSignal: AbortSignal | undefined;
    const provider = {
      name: 'mock',
      stream: vi.fn(async (
        _messages: unknown,
        _tools: unknown,
        _system: unknown,
        _reasoning: unknown,
        _streamOptions: unknown,
        signal?: AbortSignal,
      ) => {
        providerSignal = signal;
        // Never resolves; rely on caller-side timeout abort propagation.
        return new Promise<KodaXStreamResult>(() => {});
      }),
    } as unknown as KodaXBaseProvider;

    const summarize = createBlobSummarizer({
      provider,
      model: 'mock-model',
      timeoutMs: 50,
    });

    // The mock provider never resolves; we observe that the abort signal
    // it received fires due to timeout, which a real provider would honor
    // and throw an abort error. We simulate that here by failing fast on
    // the signal.
    const resultPromise = summarize('content').catch((e) => e);
    // Wait long enough for the 50ms timeout to fire.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(providerSignal?.aborted).toBe(true);
    // Don't await resultPromise — the mock provider doesn't actually
    // honor signal so the promise hangs. The aborted observation is the
    // load-bearing assertion.
    void resultPromise;
  });
});

describe('constants', () => {
  it('LARGE_CONTENT_THRESHOLD_BYTES is 100 KB', () => {
    expect(LARGE_CONTENT_THRESHOLD_BYTES).toBe(100 * 1024);
  });

  it('DEFAULT_SUMMARY_MAX_CHARS is 8000 — keeps banner in 2-10K band', () => {
    expect(DEFAULT_SUMMARY_MAX_CHARS).toBe(8000);
    expect(DEFAULT_SUMMARY_MAX_CHARS).toBeGreaterThanOrEqual(2000);
    expect(DEFAULT_SUMMARY_MAX_CHARS).toBeLessThanOrEqual(10_000);
  });
});

it('summarizes through a CLI bridge without acquiring an invented API key', async () => {
  const acquire = vi.fn(async () => { throw new Error('Bridge owns authentication'); });
  const scope = createProviderCredentialLeaseScope({ allowedProviders: ['bridge-blob'], acquire });
  const stream = vi.fn(async () => makeStreamResult('summary'));
  const provider = { name: 'bridge-blob', stream, getReasoningProfile: () => undefined,
    getCapabilityProfile: () => ({ transport: 'cli-bridge', conversationSemantics: 'full-history', mcpSupport: 'none' }) } as unknown as KodaXBaseProvider;
  try { expect(await runWithProviderCredentialLeaseScope(scope, () => createBlobSummarizer({ provider, model: undefined })('evidence'))).toBe('summary'); }
  finally { scope.close(); }
  expect(acquire).not.toHaveBeenCalled(); expect(stream).toHaveBeenCalledOnce();
});
