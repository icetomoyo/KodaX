/**
 * KodaX Anthropic Compatible Provider
 *
 * 支持 Anthropic API 格式的 Provider 基类
 */

import type Anthropic from '@anthropic-ai/sdk';
import { KodaXBaseProvider } from './base.js';
import { parseToolInputWithSalvageTracked } from './tool-input-parser.js';
import { isCleanStop } from '../stop-reason.js';
import { KodaXProviderError } from '../errors.js';
import {
  KodaXContentBlock,
  KodaXNormalizedReasoningRequest,
  KodaXProviderConfig,
  KodaXReasoningProfile,
  KodaXMessage,
  KodaXToolDefinition,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXTextBlock,
  KodaXTokenUsage,
  KodaXToolUseBlock,
  KodaXThinkingBlock,
  KodaXRedactedThinkingBlock,
  KodaXVerifyCredentialResult,
} from '../types.js';
import { runVerifyCredential, type VerifyPrimitiveRunner } from './verify-credential.js';
import {
  clampThinkingBudget,
  effortToThinkingDepth,
  resolveThinkingBudget,
} from '../reasoning.js';
import {
  insertCacheBoundary,
  isCacheBoundary,
  lowerCacheBoundaries,
} from '../cache-control.js';
import {
  MISSING_IMAGE_PLACEHOLDER,
  readImageFileAsBase64IfAvailable,
  resolveImageMediaType,
} from './image-serialization.js';
import { resolvePromptCacheDisabled } from '../run-scoped-config.js';

const KODAX_ANTHROPIC_COMPAT_USER_AGENT = 'KodaX';
const KODAX_ANTHROPIC_EFFORT_BETA_HEADER = 'effort-2025-11-24';

export async function createAnthropicSdkClient(
  options: ConstructorParameters<typeof Anthropic>[0],
): Promise<Anthropic> {
  const { default: AnthropicSdk } = await import('@anthropic-ai/sdk');
  return new AnthropicSdk(options);
}

interface AnthropicRequestOptions {
  readonly signal?: AbortSignal;
  readonly headers?: Record<string, string>;
}

function appendAnthropicEphemeralSuffix(
  messages: Anthropic.Messages.MessageParam[],
  suffix: string | undefined,
): Anthropic.Messages.MessageParam[] {
  if (suffix === undefined || suffix.length === 0) return messages;
  const block: Anthropic.Messages.TextBlockParam = { type: 'text', text: suffix };
  const last = messages.at(-1);
  if (last?.role !== 'user') {
    return [...messages, { role: 'user', content: [block] }];
  }
  const content = typeof last.content === 'string'
    ? [{ type: 'text' as const, text: last.content }, block]
    : [...last.content, block];
  return [...messages.slice(0, -1), { ...last, content }];
}

function getAnthropicCompatDefaultHeaders(
  config: KodaXProviderConfig,
): Record<string, string> | undefined {
  return config.userAgentMode === 'sdk'
    ? undefined
    : { 'User-Agent': KODAX_ANTHROPIC_COMPAT_USER_AGENT };
}

type AnthropicUsageLike = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
} | null | undefined;

function normalizeAnthropicUsage(
  usage: AnthropicUsageLike,
  previous?: KodaXTokenUsage,
): KodaXTokenUsage | undefined {
  if (!usage) {
    return previous;
  }

  const hasInputTokens = typeof usage.input_tokens === 'number';
  const hasCachedWriteTokens = typeof usage.cache_creation_input_tokens === 'number';
  const hasCachedReadTokens = typeof usage.cache_read_input_tokens === 'number';
  const hasInputUsage = hasInputTokens || hasCachedWriteTokens || hasCachedReadTokens;
  const inputTokens = hasInputTokens ? usage.input_tokens! : 0;
  const cachedWriteTokens = hasInputUsage
    ? hasCachedWriteTokens ? usage.cache_creation_input_tokens! : undefined
    : previous?.cachedWriteTokens;
  const cachedReadTokens = hasInputUsage
    ? hasCachedReadTokens ? usage.cache_read_input_tokens! : undefined
    : previous?.cachedReadTokens;
  const outputTokens =
    typeof usage.output_tokens === 'number'
      ? usage.output_tokens
      : previous?.outputTokens ?? 0;
  const totalInputTokens = hasInputUsage
    ? inputTokens + (cachedWriteTokens ?? 0) + (cachedReadTokens ?? 0)
    : previous?.inputTokens ?? 0;

  if (
    [totalInputTokens, outputTokens, cachedWriteTokens, cachedReadTokens]
      .some((value) => value !== undefined && (!Number.isFinite(value) || value < 0))
  ) {
    return undefined;
  }

  return {
    inputTokens: totalInputTokens,
    outputTokens,
    totalTokens: totalInputTokens + outputTokens,
    ...(cachedReadTokens !== undefined ? { cachedReadTokens } : {}),
    ...(cachedWriteTokens !== undefined ? { cachedWriteTokens } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function selectAnthropicOutputEffort(
  reasoning: KodaXNormalizedReasoningRequest,
): string | undefined {
  if (!reasoning.enabled || reasoning.effort === 'auto' || reasoning.effort === 'none') {
    return undefined;
  }
  return reasoning.effort;
}

function applyAnthropicOutputEffort(
  params: Anthropic.Messages.MessageCreateParams,
  reasoning: KodaXNormalizedReasoningRequest,
): void {
  const effort = selectAnthropicOutputEffort(reasoning);
  if (!effort) {
    return;
  }
  const rawParams = params as unknown as Record<string, unknown>;
  const existing = rawParams.output_config;
  rawParams.output_config = {
    ...(isRecord(existing) ? existing : {}),
    effort,
  };
}

function setAnthropicOutputEffort(
  params: Anthropic.Messages.MessageCreateParams,
  effort: string | undefined,
): void {
  if (!effort) {
    return;
  }
  const rawParams = params as unknown as Record<string, unknown>;
  const existing = rawParams.output_config;
  rawParams.output_config = {
    ...(isRecord(existing) ? existing : {}),
    effort,
  };
}

function hasAnthropicOutputEffort(
  params: Anthropic.Messages.MessageCreateParams,
): boolean {
  const rawParams = params as unknown as Record<string, unknown>;
  const outputConfig = rawParams.output_config;
  return isRecord(outputConfig) && typeof outputConfig.effort === 'string';
}

export abstract class KodaXAnthropicCompatProvider extends KodaXBaseProvider {
  abstract override readonly name: string;
  readonly supportsThinking = true;
  protected abstract override readonly config: KodaXProviderConfig;
  private _client?: Anthropic;
  private _clientPromise?: Promise<Anthropic>;

  /**
   * The SDK client is built lazily on first use. Constructing it requires the
   * API key (`getApiKey()` throws when the env var is unset), so deferring it
   * lets callers construct a provider and read static metadata (context
   * window, model descriptors) without a key. This also keeps key-less unit
   * tests (which mock the actual LLM calls) from failing at construction time.
   */
  protected async getClient(): Promise<Anthropic> {
    if (this._client) return this._client;
    const clientPromise = this._clientPromise ??= Promise.resolve(this.buildClient());
    try {
      const client = await clientPromise;
      if (this._clientPromise === clientPromise) {
        this._client = client;
        this._clientPromise = undefined;
      }
      return this._client ?? client;
    } catch (error) {
      if (this._clientPromise === clientPromise) {
        this._clientPromise = undefined;
      }
      throw error;
    }
  }

  // Lets subclasses / tests inject a client without going through buildClient
  // (and so without requiring an API key).
  protected set client(client: Anthropic) {
    this._client = client;
    this._clientPromise = undefined;
  }

  protected buildClient(): Anthropic | Promise<Anthropic> {
    const defaultHeaders = getAnthropicCompatDefaultHeaders(this.config);
    return createAnthropicSdkClient({
      apiKey: this.getApiKey(),
      baseURL: this.config.baseUrl,
      // Some Anthropic-compatible gateways block the SDK's default
      // "Anthropic/JS ..." user agent even when the request is otherwise valid.
      ...(defaultHeaders ? { defaultHeaders } : {}),
    });
  }

  protected override onStaleConnection(): void {
    // Drop the memoized client so the next call rebuilds it, discarding the
    // stale keep-alive socket pool.
    this._client = undefined;
  }

  private buildMessageCreateOptions(
    params: Anthropic.Messages.MessageCreateParams,
    model: string,
    signal?: AbortSignal,
  ): AnthropicRequestOptions {
    const capability = this.getReasoningProfile(model);
    const headers = capability?.requiresEffortBetaHeader && hasAnthropicOutputEffort(params)
      ? { 'anthropic-beta': KODAX_ANTHROPIC_EFFORT_BETA_HEADER }
      : undefined;
    return {
      ...(signal ? { signal } : {}),
      ...(headers ? { headers } : {}),
    };
  }

  private applyReasoningProfile(
    params: Anthropic.Messages.MessageCreateParams,
    capability: KodaXReasoningProfile,
    reasoning: KodaXNormalizedReasoningRequest,
    model: string,
    maxOutputTokens: number,
    suppressReasoningEffort: boolean,
  ): void {
    // Passive-learning self-heal retry: drop reasoning params after an effort
    // rejection so the retried turn completes on the provider default.
    if (suppressReasoningEffort) {
      return;
    }
    this.validateExplicitReasoningEffort(reasoning, model);
    const intent = this.resolveReasoningProfileIntent(reasoning, capability, model);
    const preset = capability.reasoningPreset;
    const rawParams = params as unknown as Record<string, unknown>;

    // "Always-thinks" coding models (kimi-for-coding / kimi-k2.7-code,
    // MiniMax-M2.7): the effort LEVEL is prompt-only, but the server only emits
    // reasoning when thinking is explicitly enabled on the wire. Send the enable
    // param — without it the model returns no reasoning_content and the user
    // sees no thinking. v0.7.57 regression: these were `native-budget` and DID
    // send `thinking:{type:'enabled'}` before the reasoning single-track
    // migration (ADR-042); the new prompt-only profile dropped it. none/minimal
    // are localRejected, so these presets never disable.
    if (preset === 'kimi-k2.7-code' || preset === 'minimax-m2-always') {
      params.thinking = { type: 'enabled' } as Anthropic.Messages.ThinkingConfigParam;
      return;
    }

    if (preset === 'kimi-k3') {
      const useModelDefault =
        reasoning.effortSource === 'omitted' && reasoning.effort === 'none';
      if (intent.disabled && !useModelDefault) {
        params.thinking = { type: 'disabled' } as Anthropic.Messages.ThinkingConfigParam;
        return;
      }
      params.thinking = {
        type: 'enabled',
        effort: useModelDefault
          ? capability.defaultEffort ?? 'max'
          : intent.effort ?? capability.defaultEffort ?? 'max',
      } as unknown as Anthropic.Messages.ThinkingConfigParam;
      return;
    }

    if (
      preset === 'none' ||
      capability.effortStrategy === 'none' ||
      capability.effortStrategy === 'prompt-only'
    ) {
      return;
    }

    if (intent.disabled) {
      if (preset === 'zai-glm-5.3') {
        params.thinking = {
          type: 'adaptive',
        } as Anthropic.Messages.ThinkingConfigParam;
        setAnthropicOutputEffort(params, 'low');
        return;
      }
      if (
        capability.supportsDisabledThinking === true ||
        preset === 'zai-glm-5.2' ||
        preset === 'zai-glm-toggle' ||
        preset === 'deepseek-v4-anthropic' ||
        preset === 'deepseek-toggle' ||
        preset === 'kimi-hybrid-toggle' ||
        preset === 'minimax-m3' ||
        preset === 'mimo-v2.5-toggle' ||
        capability.thinkingStrategy === 'provider-toggle'
      ) {
        params.thinking = {
          type: 'disabled',
        } as Anthropic.Messages.ThinkingConfigParam;
      }
      return;
    }

    if (preset === 'zai-glm-5.2') {
      params.thinking = {
        type: 'enabled',
      } as Anthropic.Messages.ThinkingConfigParam;
      if (intent.effort) {
        rawParams.reasoning_effort = intent.effort;
      }
      return;
    }

    if (preset === 'zai-glm-5.3') {
      params.thinking = {
        type: 'adaptive',
      } as Anthropic.Messages.ThinkingConfigParam;
      setAnthropicOutputEffort(params, intent.effort);
      return;
    }

    if (preset === 'deepseek-v4-anthropic') {
      params.thinking = {
        type: 'enabled',
      } as Anthropic.Messages.ThinkingConfigParam;
      setAnthropicOutputEffort(params, intent.effort);
      return;
    }

    if (preset === 'minimax-m3') {
      params.thinking = {
        type: 'adaptive',
      } as Anthropic.Messages.ThinkingConfigParam;
      return;
    }

    if (
      preset === 'zai-glm-toggle' ||
      preset === 'deepseek-toggle' ||
      preset === 'kimi-hybrid-toggle' ||
      preset === 'mimo-v2.5-toggle' ||
      capability.effortStrategy === 'provider-toggle'
    ) {
      params.thinking = {
        type: 'enabled',
      } as Anthropic.Messages.ThinkingConfigParam;
      return;
    }

    if (capability.effortStrategy === 'anthropic-reasoning-effort') {
      // Non-Claude anthropic-compat endpoints (zhipu/deepseek style) enable thinking
      // via {type:'enabled'} + a top-level reasoning_effort — NOT Claude's adaptive +
      // output_config.effort. This is the friendly `reasoning:{efforts}` wire shape on
      // anthropic-compat (B1), mirroring the built-in zai-glm-5.2 preset. Disable is
      // handled by the provider-toggle intent.disabled block above (thinkingStrategy
      // stays 'provider-toggle').
      params.thinking = { type: 'enabled' } as Anthropic.Messages.ThinkingConfigParam;
      if (intent.effort) {
        rawParams.reasoning_effort = intent.effort;
      }
      return;
    }

    if (
      capability.effortStrategy === 'anthropic-output-effort' ||
      capability.thinkingStrategy === 'anthropic-adaptive'
    ) {
      params.thinking = {
        type: 'adaptive',
      } as Anthropic.Messages.ThinkingConfigParam;
      setAnthropicOutputEffort(params, intent.effort);
      return;
    }

    if (
      capability.effortStrategy === 'provider-budget' ||
      capability.thinkingStrategy === 'anthropic-budget'
    ) {
      const budget = this.resolveReasoningProfileBudget(
        capability,
        intent.effort,
        reasoning,
        model,
        maxOutputTokens,
      );
      params.thinking = {
        type: 'enabled',
        budget_tokens: budget,
      };
    }
  }

  private resolveReasoningProfileBudget(
    capability: KodaXReasoningProfile,
    effort: string | undefined,
    reasoning: KodaXNormalizedReasoningRequest,
    model: string,
    maxOutputTokens: number,
  ): number {
    const budgetFromEffort = effort ? capability.budgetByEffort?.[effort] : undefined;
    const requestedBudget = budgetFromEffort ?? resolveThinkingBudget(
      this.config,
      effortToThinkingDepth(reasoning.effort),
      reasoning.taskType,
    );
    const cap = this.getEffectiveThinkingBudgetCap(model);
    const cappedBudget = cap !== undefined
      ? Math.min(requestedBudget, cap)
      : requestedBudget;
    return clampThinkingBudget(cappedBudget, maxOutputTokens);
  }

  /**
   * FEATURE_216 v0.7.45 — Lightweight credential verification.
   * Dispatches by `this.config.verifyStrategy`:
   *   - `count-tokens` (default for Anthropic protocol): 0-token
   *     `messages.countTokens()` — empirically reliable across 5/5
   *     Anthropic-compat providers tested (anthropic / zhipu-coding /
   *     kimi-code / minimax-coding / ark-coding).
   *   - `models-list`: 0-token `models.list()` — supported by Anthropic
   *     SDK 0.80+; not used by any Anthropic built-in but available
   *     for custom providers that explicitly opt-in.
   *   - `minimal-message`: ~7-token `messages.create({max_tokens:1})`
   *     fallback for Anthropic-compat providers whose `count_tokens`
   *     endpoint returns 404 (mimo / mimo-coding empirically).
   */
  override async verifyCredential(opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<KodaXVerifyCredentialResult> {
    const model = this.config.model;
    const client = await this.getClient();
    const runners: VerifyPrimitiveRunner[] = [
      {
        strategy: 'count-tokens',
        approxTokensSpent: 0,
        run: async (signal) => {
          await client.messages.countTokens(
            { model, messages: [{ role: 'user', content: 'hi' }] },
            { signal },
          );
        },
      },
      {
        strategy: 'models-list',
        approxTokensSpent: 0,
        run: async (signal) => {
          await client.models.list({}, { signal });
        },
      },
      {
        strategy: 'minimal-message',
        approxTokensSpent: 7,
        run: async (signal) => {
          await client.messages.create(
            {
              model,
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }],
            },
            { signal },
          );
        },
      },
    ];
    return runVerifyCredential({
      strategy: this.config.verifyStrategy ?? 'count-tokens',
      runners,
      timeoutMs: opts?.timeoutMs,
      signal: opts?.signal,
      providerName: this.name,
    });
  }

  /**
   * FEATURE_116 (v0.7.37) — Wrap a string `system` prompt as a single
   * cacheable text block. v1 treats the entire system prompt as one cache
   * prefix (implicit boundary at the end). When upstream callers later
   * emit `KodaXContentBlock[]` with explicit `cache-boundary` markers
   * (Phase 1.4+), this helper switches to lowering those markers via
   * `lowerCacheBoundaries(blocks, 'attach')`.
   *
   * Escape hatch: setting `KODAX_DISABLE_PROMPT_CACHE=1` returns the
   * original string unchanged so prompt caching can be disabled at
   * runtime without redeploying.
   */
  /**
   * Run-scoped (concurrency-safe) config wins over the global env, in BOTH
   * directions: an SDK caller that explicitly sets `disablePromptCache: false`
   * re-enables caching even when `KODAX_DISABLE_PROMPT_CACHE=1` is set at
   * startup (e.g. bridged from `config.json`). A plain `||` would let the env
   * win in that re-enable case, breaking the documented SDK > env precedence.
   */
  protected applyCacheControlToSystem(
    systemText: string,
  ): string | Anthropic.Messages.TextBlockParam[] {
    if (!systemText.trim()) return systemText;
    if (resolvePromptCacheDisabled()) return systemText;
    const blocks = insertCacheBoundary(
      [{ type: 'text', text: systemText }],
      'system',
    );
    // After lowering, no boundary marker remains — the cache_control
    // attribute now lives on the wrapping text block. Cast the lowered
    // shape to the Anthropic SDK's TextBlockParam union.
    return lowerCacheBoundaries(blocks, 'attach') as Anthropic.Messages.TextBlockParam[];
  }

  /**
   * FEATURE_116 (v0.7.37) — Mark the last tool definition as the cache
   * suffix for the tools array. The Anthropic API caches the entire
   * prefix up to and including the marked tool, so this is equivalent
   * to "all tool defs are cacheable".
   *
   * Returns a new array; never mutates input.
   */
  protected applyCacheControlToTools(
    tools: KodaXToolDefinition[],
  ): Anthropic.Messages.Tool[] {
    if (tools.length === 0) return tools as Anthropic.Messages.Tool[];
    if (resolvePromptCacheDisabled()) {
      return tools as Anthropic.Messages.Tool[];
    }
    const out = tools.slice() as Anthropic.Messages.Tool[];
    const last = out[out.length - 1]!;
    out[out.length - 1] = {
      ...last,
      cache_control: { type: 'ephemeral' },
    } as Anthropic.Messages.Tool;
    return out;
  }

  /**
   * FEATURE_116 follow-up — Place an incremental cache breakpoint on the
   * conversation history (Anthropic breakpoint 3). The system prompt and
   * tools already carry breakpoints 1 & 2 (applyCacheControlToSystem /
   * applyCacheControlToTools); without a message-level breakpoint the whole
   * growing transcript is re-billed as uncached input every turn.
   *
   * Strategy: mark the LAST content block of the latest `user` message.
   * Anthropic writes the whole prefix through that breakpoint. On the next
   * request its lookback can match the previous turn's write even though the
   * breakpoint has advanced to the new current turn. This also lets a
   * single-call run seed the cache for the next run. Total
   * breakpoints stay at 3 (≤ Anthropic's limit of 4).
   *
   * Only anthropic-compat providers reach this path; OpenAI/ACP strip cache
   * markers and rely on upstream automatic prefix caching. Escape hatch:
   * `KODAX_DISABLE_PROMPT_CACHE=1` returns the array untouched.
   *
   * Returns a new array; never mutates input.
   */
  protected applyCacheControlToMessages(
    messages: Anthropic.Messages.MessageParam[],
  ): Anthropic.Messages.MessageParam[] {
    if (messages.length === 0) return messages;
    if (resolvePromptCacheDisabled()) return messages;

    let targetIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        targetIdx = i;
        break;
      }
    }
    if (targetIdx === -1) return messages;

    const target = messages[targetIdx]!;
    if (typeof target.content === 'string') {
      if (target.content.length === 0) return messages;
      const out = messages.slice();
      out[targetIdx] = {
        ...target,
        content: [{
          type: 'text',
          text: target.content,
          cache_control: { type: 'ephemeral' as const },
        }],
      };
      return out;
    }
    if (target.content.length === 0) {
      return messages;
    }

    const blocks = target.content;
    const last = blocks[blocks.length - 1]!;
    const markedLast = {
      ...last,
      cache_control: { type: 'ephemeral' as const },
    } as Anthropic.Messages.ContentBlockParam;
    const newContent = [...blocks.slice(0, -1), markedLast];

    const out = messages.slice();
    out[targetIdx] = { ...target, content: newContent };
    return out;
  }

  override supportsEphemeralSuffix(): boolean {
    return true;
  }

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    signal?: AbortSignal
  ): Promise<KodaXStreamResult> {
    return this.withRateLimit(async (retryState) => {
      const normalizedReasoning = this.normalizeReasoning(reasoning);
      const model = streamOptions?.modelOverride ?? this.config.model;
      const wireModel = this.getWireModelId(model);
      this.validateExplicitReasoningEffort(normalizedReasoning, model);
      const requestMaxOutputTokens = streamOptions?.maxOutputTokensOverride
        ?? this.getEffectiveMaxOutputTokens(model);
      retryState.maxOutputTokensLimit ??= requestMaxOutputTokens;
      const maxOutputTokens = retryState.maxOutputTokensOverride
        ?? requestMaxOutputTokens;
      const convertedMessages = appendAnthropicEphemeralSuffix(this.applyCacheControlToMessages(
        await this.convertMessages(messages, model),
      ), streamOptions?.ephemeralSuffix?.content);
      const initialCapability = normalizedReasoning.enabled
        ? this.getReasoningCapability(model)
        : 'none';
      const reasoningProfile = this.getReasoningProfile(model);
      // Reasoning attempt ladder. A reasoningProfile (custom providers, the friendly
      // reasoning:{efforts} form, built-in presets) owns the wire shape, so it is tried
      // as the 'profile' primary attempt. Every ladder ends in a 'none' rung that emits
      // NO reasoning param, so a relay/endpoint that rejects the chosen shape still
      // completes the turn (degraded: no active thinking request) instead of hard-
      // failing — reasoning_content is parsed regardless if the model reasons by default
      // (Part 2 degradation safety net). Previously a profile was re-applied on every
      // rung (capability ignored), so the ladder never actually degraded.
      const attempts: Array<'profile' | 'native-budget' | 'native-toggle' | 'native-adaptive' | 'none'> =
        reasoningProfile
          // A profile owns the wire shape for BOTH enabled and disabled reasoning
          // (applyReasoningProfile emits the {type:'disabled'} off-shape itself for
          // provider-toggle profiles), so it is always the primary attempt; 'none' is
          // purely the degradation rung that drops params after a rejection.
          ? ['profile', 'none']
          : !normalizedReasoning.enabled
            ? ['none']
            : this.getReasoningFallbackChain(initialCapability)
                .filter((capability): capability is 'native-budget' | 'native-toggle' | 'native-adaptive' | 'none' =>
                  capability === 'native-budget' ||
                  capability === 'native-toggle' ||
                  capability === 'native-adaptive' ||
                  capability === 'none',
                );
      let shouldForceToolChoice = Boolean(streamOptions?.forcedToolName);

      const buildRequest = (
        capability: 'profile' | 'native-budget' | 'native-toggle' | 'native-adaptive' | 'none',
      ): Anthropic.Messages.MessageCreateParams => {
        const kwargs: Anthropic.Messages.MessageCreateParams = {
          model: wireModel,
          max_tokens: maxOutputTokens,
          system: this.applyCacheControlToSystem(this.buildSystemPrompt(system, messages)),
          messages: convertedMessages,
          tools: this.applyCacheControlToTools(tools),
          stream: true,
          ...(this.config.promptCacheAffinity === true
            && streamOptions?.promptCacheKey
            && !resolvePromptCacheDisabled()
            ? { metadata: { user_id: streamOptions.promptCacheKey } }
            : {}),
        };
        if (streamOptions?.forcedToolName && shouldForceToolChoice) {
          kwargs.tool_choice = {
            type: 'tool',
            name: streamOptions.forcedToolName,
          };
        }

        if (capability === 'none') {
          // Part 2 degradation rung: emit NO reasoning param, even when a profile
          // exists. Lets a relay/endpoint that rejected the profile's wire shape
          // complete the turn; reasoning_content is still parsed if it reasons by
          // default.
        } else if (capability === 'profile' && reasoningProfile) {
          this.applyReasoningProfile(
            kwargs,
            reasoningProfile,
            normalizedReasoning,
            model,
            maxOutputTokens,
            retryState.suppressReasoningEffort,
          );
        } else if (capability === 'native-budget') {
          const requestedBudget = resolveThinkingBudget(
            this.config,
            effortToThinkingDepth(normalizedReasoning.effort),
            normalizedReasoning.taskType,
          );
          kwargs.thinking = {
            type: 'enabled',
            budget_tokens: clampThinkingBudget(requestedBudget, maxOutputTokens),
          };
        } else if (capability === 'native-toggle') {
          kwargs.thinking = {
            type: 'enabled',
          } as Anthropic.Messages.ThinkingConfigParam;
        } else if (capability === 'native-adaptive') {
          // Opus 4.7+ only accept adaptive thinking — the model itself
          // decides depth, so KodaX sends no budget.
          kwargs.thinking = {
            type: 'adaptive',
          } as Anthropic.Messages.ThinkingConfigParam;
          applyAnthropicOutputEffort(kwargs, normalizedReasoning);
        }

        return kwargs;
      };

      // 检查是否已被取消
      if (signal?.aborted) {
        throw new DOMException('Request aborted', 'AbortError');
      }

      const textBlocks: KodaXTextBlock[] = [];
      const toolBlocks: KodaXToolUseBlock[] = [];
      const thinkingBlocks: (KodaXThinkingBlock | KodaXRedactedThinkingBlock)[] = [];
      let usage: KodaXTokenUsage | undefined;

      let currentBlockType: string | null = null;
      let currentText = '';
      let currentThinking = '';
      let currentThinkingSignature = '';
      let currentRedactedData = '';
      let currentToolId = '';
      let currentToolName = '';
      let currentToolInput = '';

      // Issue 084 fix: Track message completion to detect silent disconnections
      let messageStopReceived = false;
      let stopReason: string | undefined;
      let lastEventTime = Date.now();
      const streamStartTime = Date.now();

      // 传递 signal 给 SDK，确保底层 HTTP 请求能被取消
      // 参考: https://github.com/anthropics/anthropic-sdk-typescript
      const client = await this.getClient();
      let response: Awaited<ReturnType<typeof client.messages.create>> | undefined;
      let lastError: unknown;

      for (const capability of attempts) {
        while (!response) {
          try {
            const request = buildRequest(capability);
            response = await client.messages.create(
              request,
              this.buildMessageCreateOptions(request, model, signal),
            );
          } catch (error) {
            lastError = error;
            if (shouldForceToolChoice && this.shouldFallbackForForcedToolChoiceError(error)) {
              shouldForceToolChoice = false;
              this.logStreamDiagnostic(
                `[${this.name}] upstream rejected forced tool_choice; retrying without forced tool choice`,
              );
              continue;
            }
            const fallbackTerms =
              capability === 'profile'
                ? ['thinking', 'reasoning_effort', 'budget_tokens', 'adaptive']
                : capability === 'native-budget'
                  ? ['budget_tokens', 'thinking']
                  : capability === 'native-toggle'
                    ? ['thinking']
                    : capability === 'native-adaptive'
                      ? ['adaptive', 'thinking']
                      : [];

            if (!this.shouldFallbackForReasoningError(error, ...fallbackTerms)) {
              throw error;
            }
            break;
          }
        }
        if (response) {
          break;
        }
      }

      if (!response) {
        throw lastError ?? new KodaXProviderError(
          'All reasoning capability attempts failed without a captured error',
          this.name,
        );
      }

      let prevEventTime = Date.now();
      let stallCount = 0;
      let totalStallMs = 0;
      const STALL_THRESHOLD_MS = 30_000;

      for await (const event of response as AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>) {
        // 检查是否被中断 (双重保险)
        if (signal?.aborted) {
          throw new DOMException('Request aborted', 'AbortError');
        }

        // Stall detection: passive diagnostic logging when gap > 30s.
        // Does NOT abort — only records for debugging slow providers.
        const now = Date.now();
        const gapMs = now - prevEventTime;
        if (gapMs > STALL_THRESHOLD_MS) {
          stallCount++;
          totalStallMs += gapMs;
          this.logStreamDiagnostic(`[Stream] stall detected: ${Math.round(gapMs / 1000)}s gap before ${event.type}`, {
            stallCount, totalStallMs, eventType: event.type,
          });
        }
        prevEventTime = now;

        // Idle timer management — state machine:
        //
        //   content_block_delta / message_delta → RESET (active data flowing)
        //   content_block_start / content_block_stop → PAUSE (block boundary;
        //       server may go silent while generating the next block or the
        //       first delta of the current block, e.g. large tool_use JSON)
        //   message_start / message_stop → RESET (stream lifecycle)
        //
        // The hard request timeout (10 min) still guards against genuinely
        // stuck connections when the idle timer is paused.
        if (event.type === 'content_block_start' || event.type === 'content_block_stop') {
          streamOptions?.onHeartbeat?.(true);   // pause at block boundaries
        } else {
          streamOptions?.onHeartbeat?.();        // reset on data / lifecycle events
        }

        if (event.type === 'content_block_start') {
          lastEventTime = Date.now();
          const block = event.content_block;
          currentBlockType = block.type;

          // Debug: Log tool_use block start
          if (process.env.KODAX_DEBUG_TOOL_STREAM && block.type === 'tool_use') {
            console.error('[ToolStream] content_block_start:', {
              type: block.type,
              id: (block as any).id,
              name: (block as any).name
            });
          }

          if (block.type === 'thinking') {
            currentThinking = '';
            currentThinkingSignature = (block as any).signature ?? '';
          } else if (block.type === 'redacted_thinking') {
            // The redacted-thinking payload (`data`) is a single opaque
            // string carried on `content_block_start` itself — it does not
            // arrive via deltas. Capture it here; `content_block_stop`
            // will not re-emit it (the stop event has no `content_block`
            // field). Defaults to '' for forward-compat with future
            // server payloads that omit the field.
            currentBlockType = 'redacted_thinking';
            currentRedactedData = (block as any).data ?? '';
          } else if (block.type === 'text') {
            currentText = '';
          } else if (block.type === 'tool_use') {
            currentToolId = block.id;
            currentToolName = block.name;
            currentToolInput = '';
          }
        } else if (event.type === 'content_block_delta') {
          lastEventTime = Date.now();
          const delta = event.delta as any;
          if (delta.type === 'thinking_delta') {
            currentThinking += delta.thinking ?? '';
            streamOptions?.onThinkingDelta?.(delta.thinking ?? '');
          } else if (delta.type === 'text_delta') {
            currentText += delta.text ?? '';
            streamOptions?.onTextDelta?.(delta.text ?? '');
          } else if (delta.type === 'input_json_delta') {
            currentToolInput += delta.partial_json ?? '';
            streamOptions?.onToolInputDelta?.(
              currentToolName,
              delta.partial_json ?? '',
              currentToolId ? { toolId: currentToolId } : undefined,
            );
          }
        } else if (event.type === 'content_block_stop') {
          lastEventTime = Date.now();  // Issue 084: Track last event time
          if (currentBlockType === 'thinking') {
            if (currentThinking) {
              thinkingBlocks.push({ type: 'thinking', thinking: currentThinking, signature: currentThinkingSignature });
              // thinking block 结束时通知 CLI 层
              streamOptions?.onThinkingEnd?.(currentThinking);
            }
          } else if (currentBlockType === 'redacted_thinking') {
            // Read from state captured at content_block_start — the stop
            // event does not carry the `data` field in Anthropic's stream
            // protocol. Empty payload means the server emitted a
            // redacted_thinking block with no data, which is meaningless
            // to replay; skip rather than push an empty block.
            if (currentRedactedData) {
              thinkingBlocks.push({ type: 'redacted_thinking', data: currentRedactedData });
            }
            currentRedactedData = '';
          } else if (currentBlockType === 'text') {
            if (currentText) textBlocks.push({ type: 'text', text: currentText });
          } else if (currentBlockType === 'tool_use') {
            // CRITICAL FIX: Validate tool_use has non-empty id and name
            // Prevents "tool_call_id is not found" errors with empty id
            if (!currentToolId || !currentToolName) {
              // Gate the diagnostic behind KODAX_DEBUG_TOOL_STREAM: a bare
              // console.error mid-stream writes below Ink's live region and
              // corrupts the TUI (same class as the compaction-stderr bug fixed
              // in 123fba0f). The block is still dropped either way.
              if (process.env.KODAX_DEBUG_TOOL_STREAM) {
                console.error('[Tool Block Invalid] Missing tool id or name:', {
                  id: JSON.stringify(currentToolId),
                  name: JSON.stringify(currentToolName),
                  input: currentToolInput.slice(0, 100)
                });
              }
              // Skip this invalid tool_use block - do not add to toolBlocks
            } else {
              const parsed = parseToolInputWithSalvageTracked(currentToolInput);
              // `_salvaged` is the raw "strict parse failed" signal (kept on a
              // clean stop so a mutating tool's malformed payload is still
              // gated). `_truncated` is the provisional "salvaged + likely
              // truncated" mark — stripped after the stream ends if the final
              // stop_reason is a recognized CLEAN stop (the post-loop pass
              // before `return` removes only `_truncated`, never `_salvaged`).
              toolBlocks.push({
                type: 'tool_use',
                id: currentToolId,
                name: currentToolName,
                input: parsed.value,
                ...(parsed.salvaged ? { _salvaged: true, _truncated: true } : {}),
              });
            }
          }
          currentBlockType = null;
        } else if (event.type === 'message_stop') {
          // Issue 084 fix: Mark message as complete
          messageStopReceived = true;
          lastEventTime = Date.now();
          if (process.env.KODAX_DEBUG_STREAM) {
            const duration = Date.now() - streamStartTime;
            this.logStreamDiagnostic(`[Stream] message_stop received after ${duration}ms`);
          }
        } else if (event.type === 'message_delta') {
          // Issue 084 fix: Track message_delta events (contain stop_reason, usage)
          lastEventTime = Date.now();
          usage = normalizeAnthropicUsage(
            (event as Anthropic.Messages.RawMessageDeltaEvent).usage,
            usage,
          );
          const delta = (event as any).delta;
          if (delta?.stop_reason) {
            stopReason = delta.stop_reason;
            if (process.env.KODAX_DEBUG_STREAM) {
              this.logStreamDiagnostic(`[Stream] message_delta with stop_reason: ${stopReason}`);
            }
          }
        } else if (event.type === 'message_start') {
          // Issue 084 fix: Track message start
          lastEventTime = Date.now();
          usage = normalizeAnthropicUsage(
            (event as Anthropic.Messages.RawMessageStartEvent).message?.usage as AnthropicUsageLike,
            usage,
          );
          if (process.env.KODAX_DEBUG_STREAM) {
            this.logStreamDiagnostic('[Stream] message_start received');
          }
        }
      }

      // Issue 084 fix: Validate stream completed successfully
      // If message_stop was never received, the stream was likely interrupted
      if (!messageStopReceived) {
        const duration = Date.now() - streamStartTime;
        const lastEventAge = Date.now() - lastEventTime;

        // If our upstream caller already aborted the request, surface it as an abort
        // instead of a generic incomplete stream so the retry classifier can distinguish
        // watchdog/user cancellation from provider-side truncation.
        if (signal?.aborted) {
          const reason = signal.reason instanceof Error
            ? signal.reason.message
            : typeof signal.reason === 'string'
              ? signal.reason
              : 'Request aborted';
          this.logStreamDiagnostic('[Stream] Stream ended after abort before message_stop:', {
            duration,
            lastEventAge,
            reason,
            textBlocks: textBlocks.length,
            toolBlocks: toolBlocks.length,
            thinkingBlocks: thinkingBlocks.length
          });
          throw new DOMException(reason, 'AbortError');
        }

        // If `stop_reason` already arrived (Anthropic sends it in `message_delta`,
        // which precedes `message_stop`), the model finished generating — only
        // the closing envelope event is missing. The accumulated content is
        // complete, so return it instead of throwing + retrying the whole
        // request (which would re-bill the entire turn). We only treat the
        // stream as genuinely incomplete when NO stop_reason was seen — a true
        // mid-stream cut (network/timeout), where a retry is the right move.
        if (!stopReason) {
          const error = new Error(
            `Stream incomplete: message_stop event not received. ` +
            `Duration: ${duration}ms, Last event: ${lastEventAge}ms ago. ` +
            `This may indicate a network disconnection or API timeout.`
          );
          error.name = 'StreamIncompleteError';
          this.logStreamDiagnostic('[Stream] Incomplete stream detected:', {
            duration,
            lastEventAge,
            textBlocks: textBlocks.length,
            toolBlocks: toolBlocks.length,
            thinkingBlocks: thinkingBlocks.length
          });
          throw error;
        }

        this.logStreamDiagnostic('[Stream] message_stop missing but stop_reason known — treating as complete:', {
          duration,
          lastEventAge,
          stopReason,
          textBlocks: textBlocks.length,
          toolBlocks: toolBlocks.length,
          thinkingBlocks: thinkingBlocks.length,
        });
      }

      // Finalize provisional truncation marks (immutably — never mutate the
      // streamed blocks). A salvaged input is only SAFE to execute when the
      // stream ended on a recognized CLEAN stop (`end_turn` / `tool_use` /
      // `pause_turn`), where the salvage was non-strict-but-complete JSON;
      // there we strip `_truncated` to avoid a spurious retry. On a truncating
      // stop (`max_tokens`) OR an ambiguous/unknown stop (e.g. a custom compat
      // provider that omits or nulls `stop_reason`) we RETAIN the mark —
      // fail-safe: prefer one spurious retry over executing a payload that may
      // be cut mid-value.
      const finalToolBlocks = isCleanStop(stopReason)
        ? toolBlocks.map(({ _truncated: _drop, ...rest }) => rest)
        : toolBlocks;

      return { textBlocks, toolBlocks: finalToolBlocks, thinkingBlocks, usage, stopReason };
    }, signal, 3, streamOptions?.onRateLimit, streamOptions?.onRetryAfter, {
      model: streamOptions?.modelOverride ?? this.config.model,
      onRejected: streamOptions?.onReasoningEffortRejected,
    });
  }

  override supportsNonStreamingFallback(): boolean {
    return true;
  }

  override async complete(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    return this.withRateLimit(async (retryState) => {
      const normalizedReasoning = this.normalizeReasoning(reasoning);
      const model = streamOptions?.modelOverride ?? this.config.model;
      const wireModel = this.getWireModelId(model);
      this.validateExplicitReasoningEffort(normalizedReasoning, model);
      const requestMaxOutputTokens = streamOptions?.maxOutputTokensOverride
        ?? this.getEffectiveMaxOutputTokens(model);
      retryState.maxOutputTokensLimit ??= requestMaxOutputTokens;
      const maxOutputTokens = retryState.maxOutputTokensOverride
        ?? requestMaxOutputTokens;
      const convertedMessages = appendAnthropicEphemeralSuffix(this.applyCacheControlToMessages(
        await this.convertMessages(messages, model),
      ), streamOptions?.ephemeralSuffix?.content);
      const initialCapability = normalizedReasoning.enabled
        ? this.getReasoningCapability(model)
        : 'none';
      const reasoningProfile = this.getReasoningProfile(model);
      // Reasoning attempt ladder. A reasoningProfile (custom providers, the friendly
      // reasoning:{efforts} form, built-in presets) owns the wire shape, so it is tried
      // as the 'profile' primary attempt. Every ladder ends in a 'none' rung that emits
      // NO reasoning param, so a relay/endpoint that rejects the chosen shape still
      // completes the turn (degraded: no active thinking request) instead of hard-
      // failing — reasoning_content is parsed regardless if the model reasons by default
      // (Part 2 degradation safety net). Previously a profile was re-applied on every
      // rung (capability ignored), so the ladder never actually degraded.
      const attempts: Array<'profile' | 'native-budget' | 'native-toggle' | 'native-adaptive' | 'none'> =
        reasoningProfile
          // A profile owns the wire shape for BOTH enabled and disabled reasoning
          // (applyReasoningProfile emits the {type:'disabled'} off-shape itself for
          // provider-toggle profiles), so it is always the primary attempt; 'none' is
          // purely the degradation rung that drops params after a rejection.
          ? ['profile', 'none']
          : !normalizedReasoning.enabled
            ? ['none']
            : this.getReasoningFallbackChain(initialCapability)
                .filter((capability): capability is 'native-budget' | 'native-toggle' | 'native-adaptive' | 'none' =>
                  capability === 'native-budget' ||
                  capability === 'native-toggle' ||
                  capability === 'native-adaptive' ||
                  capability === 'none',
                );
      let shouldForceToolChoice = Boolean(streamOptions?.forcedToolName);

      const buildRequest = (
        capability: 'profile' | 'native-budget' | 'native-toggle' | 'native-adaptive' | 'none',
      ): Anthropic.Messages.MessageCreateParams => {
        const kwargs: Anthropic.Messages.MessageCreateParams = {
          model: wireModel,
          max_tokens: maxOutputTokens,
          system: this.applyCacheControlToSystem(this.buildSystemPrompt(system, messages)),
          messages: convertedMessages,
          tools: this.applyCacheControlToTools(tools),
          ...(this.config.promptCacheAffinity === true
            && streamOptions?.promptCacheKey
            && !resolvePromptCacheDisabled()
            ? { metadata: { user_id: streamOptions.promptCacheKey } }
            : {}),
        };
        if (streamOptions?.forcedToolName && shouldForceToolChoice) {
          kwargs.tool_choice = {
            type: 'tool',
            name: streamOptions.forcedToolName,
          };
        }

        if (capability === 'none') {
          // Part 2 degradation rung: emit NO reasoning param, even when a profile
          // exists. Lets a relay/endpoint that rejected the profile's wire shape
          // complete the turn; reasoning_content is still parsed if it reasons by
          // default.
        } else if (capability === 'profile' && reasoningProfile) {
          this.applyReasoningProfile(
            kwargs,
            reasoningProfile,
            normalizedReasoning,
            model,
            maxOutputTokens,
            retryState.suppressReasoningEffort,
          );
        } else if (capability === 'native-budget') {
          const requestedBudget = resolveThinkingBudget(
            this.config,
            effortToThinkingDepth(normalizedReasoning.effort),
            normalizedReasoning.taskType,
          );
          kwargs.thinking = {
            type: 'enabled',
            budget_tokens: clampThinkingBudget(requestedBudget, maxOutputTokens),
          };
        } else if (capability === 'native-toggle') {
          kwargs.thinking = {
            type: 'enabled',
          } as Anthropic.Messages.ThinkingConfigParam;
        } else if (capability === 'native-adaptive') {
          // Opus 4.7+ only accept adaptive thinking — the model itself
          // decides depth, so KodaX sends no budget.
          kwargs.thinking = {
            type: 'adaptive',
          } as Anthropic.Messages.ThinkingConfigParam;
          applyAnthropicOutputEffort(kwargs, normalizedReasoning);
        }

        return kwargs;
      };

      const client = await this.getClient();
      let response: Awaited<ReturnType<typeof client.messages.create>> | undefined;
      let lastError: unknown;

      for (const capability of attempts) {
        while (!response) {
          try {
            const request = buildRequest(capability);
            response = await client.messages.create(
              request,
              this.buildMessageCreateOptions(request, model, signal),
            );
          } catch (error) {
            lastError = error;
            if (shouldForceToolChoice && this.shouldFallbackForForcedToolChoiceError(error)) {
              shouldForceToolChoice = false;
              this.logStreamDiagnostic(
                `[${this.name}] upstream rejected forced tool_choice; retrying without forced tool choice`,
              );
              continue;
            }
            const fallbackTerms =
              capability === 'profile'
                ? ['thinking', 'reasoning_effort', 'budget_tokens', 'adaptive']
                : capability === 'native-budget'
                  ? ['budget_tokens', 'thinking']
                  : capability === 'native-toggle'
                    ? ['thinking']
                    : capability === 'native-adaptive'
                      ? ['adaptive', 'thinking']
                      : [];

            if (!this.shouldFallbackForReasoningError(error, ...fallbackTerms)) {
              throw error;
            }
            break;
          }
        }
        if (response) {
          break;
        }
      }

      if (!response) {
        throw lastError ?? new KodaXProviderError(
          'All reasoning capability attempts failed without a captured error',
          this.name,
        );
      }

      const textBlocks: KodaXTextBlock[] = [];
      const toolBlocks: KodaXToolUseBlock[] = [];
      const thinkingBlocks: (KodaXThinkingBlock | KodaXRedactedThinkingBlock)[] = [];

      for (const block of (response as Anthropic.Messages.Message).content as Array<any>) {
        if (block.type === 'text') {
          textBlocks.push({ type: 'text', text: block.text });
          streamOptions?.onTextDelta?.(block.text);
        } else if (block.type === 'thinking') {
          thinkingBlocks.push({ type: 'thinking', thinking: block.thinking, signature: block.signature ?? '' });
          streamOptions?.onThinkingDelta?.(block.thinking);
          streamOptions?.onThinkingEnd?.(block.thinking);
        } else if (block.type === 'redacted_thinking') {
          thinkingBlocks.push({ type: 'redacted_thinking', data: block.data });
        } else if (block.type === 'tool_use') {
          // Non-streaming: the Messages API returns `input` as a fully parsed
          // object, not a raw string buffer — there is nothing to salvage and
          // no per-block truncation signal, so `_truncated` is not set here.
          // A `max_tokens` truncation that empties a required field is still
          // caught downstream by `checkIncompleteToolCalls` (missing-param
          // scan). The narrow residual case — truncation that lands mid-value
          // in the last field yet leaves all required keys present — is not
          // detectable without the raw buffer; flagging every tool_use on a
          // `max_tokens` stop would over-trigger on complete small calls, so
          // we intentionally do not. (Streaming, the common path, detects it
          // precisely via the salvage signal.)
          toolBlocks.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: typeof block.input === 'object' && block.input !== null ? block.input : {},
          });
        }
      }

      return {
        textBlocks,
        toolBlocks,
        thinkingBlocks,
        usage: normalizeAnthropicUsage((response as Anthropic.Messages.Message).usage),
        stopReason: (response as Anthropic.Messages.Message).stop_reason ?? undefined,
      };
    }, signal, 3, streamOptions?.onRateLimit, streamOptions?.onRetryAfter, {
      model: streamOptions?.modelOverride ?? this.config.model,
      onRejected: streamOptions?.onReasoningEffortRejected,
    });
  }

  private serializeSystemMessageContent(content: string | KodaXContentBlock[]): string {
    if (typeof content === 'string') {
      return content.trim();
    }

    // FEATURE_116 fail-loud: a cache-boundary marker reaching the wire
    // serialization path means lowering was skipped somewhere upstream.
    // Silently dropping the marker would silently disable caching on
    // that branch — refuse to serialize so the caller fixes the
    // omission.
    for (const block of content) {
      if (isCacheBoundary(block)) {
        throw new KodaXProviderError(
          'cache-boundary marker reached system message serialization unlowered. '
            + 'Provider base class lowering must run before any wire-level serialization.',
          this.name,
          { failureCode: 'request_build_failed', stage: 'request_build' },
        );
      }
    }

    return content
      .filter((block): block is KodaXTextBlock => block.type === 'text')
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join('\n');
  }

  private buildSystemPrompt(baseSystem: string, messages: KodaXMessage[]): string {
    const inlineSystemMessages = messages
      .filter((message) => message.role === 'system')
      .map((message) => this.serializeSystemMessageContent(message.content))
      .filter(Boolean);

    return [baseSystem, ...inlineSystemMessages]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n\n');
  }

  private async convertMessages(
    messages: KodaXMessage[],
    model?: string,
  ): Promise<Anthropic.Messages.MessageParam[]> {
    // Filter out 'system' role messages - Anthropic API only supports 'user' and 'assistant' in messages array
    // System messages are handled via the separate 'system' parameter
    const converted: Anthropic.Messages.MessageParam[] = [];
    // Resolve strict-signature once per call so all three downstream
    // branches share the same answer for the active model.
    const strictSignature = this.getEffectiveStrictThinkingSignature(model);

    for (const m of messages.filter((message) => message.role !== 'system')) {
      const role: 'user' | 'assistant' = m.role === 'user' ? 'user' : 'assistant';
      if (typeof m.content === 'string') {
        converted.push({ role, content: m.content });
        continue;
      }
      const content: Anthropic.Messages.ContentBlockParam[] = [];

      // CRITICAL: Anthropic requires tool_result to be FIRST in user messages
      // Order must be: thinking -> tool_result -> tool_use -> text
      // Reference: https://docs.anthropic.com/en/docs/build-with-claude/tool-use

      // 1. thinking blocks (must be first for assistant messages)
      //
      // strictThinkingSignature mode (Anthropic proper) cryptographically
      // verifies `signature` server-side. Cross-provider thinking blocks
      // (kept around when user /model-switches mid-session) carry empty
      // or other-issuer signatures that fail verification → 400 thinking
      // signature invalid. Convert those to a `<prior_reasoning>` text
      // block so the reasoning context survives without being claimed
      // as Anthropic-generated thinking.
      //
      // Lenient mode (default; third-party Anthropic-compat servers like
      // kimi-code / ark-coding / mimo-coding / zhipu-coding /
      // minimax-coding) lacks the signing key and accepts any signature
      // including '', so we pass everything through unchanged.
      // v0.7.28.
      const crossProviderReasoning: string[] = [];
      for (const b of m.content) {
        if (b.type === 'thinking') {
          const trustedSignature = !strictSignature
            || (typeof b.signature === 'string' && b.signature.length > 0);
          if (trustedSignature) {
            content.push({ type: 'thinking', thinking: b.thinking, signature: b.signature ?? '' } as any);
          } else if (b.thinking) {
            // Strict mode + empty/missing signature → preserve the
            // reasoning text via a text block, dropped from the
            // thinking-block channel.
            crossProviderReasoning.push(b.thinking);
          }
        } else if (b.type === 'redacted_thinking') {
          if (!strictSignature) {
            // Lenient: third-party server doesn't decrypt the data
            // field, so passing it through is harmless.
            content.push({ type: 'redacted_thinking', data: b.data } as any);
          }
          // Strict mode: redacted blocks signed by another provider
          // would fail server-side decryption (data is provider-issued
          // ciphertext, not plaintext we can salvage). Drop silently —
          // there's nothing recoverable to convert. The original turn
          // already had no user-visible content; only the model's
          // sealed reasoning is lost.
        }
      }

      // 1.5 Cross-provider reasoning (strictThinkingSignature mode).
      // Emit immediately after the thinking-block channel so the
      // converted text occupies the same conceptual slot the original
      // thinking would have occupied (Anthropic protocol places
      // thinking first). Without this, the wire order would become
      // [tool_use, prior_reasoning, text] which inverts the natural
      // "think, then act, then explain" reading order. Wrapped in
      // <prior_reasoning> tags so the model treats the block as
      // historical context, not its own visible output. v0.7.28.
      if (crossProviderReasoning.length > 0 && m.role === 'assistant') {
        content.push({
          type: 'text',
          text: `<prior_reasoning>\n${crossProviderReasoning.join('\n\n')}\n</prior_reasoning>`,
        } as Anthropic.Messages.TextBlockParam);
      }

      // 2. tool_result MUST come before text in user messages
      for (const b of m.content) {
        if (b.type === 'tool_result' && m.role === 'user') {
          // Tool_result content can be (a) a plain string — passed through
          // as-is (Anthropic accepts string), or (b) an array of typed
          // content items — each item lowered to Anthropic's wire shape.
          // Image items are read from disk and base64-encoded just like
          // top-level image blocks above.
          let serializedContent: Anthropic.Messages.ToolResultBlockParam['content'];
          if (typeof b.content === 'string') {
            serializedContent = b.content;
          } else {
            const items: Array<Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam> = [];
            for (const item of b.content) {
              if (item.type === 'text') {
                items.push({ type: 'text', text: item.text });
              } else if (item.type === 'image') {
                const encoded = await readImageFileAsBase64IfAvailable(
                  item.path,
                );
                if (encoded === undefined) {
                  items.push({ type: 'text', text: MISSING_IMAGE_PLACEHOLDER });
                } else {
                  items.push({
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: resolveImageMediaType(item.path, item.mediaType),
                      data: encoded,
                    },
                  } as Anthropic.Messages.ImageBlockParam);
                }
              }
            }
            serializedContent = items;
          }
          content.push({
            type: 'tool_result',
            tool_use_id: b.tool_use_id,
            content: serializedContent,
            ...(b.is_error === true ? { is_error: true } : {}),
          } as Anthropic.Messages.ToolResultBlockParam);
        }
      }

      // 3. tool_use in assistant messages
      for (const b of m.content) {
        if (b.type === 'tool_use' && m.role === 'assistant') {
          content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
        }
      }

      // 4. text/image blocks (must come after tool_result in user messages)
      for (const b of m.content) {
        if (b.type === 'text') {
          content.push({ type: 'text', text: b.text });
        } else if (b.type === 'image' && m.role === 'user') {
          const encoded = await readImageFileAsBase64IfAvailable(
            b.path,
          );
          if (encoded === undefined) {
            content.push({ type: 'text', text: MISSING_IMAGE_PLACEHOLDER });
          } else {
            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: resolveImageMediaType(b.path, b.mediaType),
                data: encoded,
              },
            } as Anthropic.Messages.ImageBlockParam);
          }
        }
      }

      // Guard: when thinking is enabled, providers like Kimi require every assistant
      // tool-call message to include non-empty reasoning content. For messages that
      // never had thinking blocks (e.g. session restore, pre-thinking history),
      // inject a minimal thinking block to satisfy this requirement.
      //
      // **Skipped in strictThinkingSignature mode (Anthropic proper)**:
      // injecting a '...' placeholder with `signature: ''` would itself
      // fail Anthropic's cryptographic signature verification (400
      // "thinking signature invalid"). Anthropic doesn't require
      // thinking blocks on tool-use turns that didn't originally have
      // them — the guard exists for lenient third-party servers (Kimi)
      // that strictly check field presence. If a cross-provider
      // tool-use turn legitimately lacks thinking and Anthropic does
      // 400 on it, the L3 sanitize_thinking_and_retry recovery cleans
      // the history once and retries without thinking. v0.7.28.
      if (
        role === 'assistant' &&
        this.config.supportsThinking &&
        !strictSignature
      ) {
        const hasToolUse = content.some(b => (b as any).type === 'tool_use');
        const hasThinking = content.some(b =>
          (b as any).type === 'thinking' || (b as any).type === 'redacted_thinking',
        );
        if (hasToolUse && !hasThinking) {
          content.unshift({ type: 'thinking', thinking: '...', signature: '' } as any);
        }
      }

      // Guard: providers like Kimi reject messages with empty/substance-free content
      // (400 "must not be empty"). Inject minimal placeholder rather than dropping,
      // because dropping breaks the alternating user/assistant pattern.
      //
      // Applies to user messages too, not just assistant: an empty-text marker
      // (`{ text: '' }`) can land on a USER turn when a recovery pass
      // (tool-guard.filterIncompleteToolCalls) strips a dropped tool_result
      // that was the user message's sole content. Without this, that user
      // turn would serialize to an empty text block and 400. (The OpenAI side
      // drops such an empty user turn in serializeUserMessage; Anthropic keeps
      // the slot with a wire-only '...' to preserve alternation.)
      const isEffectivelyEmpty = content.length === 0 || (
        (role === 'assistant' || role === 'user') && content.every((b) => {
          const t = b as unknown as { type: string; thinking?: string; text?: string };
          return (t.type === 'thinking' && !t.thinking)
            || (t.type === 'text' && !t.text);
        })
      );

      converted.push({
        role: m.role,
        content: isEffectivelyEmpty
          ? [{ type: 'text', text: '...' } as Anthropic.Messages.ContentBlockParam]
          : content,
      } as Anthropic.Messages.MessageParam);
    }

    return this.repairToolCallHistory(converted);
  }

  /**
   * Wire-only defense-in-depth: drop orphan `tool_use` / `tool_result` blocks
   * so the Anthropic API never 400s on "tool_use ids ... were not found in
   * tool_result blocks" or "unexpected tool_result". The upstream
   * `validateAndFixToolHistory` (run every turn before serialization) is the
   * primary guard; this mirrors the OpenAI-side `repairToolCallHistory` so
   * both provider families have the same last-mile net for any path that
   * bypasses validate (custom callers, side queries). Never mutates input.
   *
   * Pairing is computed against adjacent messages (same rule as validate): a
   * `tool_use` is orphan when the immediately-following user message has no
   * matching `tool_result`; a `tool_result` is orphan when the
   * immediately-preceding assistant message has no matching `tool_use`. A
   * message emptied by repair is replaced with a minimal wire-only `'...'`
   * text block to keep user/assistant alternation and satisfy gateways that
   * reject empty content.
   */
  private repairToolCallHistory(
    messages: Anthropic.Messages.MessageParam[],
  ): Anthropic.Messages.MessageParam[] {
    const collectIds = (
      msg: Anthropic.Messages.MessageParam | undefined,
      kind: 'tool_use' | 'tool_result',
    ): Set<string> => {
      const ids = new Set<string>();
      if (!msg || typeof msg.content === 'string' || !Array.isArray(msg.content)) {
        return ids;
      }
      for (const block of msg.content) {
        const b = block as { type?: string; id?: string; tool_use_id?: string };
        if (kind === 'tool_use' && b.type === 'tool_use' && b.id) ids.add(b.id);
        if (kind === 'tool_result' && b.type === 'tool_result' && b.tool_use_id) {
          ids.add(b.tool_use_id);
        }
      }
      return ids;
    };

    return messages.map((msg, i) => {
      if (typeof msg.content === 'string' || !Array.isArray(msg.content)) return msg;

      let fixed = msg.content as Anthropic.Messages.ContentBlockParam[];
      if (msg.role === 'assistant') {
        const resultIds = collectIds(messages[i + 1], 'tool_result');
        fixed = fixed.filter((block) => {
          const b = block as { type?: string; id?: string };
          return b.type !== 'tool_use' || (!!b.id && resultIds.has(b.id));
        });
      } else if (msg.role === 'user') {
        const useIds = collectIds(messages[i - 1], 'tool_use');
        fixed = fixed.filter((block) => {
          const b = block as { type?: string; tool_use_id?: string };
          return b.type !== 'tool_result' || (!!b.tool_use_id && useIds.has(b.tool_use_id));
        });
      }

      if (fixed.length === msg.content.length) return msg;
      if (fixed.length === 0) {
        return {
          ...msg,
          content: [{ type: 'text', text: '...' }],
        } as Anthropic.Messages.MessageParam;
      }
      return { ...msg, content: fixed } as Anthropic.Messages.MessageParam;
    });
  }
}
