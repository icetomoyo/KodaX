/**
 * KodaX OpenAI Compatible Provider
 *
 * 支持 OpenAI API 格式的 Provider 基类
 */

import type OpenAI from 'openai';
import { KodaXBaseProvider } from './base.js';
import { KodaXProviderError } from '../errors.js';
import { parseToolInputWithSalvageTracked } from './tool-input-parser.js';
import { isCleanStop } from '../stop-reason.js';
import {
  KodaXContentBlock,
  KodaXNormalizedReasoningRequest,
  KodaXOpenAICompatMaxOutputTokensField,
  KodaXReasoningCapability,
  KodaXReasoningProfile,
  KodaXProviderConfig,
  KodaXMessage,
  KodaXToolDefinition,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXThinkingBlock,
  KodaXRedactedThinkingBlock,
  KodaXTextBlock,
  KodaXTokenUsage,
  KodaXToolUseBlock,
  KodaXVerifyCredentialResult,
} from '../types.js';
import { runVerifyCredential, type VerifyPrimitiveRunner } from './verify-credential.js';
import {
  clampThinkingBudget,
  effortToThinkingDepth,
  isReasoningEnabled,
  mapDepthToOpenAIReasoningEffort,
  resolveThinkingBudget,
} from '../reasoning.js';
import { stripCacheBoundaries } from '../cache-control.js';
import {
  hasProviderCredentialContext,
  withProviderRequestCredential,
} from '../provider-credential-context.js';
import {
  buildImageDataUrlIfAvailable,
  isImageFileMissing,
  MISSING_IMAGE_PLACEHOLDER,
  UNSUPPORTED_TOOL_RESULT_IMAGE_PLACEHOLDER,
} from './image-serialization.js';
import { resolvePromptCacheDisabled } from '../run-scoped-config.js';

const KODAX_OPENAI_COMPAT_USER_AGENT = 'KodaX';

async function createOpenAISdkClient(
  options: ConstructorParameters<typeof OpenAI>[0],
): Promise<OpenAI> {
  const { default: OpenAISdk } = await import('openai');
  return new OpenAISdk(options);
}

type OpenAIReasoningAttempt =
  | 'profile'
  | 'native-budget'
  | 'native-effort'
  | 'native-toggle'
  | 'none';

function isOpenAIReasoningAttempt(
  capability: KodaXReasoningCapability,
): capability is Exclude<OpenAIReasoningAttempt, 'profile'> {
  return capability === 'native-budget' ||
    capability === 'native-effort' ||
    capability === 'native-toggle' ||
    capability === 'none';
}

function getOpenAICompatDefaultHeaders(
  config: KodaXProviderConfig,
): Record<string, string> | undefined {
  return config.userAgentMode === 'sdk'
    ? undefined
    : { 'User-Agent': KODAX_OPENAI_COMPAT_USER_AGENT };
}

function serializeOpenAICompatMaxOutputTokens(
  field: KodaXOpenAICompatMaxOutputTokensField,
  maxOutputTokens: number,
): { max_tokens: number } | { max_completion_tokens: number } {
  return field === 'max_tokens'
    ? { max_tokens: maxOutputTokens }
    : { max_completion_tokens: maxOutputTokens };
}

function appendOpenAIEphemeralSuffix(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  suffix: string | undefined,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  if (!suffix) return messages;
  const last = messages.at(-1);
  if (last?.role !== 'user') {
    return [...messages, { role: 'user', content: suffix }];
  }
  const content = typeof last.content === 'string'
    ? last.content.length > 0
      ? `${last.content}\n\n${suffix}`
      : suffix
    : [...last.content, { type: 'text' as const, text: suffix }];
  return [...messages.slice(0, -1), { ...last, content }];
}

function selectOpenAIReasoningEffort(
  reasoning: KodaXNormalizedReasoningRequest,
): string | undefined {
  if (reasoning.effort === 'none') {
    return undefined;
  }
  if (reasoning.effort && reasoning.effort !== 'auto') {
    return reasoning.effort;
  }
  if (reasoning.effort === 'auto' && reasoning.effortSource === 'explicit') {
    return undefined;
  }
  return mapDepthToOpenAIReasoningEffort(effortToThinkingDepth(reasoning.effort));
}

export type OpenAIUsageLike = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number | null;
  } | null;
  // FEATURE_116 Sub-task D — DeepSeek private cache fields. DeepSeek's
  // OpenAI-compat /chat/completions returns cache stats at the TOP level
  // of `usage` (not nested), with prompt_tokens === hit + miss. Reading
  // these recovers a ~4x cost-report inflation for cached requests
  // (DeepSeek server-side cache fires regardless; only KodaX's local
  // accounting was blind to it). Verified against DeepSeek API docs
  // 2026-05-08. See docs/features/v0.7.37.md § Sub-task 116-D.
  prompt_cache_hit_tokens?: number | null;
  prompt_cache_miss_tokens?: number | null;
} | null | undefined;

export function normalizeOpenAIUsage(usage: OpenAIUsageLike): KodaXTokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const totalTokens =
    typeof usage.total_tokens === 'number'
      ? usage.total_tokens
      : inputTokens + outputTokens;

  if ([inputTokens, outputTokens, totalTokens].some((value) => !Number.isFinite(value) || value < 0)) {
    return undefined;
  }

  if (totalTokens < inputTokens || totalTokens < outputTokens) {
    return undefined;
  }

  // OpenAI-standard `prompt_tokens_details.cached_tokens` wins on conflict
  // for forward compat (if DeepSeek ever adds the standard field, prefer
  // it). Falls back to DeepSeek's private `prompt_cache_hit_tokens` when
  // the standard field is absent — same semantics (subset of prompt_tokens).
  const cachedReadTokens =
    typeof usage.prompt_tokens_details?.cached_tokens === 'number' &&
    usage.prompt_tokens_details.cached_tokens >= 0
      ? usage.prompt_tokens_details.cached_tokens
      : typeof usage.prompt_cache_hit_tokens === 'number' &&
        usage.prompt_cache_hit_tokens >= 0
        ? usage.prompt_cache_hit_tokens
        : undefined;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cachedReadTokens !== undefined ? { cachedReadTokens } : {}),
  };
}

function isOpenAIFunctionToolCall(
  toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall | null | undefined,
): toolCall is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall {
  if (!toolCall) {
    return false;
  }
  return toolCall.type === 'function' && 'function' in toolCall;
}

function extractOpenAIMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }

      const directText = Reflect.get(part, 'text');
      if (typeof directText === 'string') {
        return directText;
      }

      if (directText && typeof directText === 'object') {
        const nestedValue = Reflect.get(directText, 'value');
        return typeof nestedValue === 'string' ? nestedValue : '';
      }

      return '';
    })
    .filter(Boolean)
    .join('');
}

// Non-streaming counterpart to extractReasoningDelta(). Without this, thinking
// content silently disappears when streaming falls back to complete().
function extractOpenAIMessageReasoning(message: unknown): string {
  if (!message || typeof message !== 'object') {
    return '';
  }
  const raw = Reflect.get(message, 'reasoning_content');
  if (typeof raw === 'string') {
    return raw;
  }
  if (!Array.isArray(raw)) {
    return '';
  }
  return raw
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (
        part &&
        typeof part === 'object' &&
        'text' in part &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        return (part as { text: string }).text;
      }
      return '';
    })
    .join('');
}

type WireToolCall = {
  readonly id: string;
  readonly value: unknown;
};

function getWireRole(message: OpenAI.Chat.ChatCompletionMessageParam): string | undefined {
  const role = (message as unknown as Record<string, unknown>).role;
  return typeof role === 'string' ? role : undefined;
}

function getAssistantWireToolCalls(
  message: OpenAI.Chat.ChatCompletionMessageParam,
): WireToolCall[] | undefined {
  if (getWireRole(message) !== 'assistant') {
    return undefined;
  }
  const rawToolCalls = (message as unknown as Record<string, unknown>).tool_calls;
  if (!Array.isArray(rawToolCalls)) {
    return undefined;
  }

  return rawToolCalls.flatMap((toolCall): WireToolCall[] => {
    if (!toolCall || typeof toolCall !== 'object') {
      return [];
    }
    const id = (toolCall as Record<string, unknown>).id;
    return typeof id === 'string' && id.trim().length > 0
      ? [{ id, value: toolCall }]
      : [];
  });
}

function getToolWireCallId(
  message: OpenAI.Chat.ChatCompletionMessageParam,
): string | undefined {
  if (getWireRole(message) !== 'tool') {
    return undefined;
  }
  const id = (message as unknown as Record<string, unknown>).tool_call_id;
  return typeof id === 'string' && id.trim().length > 0 ? id : undefined;
}

function rewriteAssistantWireToolCalls(
  message: OpenAI.Chat.ChatCompletionMessageParam,
  toolCalls: WireToolCall[],
): OpenAI.Chat.ChatCompletionMessageParam {
  const clone: Record<string, unknown> = {
    ...(message as unknown as Record<string, unknown>),
  };

  if (toolCalls.length > 0) {
    clone.tool_calls = toolCalls.map((toolCall) => toolCall.value);
    return clone as unknown as OpenAI.Chat.ChatCompletionMessageParam;
  }

  delete clone.tool_calls;
  if (clone.content == null || clone.content === '') {
    clone.content = '...';
  }
  return clone as unknown as OpenAI.Chat.ChatCompletionMessageParam;
}

export abstract class KodaXOpenAICompatProvider extends KodaXBaseProvider {
  abstract override readonly name: string;
  readonly supportsThinking = true;
  protected abstract override readonly config: KodaXProviderConfig;
  private _client?: OpenAI;
  private _clientPromise?: Promise<OpenAI>;

  override supportsEphemeralSuffix(): boolean {
    return true;
  }

  /**
   * The SDK client is built lazily on first use. Constructing it requires the
   * API key (`getApiKey()` throws when the env var is unset), so deferring it
   * lets callers construct a provider and read static metadata (context
   * window, model descriptors) without a key. This also keeps key-less unit
   * tests (which mock the actual LLM calls) from failing at construction time.
   */
  protected async getClient(): Promise<OpenAI> {
    if (hasProviderCredentialContext()) return this.buildClient();
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
  protected set client(client: OpenAI) {
    this._client = client;
    this._clientPromise = undefined;
  }

  protected buildClient(): OpenAI | Promise<OpenAI> {
    const defaultHeaders = getOpenAICompatDefaultHeaders(this.config);
    return createOpenAISdkClient({
      apiKey: this.getApiKey(),
      baseURL: this.config.baseUrl,
      // Some OpenAI-compatible gateways block the SDK's default
      // "OpenAI/JS ..." user agent even when the payload itself is valid.
      ...(defaultHeaders ? { defaultHeaders } : {}),
    });
  }

  private getEffectiveMaxOutputTokensField(
    model: string,
  ): KodaXOpenAICompatMaxOutputTokensField {
    return this.getModelDescriptor(model)?.maxOutputTokensField
      ?? this.config.maxOutputTokensField
      ?? 'max_completion_tokens';
  }

  protected override onStaleConnection(): void {
    // Drop the memoized client so the next call rebuilds it, discarding the
    // stale keep-alive socket pool.
    this._client = undefined;
  }

  /**
   * FEATURE_216 v0.7.45 — Lightweight credential verification.
   * Dispatches by `this.config.verifyStrategy`:
   *   - `models-list` (default for OpenAI protocol): 0-token
   *     `models.list()` — empirically reliable for openai-compat
   *     providers where `/v1/models` gates on auth (kimi / qwen /
   *     deepseek confirmed). Verified by opencode `setup-recording-env.ts`
   *     for OPENAI_API_KEY proper.
   *   - `minimal-message`: ~6-token `chat.completions.create({max_tokens:1})`
   *     fallback for OpenAI-compat providers whose `/v1/models` is
   *     publicly accessible (zhipu — false-positive risk).
   *   - `count-tokens`: NOT supported on OpenAI protocol. Custom provider
   *     validator rejects this combo at config time; built-in providers
   *     never declare it. Orchestrator returns `unsupported` if it slips
   *     through, surfacing the misconfiguration.
   */
  override async verifyCredential(opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<KodaXVerifyCredentialResult> {
    const model = this.config.model;
    const wireModel = this.getWireModelId(model);
    const runners: VerifyPrimitiveRunner[] = [
      {
        strategy: 'models-list',
        approxTokensSpent: 0,
        run: (signal) => withProviderRequestCredential(
          this.name,
          'utility',
          signal,
          async (requestSignal) => {
            const client = await this.getClient();
            await client.models.list({ signal: requestSignal });
          },
        ),
      },
      {
        strategy: 'minimal-message',
        approxTokensSpent: 6,
        run: (signal) => withProviderRequestCredential(
          this.name,
          'utility',
          signal,
          async (requestSignal) => {
            const client = await this.getClient();
            await client.chat.completions.create(
              {
                model: wireModel,
                ...serializeOpenAICompatMaxOutputTokens(
                  this.getEffectiveMaxOutputTokensField(model),
                  1,
                ),
                messages: [{ role: 'user', content: 'hi' }],
              },
              { signal: requestSignal },
            );
          },
        ),
      },
      // No 'count-tokens' runner: OpenAI protocol has no equivalent of
      // Anthropic's messages.countTokens(). Config-level validator
      // already prevents this combo; orchestrator surfaces a clear
      // "not implemented" if it slips through.
    ];
    return runVerifyCredential({
      strategy: this.config.verifyStrategy ?? 'models-list',
      runners,
      timeoutMs: opts?.timeoutMs,
      signal: opts?.signal,
      providerName: this.name,
    });
  }

  /**
   * FEATURE_116 (v0.7.37) — Strip any `cache-boundary` markers from
   * KodaXMessage content arrays before they reach OpenAI wire
   * serialization. OpenAI / DeepSeek auto-cache prefix tokens
   * server-side, so the client has no marker to lower; Kimi/Zhipu/通义
   * self-cache via separate `cache_id` endpoints that are deferred to
   * v0.7.45+ (FEATURE_102). Stripping is the correct universal action
   * for this base class.
   *
   * Idempotent: a message whose content is a string or contains no
   * boundaries returns the same reference. Safe to call multiple times.
   */
  protected stripCacheBoundariesFromMessages(
    messages: KodaXMessage[],
  ): KodaXMessage[] {
    return messages.map((m) => {
      if (typeof m.content === 'string') return m;
      const stripped = stripCacheBoundaries(m.content);
      // Preserve identity when nothing changed — keeps downstream
      // memoization and === checks behaving as before.
      return stripped.length === m.content.length
        ? m
        : { ...m, content: stripped };
    });
  }

  /**
   * Collapse every `role: 'system'` message (the `system` parameter plus any
   * system messages embedded in `messages`) into a single top-of-wire system
   * content and return the remaining non-system messages. Some OpenAI-compat
   * gateways — notably third-party Qwen proxies — reject any system message
   * that is not at position 0, so this normalization guarantees the wire has
   * exactly one system entry regardless of what the upstream caller passed.
   *
   * Post-compact attachments, compaction summaries and handoff-time
   * `replaceSystemMessage` can all leave secondary `role: 'system'` entries
   * mid-transcript; merging here is the provider-layer bottleneck that keeps
   * callers from having to coordinate.
   */
  private normalizeSystemForWire(
    system: string,
    messages: KodaXMessage[],
  ): { system: string; rest: KodaXMessage[] } {
    const parts: string[] = [];
    if (system && system.trim().length > 0) {
      parts.push(system);
    }
    const rest: KodaXMessage[] = [];
    for (const message of messages) {
      if (message.role !== 'system') {
        rest.push(message);
        continue;
      }
      const text = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((block): block is KodaXTextBlock =>
                typeof block === 'object'
                && block !== null
                && (block as { type?: string }).type === 'text'
                && typeof (block as { text?: unknown }).text === 'string')
              .map((block) => block.text)
              .join('\n')
          : '';
      if (text.trim().length > 0) {
        parts.push(text);
      }
    }
    return { system: parts.join('\n\n'), rest };
  }

  private appendExtraBody(
    params: Record<string, unknown>,
    extraBody: Record<string, unknown>,
  ): void {
    const current =
      typeof params.extra_body === 'object' && params.extra_body !== null
        ? params.extra_body as Record<string, unknown>
        : {};
    params.extra_body = {
      ...current,
      ...extraBody,
    };
  }

  private resetReasoningCapabilityParams(
    params: Record<string, unknown>,
  ): void {
    delete params.reasoning_effort;
    delete params.thinking;

    const extraBody =
      typeof params.extra_body === 'object' && params.extra_body !== null
        ? { ...(params.extra_body as Record<string, unknown>) }
        : undefined;

    if (!extraBody) {
      return;
    }

    delete extraBody.enable_thinking;
    delete extraBody.thinking_budget;
    delete extraBody.thinking;

    if (Object.keys(extraBody).length === 0) {
      delete params.extra_body;
      return;
    }

    params.extra_body = extraBody;
  }

  private applyReasoningCapability(
    createParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
    model: string,
    capability: OpenAIReasoningAttempt,
    reasoning: KodaXNormalizedReasoningRequest,
    suppressReasoningEffort: boolean,
    maxOutputTokens: number,
  ): void {
    // Passive-learning self-heal retry: the prior attempt was rejected for its
    // reasoning-effort value, so drop ALL reasoning params and let the provider
    // use its default — the retried turn completes without the bad effort.
    if (suppressReasoningEffort) {
      return;
    }
    // Part 2 degradation rung (mirrors the anthropic ladder): the terminal 'none'
    // attempt emits NO reasoning param, even when a reasoningProfile exists. An
    // OpenAI-compat relay that rejected the profile's shape (thinking / reasoning_effort)
    // then completes the turn param-free instead of re-applying the same rejected shape
    // and hard-failing. reasoning_content is parsed unconditionally regardless. (native-
    // effort/budget/toggle stay in the attempt ladder as the primary, so the profile is
    // still applied first; only the post-rejection 'none' rung is param-free.)
    if (capability === 'none') {
      return;
    }
    // The OpenAI SDK types do not expose provider-specific extensions like
    // Qwen's extra_body or Zhipu's thinking block, so we intentionally attach
    // those fields on the raw request object here.
    const params = createParams as unknown as Record<string, unknown>;
    const requestedBudget = clampThinkingBudget(
      resolveThinkingBudget(
        this.config,
        effortToThinkingDepth(reasoning.effort),
        reasoning.taskType,
      ),
      maxOutputTokens,
    );
    const reasoningProfile = this.getReasoningProfile(model);
    if (reasoningProfile) {
      this.applyReasoningProfile(
        params,
        reasoningProfile,
        reasoning,
        model,
        requestedBudget,
      );
      return;
    }

    switch (capability) {
      case 'native-effort': {
        this.validateExplicitReasoningEffort(reasoning, model);
        const reasoningEffort = selectOpenAIReasoningEffort(reasoning);
        if (reasoningEffort) {
          params.reasoning_effort = reasoningEffort;
        }
        break;
      }
      case 'native-budget': {
        if (this.name === 'qwen') {
          this.appendExtraBody(params, {
            enable_thinking: true,
            thinking_budget: requestedBudget,
          });
        } else if (this.name === 'zhipu') {
          params.thinking = {
            type: 'enabled',
            budget_tokens: requestedBudget,
          };
        }
        break;
      }
      case 'native-toggle': {
        if (this.name === 'qwen') {
          this.appendExtraBody(params, {
            enable_thinking: true,
          });
        } else if (this.name === 'zhipu') {
          params.thinking = {
            type: 'enabled',
          };
        }
        break;
      }
      default:
        break;
    }
  }

  private applyReasoningProfile(
    params: Record<string, unknown>,
    capability: KodaXReasoningProfile,
    reasoning: KodaXNormalizedReasoningRequest,
    model: string,
    requestedBudget: number,
  ): void {
    this.validateExplicitReasoningEffort(reasoning, model);
    const intent = this.resolveReasoningProfileIntent(reasoning, capability, model);
    const preset = capability.reasoningPreset;

    // "Always-thinks" coding models (kimi-k2.7-code, minimax-m2-always): enable
    // thinking explicitly even though the effort LEVEL is prompt-only (mirrors
    // anthropic.ts — see the v0.7.57 regression note there). Matches what the
    // provider-toggle branch already sends for kimi on this path.
    if (preset === 'kimi-k2.7-code' || preset === 'minimax-m2-always') {
      params.thinking = { type: 'enabled' };
      return;
    }

    // Kimi's OpenAI-compatible endpoint uses the same nested thinking.effort shape.
    if (preset === 'kimi-k3') {
      const useModelDefault =
        reasoning.effortSource === 'omitted' && reasoning.effort === 'none';
      if (intent.disabled && !useModelDefault) {
        params.thinking = { type: 'disabled' };
        return;
      }
      params.thinking = {
        type: 'enabled',
        effort: useModelDefault
          ? capability.defaultEffort ?? 'max'
          : intent.effort ?? capability.defaultEffort ?? 'max',
      };
      return;
    }

    if (
      preset === 'none' ||
      capability.effortStrategy === 'none' ||
      capability.effortStrategy === 'prompt-only'
    ) {
      return;
    }

    if (preset === 'qwen-hybrid-thinking') {
      if (intent.disabled) {
        this.appendExtraBody(params, { enable_thinking: false });
        return;
      }
      const budget = this.resolveReasoningProfileBudget(
        capability,
        intent.effort,
        model,
        requestedBudget,
      );
      this.appendExtraBody(params, {
        enable_thinking: true,
        ...(budget !== undefined ? { thinking_budget: budget } : {}),
      });
      return;
    }

    if (
      preset === 'deepseek-v4-flash-openai' ||
      preset === 'deepseek-v4-pro-openai' ||
      preset === 'deepseek-v4-openai' ||
      preset === 'zai-glm-5.3' ||
      preset === 'zai-glm-5.2'
    ) {
      if (preset === 'zai-glm-5.3' && intent.disabled) {
        params.thinking = { type: 'enabled' };
        params.reasoning_effort = 'low';
        return;
      }
      params.thinking = { type: intent.disabled ? 'disabled' : 'enabled' };
      if (!intent.disabled && intent.effort) {
        params.reasoning_effort = intent.effort;
      }
      return;
    }

    if (
      preset === 'zai-glm-toggle' ||
      preset === 'deepseek-toggle' ||
      preset === 'kimi-hybrid-toggle' ||
      capability.thinkingStrategy === 'provider-toggle'
    ) {
      params.thinking = { type: intent.disabled ? 'disabled' : 'enabled' };
      // A friendly-form provider that ALSO declares openai-chat-effort accepts a
      // reasoning_effort alongside the thinking toggle — send it instead of
      // dropping it by returning early (this block otherwise pre-empts the
      // openai-chat-effort branch below). Mirrors the deepseek-v4-openai block
      // above and the symmetric Anthropic-side handling.
      if (
        !intent.disabled &&
        intent.effort &&
        capability.effortStrategy === 'openai-chat-effort'
      ) {
        params.reasoning_effort = intent.effort;
      }
      return;
    }

    if (capability.effortStrategy === 'openai-chat-effort') {
      if (intent.disabled) {
        if (capability.supportedEfforts?.some((entry) => entry.value === 'none')) {
          params.reasoning_effort = 'none';
        }
        return;
      }
      if (intent.effort) {
        params.reasoning_effort = intent.effort;
      }
      return;
    }

    if (capability.effortStrategy === 'provider-budget') {
      if (intent.disabled) {
        params.thinking = { type: 'disabled' };
        return;
      }
      const budget = this.resolveReasoningProfileBudget(
        capability,
        intent.effort,
        model,
        requestedBudget,
      );
      params.thinking = {
        type: 'enabled',
        ...(budget !== undefined ? { budget_tokens: budget } : {}),
      };
      return;
    }

    if (capability.effortStrategy === 'provider-toggle') {
      params.thinking = { type: intent.disabled ? 'disabled' : 'enabled' };
    }
  }

  private resolveReasoningProfileBudget(
    capability: KodaXReasoningProfile,
    effort: string | undefined,
    model: string,
    fallbackBudget: number,
  ): number | undefined {
    if (!capability.supportsManualThinkingBudget && capability.effortStrategy !== 'provider-budget') {
      return undefined;
    }
    const budget = effort && capability.budgetByEffort?.[effort] !== undefined
      ? capability.budgetByEffort[effort]
      : fallbackBudget;
    const cap = this.getEffectiveThinkingBudgetCap(model);
    if (cap !== undefined) {
      return Math.min(budget, cap);
    }
    return budget;
  }

  private getFallbackTerms(capability: OpenAIReasoningAttempt): string[] {
    switch (capability) {
      case 'profile':
        return ['thinking', 'reasoning_effort', 'enable_thinking', 'thinking_budget', 'budget_tokens'];
      case 'native-budget':
        return ['thinking_budget', 'budget_tokens', 'thinking'];
      case 'native-effort':
        return ['reasoning_effort'];
      case 'native-toggle':
        return ['enable_thinking', 'thinking'];
      default:
        return [];
    }
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
      // FEATURE_116 (v0.7.37): strip any cache-boundary markers before
      // building the wire payload. OpenAI-compat path has no client-side
      // cache marker to lower; the markers are KodaX-internal only.
      const cleanMessages = this.stripCacheBoundariesFromMessages(messages);
      const { system: mergedSystem, rest: nonSystemMessages } =
        this.normalizeSystemForWire(system, cleanMessages);
      // Resolve the active model up front so the message serializer can
      // pick per-model replayReasoningContent overrides (KodaXModelDescriptor).
      const model = streamOptions?.modelOverride ?? this.config.model;
      const wireModel = this.getWireModelId(model);
      const fullMessages = appendOpenAIEphemeralSuffix([
        { role: 'system', content: mergedSystem },
        ...await this.convertMessages(nonSystemMessages, model),
      ], streamOptions?.ephemeralSuffix?.content);
      const openaiTools = tools.map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }));
      const forcedToolName = streamOptions?.forcedToolName;
      let shouldForceToolChoice = openaiTools.length > 0 && Boolean(forcedToolName);

      // 检查是否已被取消
      if (signal?.aborted) {
        throw new DOMException('Request aborted', 'AbortError');
      }

      const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
      let textContent = '';
      let thinkingContent = '';
      let usage: KodaXTokenUsage | undefined;
      let includeUsage = true;

      // Issue 084 fix: Track stream completion
      let finishReason: string | null = null;
      const streamStartTime = Date.now();

      // 传递 signal 给 SDK，确保底层 HTTP 请求能被取消
      const normalizedReasoning = this.normalizeReasoning(reasoning);
      this.validateExplicitReasoningEffort(normalizedReasoning, model);
      const reasoningProfile = this.getReasoningProfile(model);
      const initialCapability =
        isReasoningEnabled(normalizedReasoning)
          ? this.getReasoningCapability(model)
          : 'none';
      const attempts: OpenAIReasoningAttempt[] =
        reasoningProfile
          ? ['profile', 'none']
          : isReasoningEnabled(normalizedReasoning)
            ? this.getReasoningFallbackChain(initialCapability).filter(isOpenAIReasoningAttempt)
            : ['none'];
      const requestMaxOutputTokens = streamOptions?.maxOutputTokensOverride
        ?? this.getEffectiveMaxOutputTokens(model);
      retryState.maxOutputTokensLimit ??= requestMaxOutputTokens;
      const maxOutputTokens = retryState.maxOutputTokensOverride
        ?? requestMaxOutputTokens;
      const createParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
        model: wireModel,
        messages: fullMessages,
        ...(openaiTools.length > 0 ? { tools: openaiTools } : {}),
        ...serializeOpenAICompatMaxOutputTokens(
          this.getEffectiveMaxOutputTokensField(model),
          maxOutputTokens,
        ),
        stream: true,
        ...(this.config.promptCacheAffinity === true
          && streamOptions?.promptCacheKey
          && !resolvePromptCacheDisabled()
          ? { prompt_cache_key: streamOptions.promptCacheKey }
          : {}),
      };
      if (openaiTools.length > 0 && forcedToolName && shouldForceToolChoice) {
        createParams.tool_choice = {
          type: 'function',
          function: { name: forcedToolName },
        };
      }

      const client = await this.getClient();
      let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> | undefined;
      let lastError: unknown;

      for (const capability of attempts) {
        while (!stream) {
          const attemptParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
            ...createParams,
          };

          if (includeUsage) {
            attemptParams.stream_options = { include_usage: true };
          }

          this.resetReasoningCapabilityParams(
            attemptParams as unknown as Record<string, unknown>,
          );
          this.applyReasoningCapability(
            attemptParams,
            model,
            capability,
            normalizedReasoning,
            retryState.suppressReasoningEffort,
            maxOutputTokens,
          );

          try {
            stream = await client.chat.completions.create(
              attemptParams,
              signal ? { signal } : {},
            );
          } catch (error) {
            lastError = error;
            if (shouldForceToolChoice && this.shouldFallbackForForcedToolChoiceError(error)) {
              shouldForceToolChoice = false;
              delete createParams.tool_choice;
              this.logStreamDiagnostic(
                `[${this.name}] upstream rejected forced tool_choice; retrying without forced tool choice`,
              );
              continue;
            }
            if (
              includeUsage &&
              this.shouldFallbackForSpecificReasoningError(error, 'stream_options', 'include_usage')
            ) {
              includeUsage = false;
              continue;
            }
            if (
              !this.shouldFallbackForReasoningError(
                error,
                ...this.getFallbackTerms(capability),
              )
            ) {
              throw error;
            }
            break;
          }
        }

        if (stream) {
          break;
        }
      }

      if (!stream) {
        throw lastError ?? new KodaXProviderError(
          'All reasoning capability attempts failed without a captured error',
          this.name,
        );
      }

      let prevChunkTime = Date.now();
      let stallCount = 0;
      let totalStallMs = 0;
      const STALL_THRESHOLD_MS = 30_000;

      for await (const chunk of stream) {
        // 检查是否被中断 (双重保险)
        if (signal?.aborted) {
          throw new DOMException('Request aborted', 'AbortError');
        }

        // Stall detection: passive diagnostic logging when gap > 30s.
        const now = Date.now();
        const gapMs = now - prevChunkTime;
        if (gapMs > STALL_THRESHOLD_MS) {
          stallCount++;
          totalStallMs += gapMs;
          this.logStreamDiagnostic(`[Stream] stall detected: ${Math.round(gapMs / 1000)}s gap`, {
            stallCount, totalStallMs,
          });
        }
        prevChunkTime = now;

        // Keep idle timers alive on every SSE chunk.
        streamOptions?.onHeartbeat?.();

        usage = normalizeOpenAIUsage(chunk.usage as OpenAIUsageLike) ?? usage;

        const choice = chunk.choices[0];
        const delta = choice?.delta;

        // Issue 084 fix: Track finish_reason to detect stream completion
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
          if (process.env.KODAX_DEBUG_STREAM) {
            const duration = Date.now() - streamStartTime;
            this.logStreamDiagnostic(`[Stream] finish_reason: ${finishReason} after ${duration}ms`);
          }
        }

        if (delta?.content) {
          textContent += delta.content;
          streamOptions?.onTextDelta?.(delta.content);
        }
        const reasoningDelta = this.extractReasoningDelta(delta);
        if (reasoningDelta) {
          thinkingContent += reasoningDelta;
          streamOptions?.onThinkingDelta?.(reasoningDelta);
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCallsMap.get(tc.index) ?? { id: '', name: '', arguments: '' };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
              streamOptions?.onToolInputDelta?.(
                existing.name,
                tc.function.arguments,
                existing.id ? { toolId: existing.id } : undefined,
              );
            }
            toolCallsMap.set(tc.index, existing);
          }
        }
      }

      // Issue 084 fix: Validate stream completed successfully
      // If finish_reason was never received, the stream was likely interrupted
      if (!finishReason) {
        const duration = Date.now() - streamStartTime;

        if (signal?.aborted) {
          const reason = signal.reason instanceof Error
            ? signal.reason.message
            : typeof signal.reason === 'string'
              ? signal.reason
              : 'Request aborted';
          this.logStreamDiagnostic('[Stream] Stream ended after abort before finish_reason:', {
            duration,
            reason,
            textContentLength: textContent.length,
            toolCallsCount: toolCallsMap.size
          });
          throw new DOMException(reason, 'AbortError');
        }

        const error = new Error(
          `Stream incomplete: finish_reason not received. ` +
          `Duration: ${duration}ms. ` +
          `This may indicate a network disconnection or API timeout.`
        );
        error.name = 'StreamIncompleteError';
        this.logStreamDiagnostic('[Stream] Incomplete stream detected:', {
          duration,
          textContentLength: textContent.length,
          toolCallsCount: toolCallsMap.size
        });
        throw error;
      }

      const textBlocks: KodaXTextBlock[] = textContent ? [{ type: 'text', text: textContent }] : [];
      const toolBlocks: KodaXToolUseBlock[] = [];
      const thinkingBlocks: (KodaXThinkingBlock | KodaXRedactedThinkingBlock)[] = [];
      if (thinkingContent) {
        thinkingBlocks.push({ type: 'thinking', thinking: thinkingContent });
        streamOptions?.onThinkingEnd?.(thinkingContent);
      }
      // `_salvaged` = strict parse failed (kept on a clean stop so a mutating
      // tool's malformed payload is still gated downstream). `_truncated` adds
      // "and the stop was NOT clean" (`length`/ambiguous), which is unsafe for
      // any tool. The execute-vs-retry decision (incl. the read-only clean-stop
      // allowance) is made by checkIncompleteToolCalls.
      const cleanStop = isCleanStop(finishReason ?? undefined);
      for (const [, tc] of toolCallsMap) {
        if (tc.id && tc.name) {
          const parsed = parseToolInputWithSalvageTracked(tc.arguments);
          const salvageFlags = parsed.salvaged
            ? (cleanStop ? { _salvaged: true } : { _salvaged: true, _truncated: true })
            : {};
          toolBlocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: parsed.value,
            ...salvageFlags,
          });
        } else {
          // Drop a tool_call missing id/name (cannot be paired with a
          // tool_result → would 400). Never drop silently: log it as an
          // anomaly (mirrors the Anthropic-side `[Tool Block Invalid]` log) so
          // a provider emitting malformed blocks is diagnosable. Gate behind
          // KODAX_DEBUG_TOOL_STREAM: a bare console.error mid-stream writes
          // below Ink's live region and corrupts the TUI (same class as the
          // compaction-stderr bug fixed in 123fba0f).
          if (process.env.KODAX_DEBUG_TOOL_STREAM) {
            console.error('[Tool Block Invalid] Dropped tool_call missing id or name:', {
              id: JSON.stringify(tc.id),
              name: JSON.stringify(tc.name),
              argsLength: tc.arguments?.length ?? 0,
            });
          }
        }
      }
      return { textBlocks, toolBlocks, thinkingBlocks, usage, stopReason: finishReason ?? undefined };
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
      // FEATURE_116 (v0.7.37): strip cache-boundary markers (see stream()).
      const cleanMessages = this.stripCacheBoundariesFromMessages(messages);
      const { system: mergedSystem, rest: nonSystemMessages } =
        this.normalizeSystemForWire(system, cleanMessages);
      const model = streamOptions?.modelOverride ?? this.config.model;
      const wireModel = this.getWireModelId(model);
      const fullMessages = appendOpenAIEphemeralSuffix([
        { role: 'system', content: mergedSystem },
        ...await this.convertMessages(nonSystemMessages, model),
      ], streamOptions?.ephemeralSuffix?.content);
      const openaiTools = tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      }));
      const forcedToolName = streamOptions?.forcedToolName;
      let shouldForceToolChoice = openaiTools.length > 0 && Boolean(forcedToolName);

      const normalizedReasoning = this.normalizeReasoning(reasoning);
      this.validateExplicitReasoningEffort(normalizedReasoning, model);
      const reasoningProfile = this.getReasoningProfile(model);
      const initialCapability =
        isReasoningEnabled(normalizedReasoning)
          ? this.getReasoningCapability(model)
          : 'none';
      const attempts: OpenAIReasoningAttempt[] = reasoningProfile
        ? ['profile', 'none']
        : isReasoningEnabled(normalizedReasoning)
          ? this.getReasoningFallbackChain(initialCapability).filter(isOpenAIReasoningAttempt)
          : ['none'];
      const requestMaxOutputTokens = streamOptions?.maxOutputTokensOverride
        ?? this.getEffectiveMaxOutputTokens(model);
      retryState.maxOutputTokensLimit ??= requestMaxOutputTokens;
      const maxOutputTokens = retryState.maxOutputTokensOverride
        ?? requestMaxOutputTokens;
      const createParams: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        model: wireModel,
        messages: fullMessages,
        ...(openaiTools.length > 0 ? { tools: openaiTools } : {}),
        ...serializeOpenAICompatMaxOutputTokens(
          this.getEffectiveMaxOutputTokensField(model),
          maxOutputTokens,
        ),
        ...(this.config.promptCacheAffinity === true
          && streamOptions?.promptCacheKey
          && !resolvePromptCacheDisabled()
          ? { prompt_cache_key: streamOptions.promptCacheKey }
          : {}),
      };
      if (openaiTools.length > 0 && forcedToolName && shouldForceToolChoice) {
        createParams.tool_choice = {
          type: 'function',
          function: { name: forcedToolName },
        };
      }

      let response: OpenAI.Chat.Completions.ChatCompletion | undefined;
      let lastError: unknown;

      const client = await this.getClient();
      for (const capability of attempts) {
        // Mirror the stream() path: an inner `while (!response)` so a
        // forced-tool-choice rejection retries the SAME capability without
        // tool_choice. A flat for+continue would instead skip to the next
        // capability — and with a single-element `attempts` (reasoning off)
        // the tool_choice fallback would never re-attempt at all.
        while (!response) {
          const attemptParams: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
            ...createParams,
          };

          this.resetReasoningCapabilityParams(
            attemptParams as unknown as Record<string, unknown>,
          );
          this.applyReasoningCapability(
            attemptParams as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
            model,
            capability,
            normalizedReasoning,
            retryState.suppressReasoningEffort,
            maxOutputTokens,
          );

          try {
            response = await client.chat.completions.create(
              attemptParams,
              signal ? { signal } : {},
            ) as OpenAI.Chat.Completions.ChatCompletion;
          } catch (error) {
            lastError = error;
            if (shouldForceToolChoice && this.shouldFallbackForForcedToolChoiceError(error)) {
              shouldForceToolChoice = false;
              delete createParams.tool_choice;
              this.logStreamDiagnostic(
                `[${this.name}] upstream rejected forced tool_choice; retrying without forced tool choice`,
              );
              continue;
            }
            if (
              !this.shouldFallbackForReasoningError(
                error,
                ...this.getFallbackTerms(capability),
              )
            ) {
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

      const choice = response.choices[0];
      const message = choice?.message;
      const textContent = extractOpenAIMessageText(message?.content);
      const reasoningContent = extractOpenAIMessageReasoning(message);
      const cleanStop = isCleanStop(choice?.finish_reason ?? undefined);
      const toolBlocks: KodaXToolUseBlock[] = (message?.tool_calls ?? [])
        .filter(isOpenAIFunctionToolCall)
        .map((toolCall) => {
          const parsed = parseToolInputWithSalvageTracked(toolCall.function.arguments);
          const salvageFlags = parsed.salvaged
            ? (cleanStop ? { _salvaged: true } : { _salvaged: true, _truncated: true })
            : {};
          return {
            type: 'tool_use' as const,
            id: toolCall.id,
            name: toolCall.function.name,
            input: parsed.value,
            ...salvageFlags,
          };
        });

      if (textContent) {
        streamOptions?.onTextDelta?.(textContent);
      }

      const textBlocks: KodaXTextBlock[] = textContent ? [{ type: 'text', text: textContent }] : [];
      const thinkingBlocks: (KodaXThinkingBlock | KodaXRedactedThinkingBlock)[] = [];
      if (reasoningContent) {
        thinkingBlocks.push({ type: 'thinking', thinking: reasoningContent });
        streamOptions?.onThinkingDelta?.(reasoningContent);
        streamOptions?.onThinkingEnd?.(reasoningContent);
      }

      return {
        textBlocks,
        toolBlocks,
        thinkingBlocks,
        usage: normalizeOpenAIUsage(response.usage as OpenAIUsageLike),
        stopReason: choice?.finish_reason ?? undefined,
      };
    }, signal, 3, streamOptions?.onRateLimit, streamOptions?.onRetryAfter, {
      model: streamOptions?.modelOverride ?? this.config.model,
      onRejected: streamOptions?.onReasoningEffortRejected,
    });
  }

  private extractReasoningDelta(
    delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta | undefined,
  ): string {
    const raw = (delta as Record<string, unknown> | undefined)?.reasoning_content;
    if (typeof raw === 'string') {
      return raw;
    }
    if (!Array.isArray(raw)) {
      return '';
    }

    return raw
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (
          typeof part === 'object' &&
          part !== null &&
          'text' in part &&
          typeof (part as { text?: unknown }).text === 'string'
        ) {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('');
  }

  private serializeAssistantMessage(
    contentBlocks: KodaXContentBlock[],
    model?: string,
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const text = contentBlocks
      .filter((block): block is KodaXTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const toolCalls = contentBlocks
      .filter((block): block is KodaXToolUseBlock => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        type: 'function' as const,
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      }));
    const thinking = contentBlocks
      .filter(
        (
          block,
        ): block is KodaXThinkingBlock | KodaXRedactedThinkingBlock =>
          block.type === 'thinking' || block.type === 'redacted_thinking',
      )
      .map((block) => block.type === 'thinking' ? block.thinking : '')
      .filter(Boolean)
      .join('\n\n');

    // Track presence (not just non-empty thinking string) so that turns
    // carrying only a redacted_thinking block also survive — they have no
    // serializable content but must still occupy an assistant slot to keep
    // user/assistant alternation valid for cross-provider history replay.
    const hasAnyThinking = contentBlocks.some(
      (block) => block.type === 'thinking' || block.type === 'redacted_thinking',
    );

    // An empty-text marker (`{ type: 'text', text: '' }`) is the honest
    // in-history representation of a turn that produced no visible content
    // (hidden-tool-only turn, sanitized thinking-only turn). It must NOT be
    // dropped: returning [] erases the assistant slot and can leave
    // user,user adjacency that some gateways reject. "Has a text block (even
    // empty)" means the turn must occupy a slot and falls through to the
    // wire-only '...' fallback below — mirroring the Anthropic empty guard.
    const hasTextBlock = contentBlocks.some((block) => block.type === 'text');

    // Only a GENUINELY empty turn (no text block at all, no tools, no
    // thinking) is dropped. Thinking-only and empty-text-marker turns survive
    // — dropping them breaks user/assistant alternation and erases
    // reasoning_content the next replay needs.
    if (!text && toolCalls.length === 0 && !hasAnyThinking && !hasTextBlock) {
      return [];
    }

    // text → send text; tool-only → null (per OpenAI spec); thinking-only,
    // redacted-only, or empty-text-marker → '...' placeholder so gateways
    // don't reject null/empty content without tool_calls. The placeholder is
    // wire-only, never written back into KodaX history. The actual thinking,
    // if any, rides on reasoning_content below (redacted blocks contribute
    // none).
    let content: string | null;
    if (text) {
      content = text;
    } else if (toolCalls.length > 0) {
      content = null;
    } else {
      content = '...';
    }

    const message: Record<string, unknown> = {
      role: 'assistant',
      content,
    };

    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    // DeepSeek V4 rejects replay turns that drop reasoning_content (400
    // "must be passed back to the API"). The strict reading of that
    // contract is *every* assistant turn in a thinking-mode request must
    // carry the field — including turns that produced no thinking
    // content (short text replies, follow-up tool turns, redacted-only
    // turns, pre-thinking history, cross-provider history before a
    // /model switch). Conditioning the attach on `thinking` being
    // non-empty was the original gap: it covered "history has thinking
    // → echo it" but missed "history has no thinking → still need the
    // field present". Always attach when the flag is set; default to
    // empty string when no thinking text is available, so any provider
    // opting into the flag (Qwen/Zhipu/Kimi/MiniMax all share the same
    // field convention) gets the same "field-present" invariant.
    if (this.getEffectiveReplayReasoningContent(model)) {
      message.reasoning_content = thinking || '';
    }

    return [message as unknown as OpenAI.Chat.ChatCompletionMessageParam];
  }

  private async serializeUserMessage(
    contentBlocks: KodaXContentBlock[],
  ): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
    const results: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    const text = contentBlocks
      .filter((block): block is KodaXTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const imageBlocks = contentBlocks.filter(
      (block): block is Extract<KodaXContentBlock, { type: 'image' }> => block.type === 'image',
    );

    for (const block of contentBlocks) {
      if (block.type === 'tool_result') {
        // OpenAI Chat Completions tool messages take `content: string` and
        // do not accept image blocks inline. When the tool_result content
        // is the array form (e.g. `read` on an image path), downgrade:
        // emit text items as-is and replace image items with a textual
        // path-free placeholder. This preserves the tool-result
        // contract for OpenAI-compat gateways whose tool-message wire
        // format is text-only (DeepSeek, Zhipu, MiniMax, etc. — applies
        // even to vision-capable models) without rejecting the request.
        let toolContent: string;
        if (typeof block.content === 'string') {
          toolContent = block.content;
        } else {
          const loweredItems: string[] = [];
          for (const item of block.content) {
            if (item.type === 'text') {
              loweredItems.push(item.text);
              continue;
            }
            loweredItems.push(
              (await isImageFileMissing(item.path))
                ? MISSING_IMAGE_PLACEHOLDER
                : UNSUPPORTED_TOOL_RESULT_IMAGE_PLACEHOLDER,
            );
          }
          toolContent = loweredItems.join('\n');
        }
        results.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: toolContent,
        } as unknown as OpenAI.Chat.ChatCompletionMessageParam);
      }
    }

    if (imageBlocks.length === 0) {
      if (text) {
        results.push({
          role: 'user',
          content: text,
        });
      }
      return results;
    }

    const content: Array<Record<string, unknown>> = [];
    if (text) {
      content.push({
        type: 'text',
        text,
      });
    }
    for (const block of imageBlocks) {
      const dataUrl = await buildImageDataUrlIfAvailable(
        block.path,
        block.mediaType,
      );
      if (dataUrl === undefined) {
        content.push({
          type: 'text',
          text: MISSING_IMAGE_PLACEHOLDER,
        });
      } else {
        content.push({
          type: 'image_url',
          image_url: {
            url: dataUrl,
          },
        });
      }
    }

    results.push({
      role: 'user',
      content,
    } as unknown as OpenAI.Chat.ChatCompletionMessageParam);

    return results;
  }

  private serializeSystemMessage(
    content: string | KodaXContentBlock[],
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    if (typeof content === 'string') {
      return [{
        role: 'system',
        content,
      } as unknown as OpenAI.Chat.ChatCompletionMessageParam];
    }

    const text = content
      .filter((block): block is KodaXTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    return text
      ? [{
          role: 'system',
          content: text,
        } as unknown as OpenAI.Chat.ChatCompletionMessageParam]
      : [];
  }

  private async convertMessages(
    messages: KodaXMessage[],
    model?: string,
  ): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
    const converted: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    for (const message of messages) {
      if (message.role === 'system') {
        converted.push(...this.serializeSystemMessage(message.content));
        continue;
      }

      if (typeof message.content === 'string') {
        converted.push({
          role: message.role,
          content: message.content,
        } as unknown as OpenAI.Chat.ChatCompletionMessageParam);
        continue;
      }

      if (message.role === 'assistant') {
        converted.push(...this.serializeAssistantMessage(message.content, model));
        continue;
      }

      converted.push(...await this.serializeUserMessage(message.content));
    }

    return this.repairToolCallHistory(converted);
  }

  private repairToolCallHistory(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const repaired: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    let index = 0;

    while (index < messages.length) {
      const message = messages[index]!;
      const toolCalls = getAssistantWireToolCalls(message);

      if (toolCalls === undefined) {
        if (getWireRole(message) !== 'tool') {
          repaired.push(message);
        }
        index += 1;
        continue;
      }

      const expectedIds = new Set(toolCalls.map((toolCall) => toolCall.id));
      const seenIds = new Set<string>();
      const matchedToolMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
      let nextIndex = index + 1;

      while (nextIndex < messages.length && getWireRole(messages[nextIndex]!) === 'tool') {
        const toolMessage = messages[nextIndex]!;
        const toolCallId = getToolWireCallId(toolMessage);
        if (
          toolCallId !== undefined &&
          expectedIds.has(toolCallId) &&
          !seenIds.has(toolCallId)
        ) {
          seenIds.add(toolCallId);
          matchedToolMessages.push(toolMessage);
        }
        nextIndex += 1;
      }

      const matchedToolCalls = toolCalls.filter((toolCall) => seenIds.has(toolCall.id));
      const assistantMessage = matchedToolCalls.length === toolCalls.length && toolCalls.length > 0
        ? message
        : rewriteAssistantWireToolCalls(message, matchedToolCalls);

      repaired.push(assistantMessage);
      if (matchedToolCalls.length > 0) {
        repaired.push(...matchedToolMessages);
      }
      index = nextIndex;
    }

    return repaired;
  }
}
