import { describe, expect, it, vi } from 'vitest';
import { APIUserAbortError as AnthropicAPIUserAbortError } from '@anthropic-ai/sdk';
import { APIUserAbortError as OpenAIAPIUserAbortError } from 'openai';
import { KodaXBaseProvider } from './base.js';
import type { KodaXOnRetryAfterCallback } from './base.js';
import { KodaXProviderError, KodaXRateLimitError } from '../errors.js';
import { runWithScopedConfig } from '../run-scoped-config.js';
import type {
  KodaXMessage,
  KodaXNormalizedReasoningRequest,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningCapability,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '../types.js';

class TestProvider extends KodaXBaseProvider {
  readonly name = 'test-provider';
  readonly supportsThinking = true;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_PROVIDER_API_KEY',
    model: 'default-model',
    models: [
      { id: 'native-toggle-model', reasoningCapability: 'native-toggle' },
      { id: 'plain-model' },
      {
        id: 'small-window-model',
        contextWindow: 50_000,
        maxOutputTokens: 8_000,
      },
    ],
    supportsThinking: true,
    reasoningCapability: 'native-budget',
    reasoningProfile: {
      effortStrategy: 'provider-budget',
      supportedEfforts: [
        { value: 'low' },
        { value: 'high' },
      ],
    },
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  };

  async stream(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    _streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    throw new Error('not implemented in unit test');
  }

  exposeConfiguredReasoningCapability(modelOverride?: string): KodaXReasoningCapability {
    return this.getConfiguredReasoningCapability(modelOverride);
  }

  exposeShouldFallbackForReasoningError(error: unknown, ...terms: string[]): boolean {
    return this.shouldFallbackForReasoningError(error, ...terms);
  }

  exposeShouldFallbackForForcedToolChoiceError(error: unknown): boolean {
    return this.shouldFallbackForForcedToolChoiceError(error);
  }

  exposeReasoningFallbackChain(capability: KodaXReasoningCapability): KodaXReasoningCapability[] {
    return this.getReasoningFallbackChain(capability);
  }

  exposeNormalizeReasoning(reasoning?: boolean | KodaXReasoningRequest): KodaXNormalizedReasoningRequest {
    return this.normalizeReasoning(reasoning);
  }

  exposeValidateExplicitReasoningEffort(reasoning: KodaXReasoningRequest, modelOverride?: string): void {
    this.validateExplicitReasoningEffort(this.normalizeReasoning(reasoning), modelOverride);
  }

  exposeWithRateLimit<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
    retries = 3,
    onRateLimit?: (attempt: number, maxRetries: number, delayMs: number) => void,
    onRetryAfter?: KodaXOnRetryAfterCallback,
  ): Promise<T> {
    return this.withRateLimit(fn, signal, retries, onRateLimit, onRetryAfter);
  }
}

class NoEffortMetadataProvider extends KodaXBaseProvider {
  readonly name = 'no-effort-metadata';
  readonly supportsThinking = true;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_PROVIDER_API_KEY',
    model: 'default-model',
    supportsThinking: true,
    reasoningCapability: 'native-budget',
  };

  async stream(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    _streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    throw new Error('not implemented in unit test');
  }

  exposeValidateExplicitReasoningEffort(reasoning: KodaXReasoningRequest): void {
    this.validateExplicitReasoningEffort(this.normalizeReasoning(reasoning));
  }
}

// Mirrors the `kimi-k2.7-code` / `minimax-m2-always` capability shape:
// thinking cannot be disabled, so `none`/`minimal` are hard-rejected, and
// the model has a `defaultEffort` it always thinks at.
class AlwaysOnThinkingProvider extends KodaXBaseProvider {
  readonly name = 'always-on-thinking';
  readonly supportsThinking = true;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_PROVIDER_API_KEY',
    model: 'always-on-model',
    supportsThinking: true,
    reasoningCapability: 'native-effort',
    reasoningProfile: {
      effortStrategy: 'prompt-only',
      defaultEffort: 'high',
      supportedEfforts: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
      localRejectEfforts: ['none', 'minimal'],
    },
  };

  async stream(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    _streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    throw new Error('not implemented in unit test');
  }

  exposeResolveIntent(reasoning?: boolean | KodaXReasoningRequest) {
    const capability = this.getReasoningProfile();
    if (!capability) {
      throw new Error('expected reasoningProfile to resolve');
    }
    return this.resolveReasoningProfileIntent(this.normalizeReasoning(reasoning), capability);
  }
}

describe('KodaXBaseProvider', () => {
  it('deduplicates the default model from getAvailableModels', () => {
    const provider = new TestProvider();
    expect(provider.getAvailableModels()).toEqual([
      'default-model',
      'native-toggle-model',
      'plain-model',
      'small-window-model',
    ]);
  });

  it('prefers model-specific reasoning capability overrides from descriptors', () => {
    const provider = new TestProvider();
    expect(provider.exposeConfiguredReasoningCapability()).toBe('native-budget');
    expect(provider.exposeConfiguredReasoningCapability('native-toggle-model')).toBe('native-toggle');
  });

  it('recognizes unsupported parameter errors for reasoning fallback', () => {
    const provider = new TestProvider();
    expect(
      provider.exposeShouldFallbackForReasoningError(
        new Error('Unsupported reasoning_effort parameter'),
        'reasoning_effort',
      ),
    ).toBe(true);
    expect(
      provider.exposeShouldFallbackForReasoningError(
        new Error('network disconnected'),
        'reasoning_effort',
      ),
    ).toBe(false);
  });

  it('treats generic upstream 5xx as forced tool_choice fallback candidates', () => {
    const provider = new TestProvider();
    expect(
      provider.exposeShouldFallbackForForcedToolChoiceError(
        Object.assign(new Error('Internal Server Error'), { status: 500 }),
      ),
    ).toBe(true);
    expect(
      provider.exposeShouldFallbackForForcedToolChoiceError(
        new Error('unsupported parameter: tool_choice'),
      ),
    ).toBe(true);
    expect(
      provider.exposeShouldFallbackForForcedToolChoiceError(
        new Error("tool_choice 'specified' is incompatible with thinking enabled"),
      ),
    ).toBe(true);
    expect(
      provider.exposeShouldFallbackForForcedToolChoiceError(
        new Error('network disconnected'),
      ),
    ).toBe(false);
    expect(
      provider.exposeShouldFallbackForForcedToolChoiceError(
        new Error('requested 550 tokens, reduce max output'),
      ),
    ).toBe(false);
  });

  it('returns the expected fallback chains for reasoning capabilities', () => {
    const provider = new TestProvider();
    expect(provider.exposeReasoningFallbackChain('native-budget')).toEqual([
      'native-budget',
      'native-toggle',
      'none',
    ]);
    expect(provider.exposeReasoningFallbackChain('native-effort')).toEqual([
      'native-effort',
      'none',
    ]);
  });

  it('normalizes boolean reasoning flags into full requests', () => {
    const provider = new TestProvider();
    expect(provider.exposeNormalizeReasoning(true)).toMatchObject({
      enabled: true,
      effort: 'auto',
    });
    expect(provider.exposeNormalizeReasoning(false)).toMatchObject({
      enabled: false,
      effort: 'none',
    });
  });

  it('rejects explicit unsupported reasoning effort when metadata enumerates values', () => {
    const provider = new TestProvider();
    expect(() => provider.exposeValidateExplicitReasoningEffort({ effort: 'low' })).not.toThrow();
    expect(() => provider.exposeValidateExplicitReasoningEffort({ effort: 'minimal' }))
      .toThrow(/does not support reasoning effort "minimal"/);
  });

  it('rejects provider-specific effort values when metadata is absent', () => {
    const provider = new NoEffortMetadataProvider();
    expect(() => provider.exposeValidateExplicitReasoningEffort({ effort: 'high' })).not.toThrow();
    expect(() => provider.exposeValidateExplicitReasoningEffort({ effort: 'xhigh' }))
      .toThrow(/does not advertise provider-specific reasoning effort "xhigh"/);
  });

  it('reads contextWindow from the active model descriptor when present', () => {
    const provider = new TestProvider();
    expect(provider.getEffectiveContextWindow()).toBe(200_000);
    expect(provider.getEffectiveContextWindow('default-model')).toBe(200_000);
    expect(provider.getEffectiveContextWindow('small-window-model')).toBe(50_000);
    expect(provider.getEffectiveContextWindow('plain-model')).toBe(200_000);
    expect(provider.getEffectiveContextWindow('unknown-model')).toBe(200_000);
  });

  it('exposes the exact wire model used by provider requests', () => {
    class WireAliasProvider extends KodaXBaseProvider {
      readonly name = 'wire-alias';
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'WIRE_ALIAS_KEY',
        model: 'friendly-model',
        models: [{ id: 'friendly-model', wireModel: 'upstream-model-v2' }],
        supportsThinking: false,
      };
      async stream(): Promise<KodaXStreamResult> {
        throw new Error('not implemented in unit test');
      }
    }
    const provider = new WireAliasProvider();
    expect(provider.getWireModel()).toBe('upstream-model-v2');
    expect(provider.getWireModel('friendly-model')).toBe('upstream-model-v2');
    expect(provider.getWireModel('unknown-model')).toBe('unknown-model');
  });

  it('reads default-model contextWindow from models[] when declared there', () => {
    // Regression: a custom provider whose DEFAULT model also appears in
    // models[] with a per-model contextWindow must resolve to that window,
    // not the provider-level fallback. Previously getModelDescriptor
    // short-circuited the default model to a bare { id }, dropping the
    // declared contextWindow and silently using the provider default.
    class DefaultInListProvider extends KodaXBaseProvider {
      readonly name = 'default-in-list';
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'DEFAULT_IN_LIST_KEY',
        model: 'glm-5.2',
        models: [
          { id: 'glm-5.2', contextWindow: 1_000_000, maxOutputTokens: 131_072 },
          { id: 'glm-5.1' },
        ],
        supportsThinking: false,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      };
      async stream(): Promise<KodaXStreamResult> {
        throw new Error('not implemented in unit test');
      }
    }
    const provider = new DefaultInListProvider();
    // Default model resolved both explicitly and via the no-arg overload.
    expect(provider.getEffectiveContextWindow('glm-5.2')).toBe(1_000_000);
    expect(provider.getEffectiveContextWindow()).toBe(1_000_000);
    expect(provider.getContextWindow()).toBe(1_000_000);
    expect(provider.getEffectiveMaxOutputTokens('glm-5.2')).toBe(131_072);
    // A models[] entry without contextWindow still falls back to provider level.
    expect(provider.getEffectiveContextWindow('glm-5.1')).toBe(200_000);
  });

  it('reads maxOutputTokens from the active model descriptor when present', () => {
    const provider = new TestProvider();
    expect(provider.getEffectiveMaxOutputTokens()).toBe(32_000);
    expect(provider.getEffectiveMaxOutputTokens('default-model')).toBe(32_000);
    expect(provider.getEffectiveMaxOutputTokens('small-window-model')).toBe(8_000);
    expect(provider.getEffectiveMaxOutputTokens('plain-model')).toBe(32_000);
  });

  it('keeps one-shot maxOutputTokens override above descriptor data', () => {
    const provider = new TestProvider();
    provider.setMaxOutputTokensOverride(64_000);
    try {
      expect(provider.getEffectiveMaxOutputTokens('small-window-model')).toBe(64_000);
    } finally {
      provider.setMaxOutputTokensOverride(undefined);
    }
  });

  it('keeps env KODAX_MAX_OUTPUT_TOKENS above descriptor data', () => {
    const provider = new TestProvider();
    vi.stubEnv('KODAX_MAX_OUTPUT_TOKENS', '12345');
    try {
      expect(provider.getEffectiveMaxOutputTokens('small-window-model')).toBe(12_345);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('uses a valid run-scoped maxOutputTokens above descriptor data', () => {
    const provider = new TestProvider();
    const value = runWithScopedConfig({ maxOutputTokens: 5_000 }, () =>
      provider.getEffectiveMaxOutputTokens('small-window-model'),
    );
    expect(value).toBe(5_000);
  });

  it('ignores a non-positive/NaN run-scoped maxOutputTokens (never emits a bad max_tokens)', () => {
    const provider = new TestProvider();
    // 0 / -1 / NaN would produce a provider 400 if passed through verbatim;
    // they must be treated as "unset" so the descriptor value (8_000) resolves.
    for (const bad of [0, -1, Number.NaN]) {
      const value = runWithScopedConfig({ maxOutputTokens: bad }, () =>
        provider.getEffectiveMaxOutputTokens('small-window-model'),
      );
      expect(value).toBe(8_000);
    }
  });

  it('keeps backwards-compatible getContextWindow() reading the default model', () => {
    const provider = new TestProvider();
    // Existing call sites still use the no-arg overload — must continue
    // resolving to the provider-level (or default-model) value.
    expect(provider.getContextWindow()).toBe(200_000);
  });

  it('cascades streamMaxDurationMs from per-model descriptor → provider → undefined', () => {
    class ScopedProvider extends KodaXBaseProvider {
      readonly name = 'scoped';
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'SCOPED_KEY',
        model: 'default-model',
        models: [
          { id: 'override-model', streamMaxDurationMs: 123_456 },
          { id: 'inherit-model' },
        ],
        supportsThinking: false,
        streamMaxDurationMs: 300_000,
      };
      async stream(
        _m: KodaXMessage[], _t: KodaXToolDefinition[], _s: string,
        _r?: boolean | KodaXReasoningRequest,
        _o?: KodaXProviderStreamOptions, _sig?: AbortSignal,
      ): Promise<KodaXStreamResult> { throw new Error('unused'); }
    }
    const provider = new ScopedProvider();
    expect(provider.getStreamMaxDurationMs('override-model')).toBe(123_456);
    expect(provider.getStreamMaxDurationMs('inherit-model')).toBe(300_000);
    expect(provider.getStreamMaxDurationMs('default-model')).toBe(300_000);
    expect(provider.getStreamMaxDurationMs()).toBe(300_000);

    class NoProviderCap extends KodaXBaseProvider {
      readonly name = 'nocap';
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'NOCAP_KEY',
        model: 'default-model',
        models: [{ id: 'specific', streamMaxDurationMs: 200_000 }],
        supportsThinking: false,
      };
      async stream(
        _m: KodaXMessage[], _t: KodaXToolDefinition[], _s: string,
        _r?: boolean | KodaXReasoningRequest,
        _o?: KodaXProviderStreamOptions, _sig?: AbortSignal,
      ): Promise<KodaXStreamResult> { throw new Error('unused'); }
    }
    const nocap = new NoProviderCap();
    expect(nocap.getStreamMaxDurationMs('specific')).toBe(200_000);
    expect(nocap.getStreamMaxDurationMs('default-model')).toBeUndefined();
    expect(nocap.getStreamMaxDurationMs()).toBeUndefined();
  });

  it('cascades replayReasoningContent from per-model → provider → false', () => {
    class ScopedProvider extends KodaXBaseProvider {
      readonly name = 'scoped';
      readonly supportsThinking = true;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'SCOPED_KEY',
        model: 'default-model',
        models: [
          { id: 'force-off', replayReasoningContent: false },
          { id: 'force-on', replayReasoningContent: true },
          { id: 'inherit' },
        ],
        supportsThinking: true,
        replayReasoningContent: true,
      };
      async stream(
        _m: KodaXMessage[], _t: KodaXToolDefinition[], _s: string,
        _r?: boolean | KodaXReasoningRequest,
        _o?: KodaXProviderStreamOptions, _sig?: AbortSignal,
      ): Promise<KodaXStreamResult> { throw new Error('unused'); }
    }
    const provider = new ScopedProvider();
    expect(provider.getEffectiveReplayReasoningContent('force-on')).toBe(true);
    // Per-model false MUST win even though provider says true (the real-world
    // case: a gateway routing both DeepSeek V4 and OpenAI proper).
    expect(provider.getEffectiveReplayReasoningContent('force-off')).toBe(false);
    expect(provider.getEffectiveReplayReasoningContent('inherit')).toBe(true);
    expect(provider.getEffectiveReplayReasoningContent('default-model')).toBe(true);
    expect(provider.getEffectiveReplayReasoningContent()).toBe(true);

    class NoProviderDefault extends KodaXBaseProvider {
      readonly name = 'no-default';
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'NO_DEFAULT_KEY',
        model: 'default-model',
        supportsThinking: false,
      };
      async stream(
        _m: KodaXMessage[], _t: KodaXToolDefinition[], _s: string,
        _r?: boolean | KodaXReasoningRequest,
        _o?: KodaXProviderStreamOptions, _sig?: AbortSignal,
      ): Promise<KodaXStreamResult> { throw new Error('unused'); }
    }
    expect(new NoProviderDefault().getEffectiveReplayReasoningContent()).toBe(false);
  });

  it('cascades strictThinkingSignature from per-model → provider → false', () => {
    class ScopedProvider extends KodaXBaseProvider {
      readonly name = 'scoped';
      readonly supportsThinking = true;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'SCOPED_KEY',
        model: 'default-model',
        models: [
          { id: 'force-lenient', strictThinkingSignature: false },
          { id: 'force-strict', strictThinkingSignature: true },
          { id: 'inherit' },
        ],
        supportsThinking: true,
        strictThinkingSignature: true,
      };
      async stream(
        _m: KodaXMessage[], _t: KodaXToolDefinition[], _s: string,
        _r?: boolean | KodaXReasoningRequest,
        _o?: KodaXProviderStreamOptions, _sig?: AbortSignal,
      ): Promise<KodaXStreamResult> { throw new Error('unused'); }
    }
    const provider = new ScopedProvider();
    expect(provider.getEffectiveStrictThinkingSignature('force-strict')).toBe(true);
    expect(provider.getEffectiveStrictThinkingSignature('force-lenient')).toBe(false);
    expect(provider.getEffectiveStrictThinkingSignature('inherit')).toBe(true);
    expect(provider.getEffectiveStrictThinkingSignature('default-model')).toBe(true);

    class NoProviderDefault extends KodaXBaseProvider {
      readonly name = 'no-default';
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'NO_DEFAULT_KEY',
        model: 'default-model',
        supportsThinking: false,
      };
      async stream(
        _m: KodaXMessage[], _t: KodaXToolDefinition[], _s: string,
        _r?: boolean | KodaXReasoningRequest,
        _o?: KodaXProviderStreamOptions, _sig?: AbortSignal,
      ): Promise<KodaXStreamResult> { throw new Error('unused'); }
    }
    expect(new NoProviderDefault().getEffectiveStrictThinkingSignature()).toBe(false);
  });

  it('FEATURE_130: fires structured onRetryAfter with parsed source and provider name', async () => {
    const provider = new TestProvider();
    const onRetryAfter = vi.fn();
    // Throw an error that carries a Retry-After header; subsequent attempt succeeds.
    const error = Object.assign(new Error('429 rate limit hit'), {
      headers: { 'retry-after': '7' },
    });
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('ok');
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: Parameters<typeof setTimeout>[0]) => {
      if (typeof callback === 'function') {
        callback();
      }
      return undefined as unknown as ReturnType<typeof setTimeout>;
    });
    try {
      await expect(
        provider.exposeWithRateLimit(task, undefined, 2, undefined, onRetryAfter),
      ).resolves.toBe('ok');
      expect(onRetryAfter).toHaveBeenCalledTimes(1);
      const event = onRetryAfter.mock.calls[0]![0];
      expect(event.provider).toBe('test-provider');
      expect(event.waitMs).toBe(7_000);
      expect(event.reason).toBe('rate-limit');
      expect(event.source).toBe('retry-after-seconds');
      expect(event.attempt).toBe(1);
      expect(event.maxAttempts).toBe(2);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('retries Chinese rate-limit errors', async () => {
    const provider = new TestProvider();
    const onRetryAfter = vi.fn();
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('请求速率过高'))
      .mockResolvedValueOnce('ok');
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: Parameters<typeof setTimeout>[0]) => {
      if (typeof callback === 'function') {
        callback();
      }
      return undefined as unknown as ReturnType<typeof setTimeout>;
    });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      await expect(
        provider.exposeWithRateLimit(task, undefined, 2, undefined, onRetryAfter),
      ).resolves.toBe('ok');
      expect(onRetryAfter).toHaveBeenCalledTimes(1);
      expect(onRetryAfter.mock.calls[0]![0]).toMatchObject({
        reason: 'rate-limit',
        source: 'exponential-backoff',
      });
    } finally {
      timeoutSpy.mockRestore();
      randomSpy.mockRestore();
    }
  });

  it('appends the original rate-limit detail when retries are exhausted', async () => {
    const provider = new TestProvider();
    // GLM-style quota body: the detail users need (reset time, quota code) lives
    // in the provider's own error message and must not be discarded.
    const glmDetail =
      '429 [1308][已达到 5 小时使用上限，2026-08-25 21:12:09 后可继续使用。]';
    const task = vi.fn<() => Promise<string>>().mockRejectedValue(new Error(glmDetail));
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: Parameters<typeof setTimeout>[0]) => {
      if (typeof callback === 'function') {
        callback();
      }
      return undefined as unknown as ReturnType<typeof setTimeout>;
    });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      const error: unknown = await provider
        .exposeWithRateLimit(task, undefined, 2)
        .then(() => undefined, (e: unknown) => e);
      expect(task).toHaveBeenCalledTimes(2);
      expect(error).toBeInstanceOf(KodaXRateLimitError);
      expect((error as Error).message).toContain(
        'API rate limit exceeded after 2 retries. Please wait and try again later.',
      );
      expect((error as Error).message).toContain('已达到 5 小时使用上限');
    } finally {
      timeoutSpy.mockRestore();
      randomSpy.mockRestore();
    }
  });

  it('preserves only approved upstream failure metadata when wrapping provider errors', async () => {
    const provider = new TestProvider();
    const upstream = Object.assign(new Error('model missing-model was not found'), {
      status: 404,
      code: 'model_not_found',
      request_id: 'req_safe_123',
      headers: {
        'retry-after': '3',
        authorization: 'Bearer must-not-be-copied',
      },
      response: { body: 'must-not-be-copied' },
    });

    const error: unknown = await provider
      .exposeWithRateLimit(() => Promise.reject(upstream), undefined, 1)
      .then(() => undefined, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(KodaXProviderError);
    expect(error).toMatchObject({
      metadata: {
        stage: 'transport',
        httpStatus: 404,
        upstreamCode: 'model_not_found',
        requestId: 'req_safe_123',
        retryAfterMs: 3_000,
      },
    });
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('response');
    expect(JSON.stringify(error)).not.toContain('must-not-be-copied');
  });

  it('does not overwrite an already classified provider failure', async () => {
    const provider = new TestProvider();
    const classified = new KodaXProviderError(
      'Local request construction failed.',
      'test',
      { failureCode: 'request_build_failed', stage: 'request_build' },
    );

    const error: unknown = await provider
      .exposeWithRateLimit(() => Promise.reject(classified), undefined, 1)
      .then(() => undefined, (caught: unknown) => caught);

    expect(error).toBe(classified);
    expect(error).toMatchObject({
      metadata: {
        failureCode: 'request_build_failed',
        stage: 'request_build',
      },
    });
  });

  it('retries Chinese context-overflow errors immediately', async () => {
    const provider = new TestProvider();
    const onRateLimit = vi.fn();
    let attempt = 0;
    const observedMaxTokens: number[] = [];
    const task = vi.fn<() => Promise<string>>(async () => {
      attempt += 1;
      observedMaxTokens.push(provider.getEffectiveMaxOutputTokens());
      if (attempt === 1) {
        throw new Error('上下文长度 exceeds 150000 tokens 上限 128000');
      }
      return 'ok';
    });

    await expect(
      provider.exposeWithRateLimit(task, undefined, 2, onRateLimit),
    ).resolves.toBe('ok');
    expect(task).toHaveBeenCalledTimes(2);
    expect(onRateLimit).toHaveBeenCalledWith(1, 2, 0);
    expect(observedMaxTokens).toEqual([32_000, 3_000]);
  });

  it('aborts rate-limit retry sleep when the signal aborts', async () => {
    vi.useFakeTimers();
    const provider = new TestProvider();
    const controller = new AbortController();
    const error = Object.assign(new Error('429 rate limit hit'), {
      headers: { 'retry-after': '60' },
    });
    const task = vi.fn<() => Promise<string>>().mockRejectedValue(error);

    try {
      const promise = provider.exposeWithRateLimit(
        task,
        controller.signal,
        2,
        () => undefined,
      );
      await Promise.resolve();
      await Promise.resolve();
      controller.abort();

      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      expect(task).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('normalizes a provider SDK abort when the request signal is aborted', async () => {
    const provider = new TestProvider();
    const controller = new AbortController();
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new AnthropicAPIUserAbortError());

    controller.abort();

    await expect(
      provider.exposeWithRateLimit(task, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('normalizes an OpenAI SDK abort when the request signal is aborted', async () => {
    const provider = new TestProvider();
    const controller = new AbortController();
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new OpenAIAPIUserAbortError());

    controller.abort();

    await expect(
      provider.exposeWithRateLimit(task, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('keeps an independent same-message error on the provider failure path', async () => {
    const provider = new TestProvider();
    const controller = new AbortController();
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error('Request was aborted.'));

    controller.abort();

    await expect(
      provider.exposeWithRateLimit(task, controller.signal),
    ).rejects.toMatchObject({ name: 'KodaXProviderError' });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('FEATURE_130: classifies overloaded errors with reason="overloaded"', async () => {
    const provider = new TestProvider();
    const onRetryAfter = vi.fn();
    const error = new Error('Server overloaded — please retry');
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('ok');
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: Parameters<typeof setTimeout>[0]) => {
      if (typeof callback === 'function') {
        callback();
      }
      return undefined as unknown as ReturnType<typeof setTimeout>;
    });
    try {
      // The classifier matches "overload" via isRateLimitError keywords —
      // confirm overloaded errors go through the same retry path.
      await expect(
        provider.exposeWithRateLimit(task, undefined, 2, undefined, onRetryAfter),
      ).resolves.toBe('ok');
      expect(onRetryAfter).toHaveBeenCalledTimes(1);
      const event = onRetryAfter.mock.calls[0]![0];
      expect(event.reason).toBe('overloaded');
      expect(event.source).toBe('exponential-backoff');
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('surfaces rate-limit retry callbacks with the computed delay', async () => {
    const provider = new TestProvider();
    const onRateLimit = vi.fn();
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('429 rate limit'))
      .mockResolvedValueOnce('ok');
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: Parameters<typeof setTimeout>[0]) => {
      if (typeof callback === 'function') {
        callback();
      }
      return undefined as unknown as ReturnType<typeof setTimeout>;
    });
    // Stub jitter to a deterministic 0 so we can assert an exact delay
    // (the production formula adds Math.random() * 0.25 * baseDelay).
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      await expect(
        provider.exposeWithRateLimit(task, undefined, 2, onRateLimit),
      ).resolves.toBe('ok');
      // First retry (i=0): baseDelay = min(500 * 2^0, 32_000) = 500ms,
      // jitter = 0 (mocked) → total 500ms.
      expect(onRateLimit).toHaveBeenCalledWith(1, 2, 500);
    } finally {
      timeoutSpy.mockRestore();
      randomSpy.mockRestore();
    }
  });
});

// Issue 144 (v0.7.57): an always-on-thinking model (localRejectEfforts
// includes 'none', e.g. kimi-k2.7-code / minimax-m2-always) must not crash
// when the caller passes no reasoning at all. `normalizeReasoningRequest`
// turns an omitted request into a legacy/implicit effort 'none'; that path
// must fall back to the model's defaultEffort, not throw. Only an EXPLICIT
// caller request for a rejected effort still throws.
describe('KodaXBaseProvider.resolveReasoningProfileIntent — always-on-thinking models', () => {
  it('implicit/omitted reasoning falls back to defaultEffort instead of throwing', () => {
    const provider = new AlwaysOnThinkingProvider();
    const intent = provider.exposeResolveIntent(undefined);
    expect(intent.disabled).toBe(false);
    expect(intent.effort).toBe('high');
  });

  it('legacy boolean reasoning=false (disable) does NOT crash an always-on model', () => {
    const provider = new AlwaysOnThinkingProvider();
    const intent = provider.exposeResolveIntent(false);
    expect(intent.disabled).toBe(false);
    expect(intent.effort).toBe('high');
  });

  it('an EXPLICIT effort:"none" request still throws (model cannot disable thinking)', () => {
    const provider = new AlwaysOnThinkingProvider();
    expect(() => provider.exposeResolveIntent({ effort: 'none' })).toThrow(
      /does not support reasoning effort "none"/,
    );
  });

  it('an explicitly supported effort resolves normally', () => {
    const provider = new AlwaysOnThinkingProvider();
    const intent = provider.exposeResolveIntent({ effort: 'high' });
    expect(intent.disabled).toBe(false);
    expect(intent.effort).toBe('high');
  });
});
