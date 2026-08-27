/**
 * KodaX Base Provider
 *
 * Provider 抽象基类 - 所有 Provider 的公共基础
 */

import {
  KodaXProviderConfig,
  KodaXModelDescriptor,
  KodaXMessage,
  KodaXToolDefinition,
  KodaXProviderStreamOptions,
  KodaXProviderCapabilityProfile,
  KodaXNormalizedReasoningRequest,
  KodaXReasoningCapability,
  KodaXReasoningProfile,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXVerifyCredentialResult,
  KodaXWireReasoningEffort,
} from '../types.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { KodaXError, KodaXRateLimitError, KodaXProviderError, KodaXReasoningEffortRejectedError } from '../errors.js';
import type { KodaXProviderErrorMetadata } from '../errors.js';
import { classifyReasoningEffortRejection } from './reasoning-effort-rejection.js';
import { resolveProviderCredential } from '../provider-credential-context.js';

/**
 * Passive-learning guard threaded into `withRateLimit`: when the request fails
 * with a reasoning-effort rejection, fire `onRejected` (so the REPL records it)
 * and surface a typed error. `effort` is the value that was on the wire (used
 * when the provider error doesn't echo a value).
 */
export interface ReasoningRejectionGuard {
  readonly model: string;
  readonly effort?: string;
  readonly onRejected?: (event: { provider: string; model: string; effort: string }) => void;
}

/** Retry-only state owned by one provider request, never by the provider singleton. */
export interface ProviderRequestRetryState {
  maxOutputTokensOverride?: number;
  /** Effective cap of the original request; overflow recovery may only lower it. */
  maxOutputTokensLimit?: number;
  suppressReasoningEffort: boolean;
}
import { parseRetryAfter, extractHeadersFromError } from '../retry/retry-after.js';
import type { RetryAfterSource } from '../retry/retry-after.js';
import { KODAX_MAX_TOKENS } from '../constants.js';
import { getRunScopedConfig } from '../run-scoped-config.js';
import {
  cloneCapabilityProfile,
  NATIVE_PROVIDER_CAPABILITY_PROFILE,
} from './capability-profile.js';
import {
  KODAX_STABLE_EFFORT_INTENTS,
  getReasoningCapability,
  normalizeReasoningRequest,
  resolveReasoningEffort,
} from '../reasoning.js';

function parseEnvInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

interface ResolvedV2ReasoningIntent {
  readonly disabled: boolean;
  readonly effort?: KodaXWireReasoningEffort;
  readonly requestedEffort?: KodaXWireReasoningEffort;
}

function shouldLowerAutoReasoningEffort(
  capability: KodaXReasoningProfile,
): boolean {
  switch (capability.reasoningPreset) {
    case 'zai-glm-5.3':
    case 'zai-glm-5.2':
    case 'deepseek-v4-flash-openai':
    case 'deepseek-v4-pro-openai':
    case 'deepseek-v4-openai':
    case 'deepseek-v4-anthropic':
    case 'qwen-hybrid-thinking':
      return true;
    default:
      break;
  }
  return capability.effortStrategy === 'provider-budget';
}

function abortError(): DOMException {
  return new DOMException('Request aborted', 'AbortError');
}

async function isProviderSdkAbortError(error: Error): Promise<boolean> {
  const [anthropic, openai] = await Promise.allSettled([
    import('@anthropic-ai/sdk'),
    import('openai'),
  ]);
  return (
    (anthropic.status === 'fulfilled'
      && error instanceof anthropic.value.APIUserAbortError)
    || (openai.status === 'fulfilled'
      && error instanceof openai.value.APIUserAbortError)
  );
}

function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (timeout) clearTimeout(timeout);
      cleanup();
      reject(abortError());
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
  });
}

function normalizeHttpStatus(value: unknown): number | undefined {
  const status = typeof value === 'number' && Number.isInteger(value)
    ? value
    : typeof value === 'string' && /^\d{3}$/.test(value)
      ? Number(value)
      : undefined;
  return status !== undefined && status >= 100 && status <= 599
    ? status
    : undefined;
}

function extractHttpStatus(error: unknown, depth = 0): number | undefined {
  if (!error || typeof error !== 'object' || depth > 4) {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  return normalizeHttpStatus(record.status)
    ?? normalizeHttpStatus(record.statusCode)
    ?? normalizeHttpStatus(record.code)
    ?? extractHttpStatus(record.cause, depth + 1);
}

function extractErrorCode(error: unknown, depth = 0): string {
  if (!error || typeof error !== 'object' || depth > 4) {
    return '';
  }
  const record = error as Record<string, unknown>;
  if (typeof record.code === 'string') {
    return record.code;
  }
  return extractErrorCode(record.cause, depth + 1);
}

function extractDiagnosticString(
  error: unknown,
  fields: readonly string[],
  depth = 0,
): string | undefined {
  if (!error || typeof error !== 'object' || depth > 4) return undefined;
  const record = error as Record<string, unknown>;
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value)) return value;
  }
  return extractDiagnosticString(record.cause, fields, depth + 1);
}

function extractRequestId(error: unknown): string | undefined {
  const direct = extractDiagnosticString(error, ['requestId', 'request_id']);
  if (direct !== undefined) return direct;
  const headers = extractHeadersFromError(error);
  const names = ['x-request-id', 'request-id', 'anthropic-request-id', 'cf-ray'];
  for (const name of names) {
    const value = headers instanceof Headers
      ? headers.get(name) ?? undefined
      : headers?.[name] ?? headers?.[name.replace(/\b\w/g, (char) => char.toUpperCase())];
    const candidate = Array.isArray(value) ? value[0] : value;
    if (typeof candidate === 'string' && /^[\w.:-]{1,200}$/.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.toLowerCase();
  }
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string') {
      return message.toLowerCase();
    }
  }
  return String(error).toLowerCase();
}

/**
 * FEATURE_130 (v0.7.36): structured payload fired through
 * `KodaXEvents.onRetryAfter` whenever a provider's `withRateLimit`
 * loop catches a 429 / 503 / 529 response and decides to wait. The
 * `source` field carries which retry-after header form (or fallback)
 * produced the wait duration so UI surfaces can show "provider asked
 * us to wait 45s" vs "no header, exp-backoff guess of 4s".
 */
export interface KodaXRetryAfterEvent {
  readonly provider: string;
  readonly waitMs: number;
  readonly reason: 'rate-limit' | 'overloaded';
  readonly source: RetryAfterSource;
  readonly attempt: number;
  readonly maxAttempts: number;
}

export type KodaXOnRetryAfterCallback = (event: KodaXRetryAfterEvent) => void;

export abstract class KodaXBaseProvider {
  abstract readonly name: string;
  abstract readonly supportsThinking: boolean;
  protected abstract readonly config: KodaXProviderConfig;
  private readonly activeLegacyRequestOverride = new AsyncLocalStorage<{
    readonly maxOutputTokensOverride?: number;
  }>();
  private pendingLegacyMaxOutputTokensOverride?: number;

  /**
   * @deprecated Pass `streamOptions.maxOutputTokensOverride` to `stream()` or
   * `complete()`. The setter remains a one-shot compatibility shim; concurrent
   * callers must use the request option. Once admitted, the request value is
   * async-context-local and cannot leak into sibling requests.
   */
  public setMaxOutputTokensOverride(value: number | undefined): void {
    this.pendingLegacyMaxOutputTokensOverride = value;
  }

  /**
   * Returns the max_tokens value the provider will currently use on its
   * next request. Precedence (highest to lowest):
   *   1. Deprecated one-shot override (compatibility only)
   *   2. Run-scoped config / `KODAX_MAX_OUTPUT_TOKENS` (explicit user intent)
   *   3. Active model descriptor's `maxOutputTokens` (FEATURE_098)
   *   4. Provider config default
   *   5. Global `KODAX_MAX_TOKENS` fallback
   * Used by provider stream() paths and by the agent loop to decide
   * whether escalation is applicable (see `coding/src/agent.ts`).
   */
  public getEffectiveMaxOutputTokens(model?: string): number {
    // Run-scoped (concurrency-safe) first, then the global env fallback. Apply
    // the same positive-integer guard `parseEnvInt` uses to the ALS value: an
    // SDK caller passing 0/-1/NaN must NOT reach `max_tokens` verbatim (the
    // provider API rejects it with a 400) — treat a bad value as "unset" so the
    // env / descriptor / default chain still resolves.
    const legacyMax = this.activeLegacyRequestOverride.getStore()
      ?.maxOutputTokensOverride
      ?? this.pendingLegacyMaxOutputTokensOverride;
    if (
      typeof legacyMax === 'number'
      && Number.isFinite(legacyMax)
      && legacyMax > 0
    ) {
      return legacyMax;
    }
    const scopedMax = getRunScopedConfig()?.maxOutputTokens;
    const envOverride = (typeof scopedMax === 'number' && Number.isFinite(scopedMax) && scopedMax > 0
      ? scopedMax
      : undefined)
      ?? parseEnvInt(process.env.KODAX_MAX_OUTPUT_TOKENS);
    if (envOverride !== undefined) {
      return envOverride;
    }
    const descriptorMax = this.getModelDescriptor(model)?.maxOutputTokens;
    if (descriptorMax !== undefined) {
      return descriptorMax;
    }
    return this.config.maxOutputTokens ?? KODAX_MAX_TOKENS;
  }

  /**
   * Hard cap on a single streaming request's wall-clock duration (ms).
   * Returns undefined when no cap is configured. Consumed by the
   * resilience layer to abort a doomed stream before the server-side
   * kill window fires; routed through `non_streaming_fallback`.
   *
   * Cascade (highest to lowest):
   *   1. Active model descriptor's `streamMaxDurationMs`
   *   2. Provider config default
   *   3. undefined (watchdog disabled)
   */
  public getStreamMaxDurationMs(model?: string): number | undefined {
    const descriptorValue = this.getModelDescriptor(model)?.streamMaxDurationMs;
    if (descriptorValue !== undefined) {
      return descriptorValue;
    }
    return this.config.streamMaxDurationMs;
  }

  /**
   * Resolves whether OpenAI-compat `reasoning_content` should echo back
   * on replayed assistant messages for the given model. Same cascade as
   * `getStreamMaxDurationMs`. Defaults to false when neither layer sets it.
   */
  public getEffectiveReplayReasoningContent(model?: string): boolean {
    const descriptorValue = this.getModelDescriptor(model)?.replayReasoningContent;
    if (descriptorValue !== undefined) {
      return descriptorValue;
    }
    return this.config.replayReasoningContent ?? false;
  }

  /**
   * Resolves whether Anthropic-style thinking signatures must verify
   * strictly (Anthropic proper only). Same cascade as
   * `getStreamMaxDurationMs`. Defaults to false (lenient) when neither
   * layer sets it — matches third-party Anthropic-compat behavior.
   */
  public getEffectiveStrictThinkingSignature(model?: string): boolean {
    const descriptorValue = this.getModelDescriptor(model)?.strictThinkingSignature;
    if (descriptorValue !== undefined) {
      return descriptorValue;
    }
    return this.config.strictThinkingSignature ?? false;
  }

  /** Provider-level switch used by serializers for compatibility placeholders. */
  public getProviderSupportsThinking(): boolean {
    return this.config.supportsThinking;
  }

  protected getEffectiveThinkingBudgetCap(model?: string): number | undefined {
    return this.getModelDescriptor(model)?.thinkingBudgetCap ?? this.config.thinkingBudgetCap;
  }

  abstract stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    signal?: AbortSignal
  ): Promise<KodaXStreamResult>;

  /**
   * Whether this Provider lowers `streamOptions.ephemeralSuffix` onto the wire.
   * Runtime-registered Providers default to false so callers can fall back to a
   * request-only message copy instead of silently dropping managed context.
   */
  supportsEphemeralSuffix(): boolean {
    return false;
  }

  /** Whether this configured transport lowers `promptCacheKey` onto its wire. */
  usesPromptCacheAffinity(): boolean {
    return this.config.promptCacheAffinity === true;
  }

  supportsNonStreamingFallback(): boolean {
    return false;
  }

  async complete(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    _streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    throw new KodaXProviderError(
      `${this.name} does not support non-streaming fallback`,
      this.name,
      { failureCode: 'protocol_mismatch', stage: 'response_stream' },
    );
  }

  isConfigured(): boolean {
    return resolveProviderCredential(
      this.name,
      process.env[this.config.apiKeyEnv],
    ) !== undefined;
  }

  /**
   * FEATURE_216 v0.7.45 — Lightweight credential verification. Returns
   * a never-throws envelope with `ok` + categorized `error`. Concrete
   * compat base classes (`KodaXAnthropicCompatProvider`,
   * `KodaXOpenAICompatProvider`) override this to dispatch by the
   * `verifyStrategy` field. The default here returns `unsupported` so
   * Provider classes that don't extend a compat base — or future ones
   * yet to be wired — fail safely instead of throwing.
   *
   * Distinct from `isConfigured()`: that one is env-only (no network);
   * this one hits the wire (zero or ~7 tokens depending on strategy)
   * and verifies the key is actually accepted by the upstream.
   */
  async verifyCredential(_opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<KodaXVerifyCredentialResult> {
    return {
      ok: false,
      error: 'unsupported',
      strategy: this.config.verifyStrategy ?? 'unsupported',
      durationMs: 0,
      approxTokensSpent: 0,
      message: `Provider class "${this.name}" does not implement verifyCredential()`,
    };
  }

  getModel(): string {
    return this.config.model;
  }

  getAvailableModels(): string[] {
    if (!this.config.models?.length) return [this.config.model];
    return [...new Set([this.config.model, ...this.config.models.map(m => m.id)])];
  }

  getModelDescriptor(modelId?: string): KodaXModelDescriptor | undefined {
    // Resolve undefined to the provider's default model so "the active
    // model" asks resolve to the same descriptor as an explicit id.
    const id = modelId ?? this.config.model;
    // Prefer the full descriptor from `models[]` when present — it carries
    // per-model contextWindow / maxOutputTokens / reasoning fields. This
    // applies EVEN when `id` is the default model: previously the default
    // model short-circuited to a bare `{ id }`, dropping any per-model
    // fields declared for it in `models[]`. That made
    // `getEffectiveContextWindow(defaultModel)` fall back to the
    // provider-level window even when `models[]` declared a larger one —
    // e.g. a custom provider whose default model is GLM-5.2 (1M ctx)
    // silently resolved to the 200K provider default and fired compaction
    // ~5x early.
    const fromList = this.config.models?.find(m => m.id === id);
    if (fromList) {
      const wireDescriptor = fromList.wireModel
        ? this.config.models?.find(m => m.id === fromList.wireModel)
        : undefined;
      return wireDescriptor
        ? { ...wireDescriptor, ...fromList }
        : fromList;
    }
    // No per-model descriptor — return a bare default-model marker so the
    // getEffective* cascade drops to the provider-level config; unknown
    // non-default ids resolve to undefined (same as before).
    if (id === this.config.model) return { id: this.config.model };
    return undefined;
  }

  protected getWireModelId(modelId?: string): string {
    const id = modelId ?? this.config.model;
    return this.getModelDescriptor(id)?.wireModel ?? id;
  }

  /** Exact model identifier serialized into native provider requests. */
  getWireModel(modelId?: string): string {
    return this.getWireModelId(modelId);
  }

  getBaseUrl(): string | undefined {
    return this.config.baseUrl;
  }

  getApiKeyEnv(): string {
    return this.config.apiKeyEnv;
  }

  getCapabilityProfile(): KodaXProviderCapabilityProfile {
    return cloneCapabilityProfile(
      this.config.capabilityProfile ?? NATIVE_PROVIDER_CAPABILITY_PROFILE,
    );
  }

  getConfiguredReasoningCapability(modelOverride?: string): KodaXReasoningCapability {
    const descriptor = this.getModelDescriptor(modelOverride);
    if (descriptor?.reasoningCapability) {
      return descriptor.reasoningCapability;
    }
    return getReasoningCapability(this.config);
  }

  getReasoningCapability(modelOverride?: string): KodaXReasoningCapability {
    // Reasoning single-tracking (ADR-042): the disk-persisted
    // `providerReasoningOverrides` capability self-heal was retired (it was a
    // no-op once every provider carries a `reasoningProfile`, and real
    // effort rejections are now handled by the effort-drop self-heal in
    // `withRateLimit`). This is now a pure capability descriptor read.
    return this.getConfiguredReasoningCapability(modelOverride);
  }

  getReasoningProfile(modelOverride?: string): KodaXReasoningProfile | undefined {
    return this.getModelDescriptor(modelOverride)?.reasoningProfile
      ?? this.config.reasoningProfile;
  }

  protected shouldFallbackForReasoningError(
    error: unknown,
    ...terms: string[]
  ): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    const normalizedTerms = terms.map(term => term.toLowerCase());
    const matchesSpecificTerm = normalizedTerms.some((term) => message.includes(term));
    const mentionsParameter =
      message.includes('parameter') ||
      matchesSpecificTerm;

    return (
      message.includes('unknown parameter') ||
      message.includes('invalid parameter') ||
      (message.includes('unsupported') && mentionsParameter)
    );
  }

  protected shouldFallbackForSpecificReasoningError(
    error: unknown,
    ...terms: string[]
  ): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    const normalizedTerms = terms.map(term => term.toLowerCase());
    const matchesSpecificTerm = normalizedTerms.some((term) => message.includes(term));

    if (!matchesSpecificTerm) {
      return false;
    }

    return (
      message.includes('unknown parameter') ||
      message.includes('invalid parameter') ||
      message.includes('unsupported')
    );
  }

  protected shouldFallbackForForcedToolChoiceError(error: unknown): boolean {
    const message = getErrorMessage(error);
    const mentionsToolChoice =
      message.includes('tool_choice') ||
      message.includes('tool choice') ||
      message.includes('toolchoice');
    const explicitToolChoiceRejection = mentionsToolChoice && (
      message.includes('unknown parameter') ||
      message.includes('invalid parameter') ||
      message.includes('unsupported') ||
      message.includes('incompatible')
    );
    if (explicitToolChoiceRejection) {
      return true;
    }

    return this.isServerError(error);
  }

  protected isServerError(error: unknown): boolean {
    const status = extractHttpStatus(error);
    if (status !== undefined && status >= 500 && status <= 599) {
      return true;
    }

    const message = getErrorMessage(error);
    return (
      message.includes('internal server error') ||
      message.includes('server error')
    );
  }

  protected getReasoningFallbackChain(
    capability: KodaXReasoningCapability,
  ): KodaXReasoningCapability[] {
    switch (capability) {
      case 'native-budget':
        return ['native-budget', 'native-toggle', 'none'];
      case 'native-effort':
        return ['native-effort', 'none'];
      case 'native-adaptive':
        // Adaptive is the only on-mode for Opus 4.7+; budget/toggle both
        // 400. Fall straight to no-thinking rather than retrying a shape
        // the model already rejects.
        return ['native-adaptive', 'none'];
      case 'native-toggle':
        return ['native-toggle', 'none'];
      case 'none':
      case 'prompt-only':
      case 'unknown':
      default:
        return ['none'];
    }
  }

  /**
   * 获取模型的上下文窗口大小
   *
   * Backwards-compatible no-arg form: resolves against the provider's
   * default model descriptor. New call sites that know the active
   * model should use `getEffectiveContextWindow(model)` directly.
   * @returns 上下文窗口大小 (tokens)
   */
  getContextWindow(): number {
    return this.getEffectiveContextWindow();
  }

  /**
   * Resolves the context window for a specific model.
   * Precedence (highest to lowest):
   *   1. Active model descriptor's `contextWindow` (FEATURE_098)
   *   2. Provider config default
   *   3. 200_000 fallback
   * The user-level `compaction.contextWindow` is layered on top of
   * this at the call site, so it remains the highest-priority manual
   * override.
   */
  getEffectiveContextWindow(model?: string): number {
    const descriptorWindow = this.getModelDescriptor(model)?.contextWindow;
    if (descriptorWindow !== undefined) {
      return descriptorWindow;
    }
    return this.config.contextWindow ?? 200_000;
  }

  protected getApiKey(): string {
    const key = resolveProviderCredential(this.name, process.env[this.config.apiKeyEnv]);
    if (!key) throw new Error(`${this.config.apiKeyEnv} not set`);
    return key;
  }

  protected shouldLogStreamDiagnostics(): boolean {
    return Boolean(process.env.KODAX_DEBUG_STREAM);
  }

  protected logStreamDiagnostic(...args: unknown[]): void {
    if (this.shouldLogStreamDiagnostics()) {
      console.error(...args);
    }
  }

  protected normalizeReasoning(
    reasoning?: boolean | KodaXReasoningRequest,
  ): KodaXNormalizedReasoningRequest {
    return normalizeReasoningRequest(reasoning);
  }

  protected validateExplicitReasoningEffort(
    reasoning: KodaXNormalizedReasoningRequest,
    modelOverride?: string,
  ): void {
    if (reasoning.effortSource !== 'explicit') {
      return;
    }
    const effort = reasoning.effort;
    if (!effort || effort === 'auto') {
      return;
    }

    const isStableIntent = KODAX_STABLE_EFFORT_INTENTS.includes(
      effort as (typeof KODAX_STABLE_EFFORT_INTENTS)[number],
    );
    const capability = this.getReasoningProfile(modelOverride);
    if (!capability) {
      if (effort === 'none') {
        return;
      }
      if (isStableIntent) {
        return;
      }
      const modelLabel = modelOverride ? `/${modelOverride}` : '';
      throw new KodaXProviderError(
        `${this.name}${modelLabel} does not advertise provider-specific reasoning effort "${effort}". Supported stable efforts: ${KODAX_STABLE_EFFORT_INTENTS.join(', ')}.`,
        this.name,
        { failureCode: 'request_build_failed', stage: 'request_build' },
      );
    }
    if (capability.localRejectEfforts?.includes(effort)) {
      const modelLabel = modelOverride ? `/${modelOverride}` : '';
      throw new KodaXProviderError(
        `${this.name}${modelLabel} does not support reasoning effort "${effort}".`,
        this.name,
        { failureCode: 'request_build_failed', stage: 'request_build' },
      );
    }
    if (effort === 'none' || capability.disabledEfforts?.includes(effort)) {
      return;
    }
    if (capability.allowCustomEffort) {
      return;
    }
    const supported = capability.supportedEfforts?.map((preset) => preset.value) ?? [];
    const aliasedEffort = capability.effortAliases?.[effort] ?? effort;
    if (
      supported.includes(effort) ||
      supported.includes(aliasedEffort) ||
      (supported.length === 0 && isStableIntent)
    ) {
      return;
    }

    const modelLabel = modelOverride ? `/${modelOverride}` : '';
    const supportedLabel = supported.length > 0
      ? supported.join(', ')
      : KODAX_STABLE_EFFORT_INTENTS.join(', ');
    throw new KodaXProviderError(
      `${this.name}${modelLabel} does not support reasoning effort "${effort}". Supported efforts: ${supportedLabel}.`,
      this.name,
      { failureCode: 'request_build_failed', stage: 'request_build' },
    );
  }

  protected resolveReasoningProfileIntent(
    reasoning: KodaXNormalizedReasoningRequest,
    capability: KodaXReasoningProfile,
    modelOverride?: string,
  ): ResolvedV2ReasoningIntent {
    const requestedEffort = reasoning.effort;
    if (requestedEffort && capability.localRejectEfforts?.includes(requestedEffort)) {
      // Hard-reject ONLY an explicit caller request for an effort this model
      // cannot do (e.g. asking to disable thinking on an always-on model like
      // kimi-k2.7-code / minimax-m2-always). Mirrors the explicit-only policy
      // in `validateExplicitReasoningEffort`. An IMPLICIT/default 'none' —
      // produced by `normalizeReasoningRequest(undefined)` when the caller
      // passes no reasoning at all (effortSource 'omitted'/non-explicit) — must
      // NOT crash the request: an always-on model simply falls back to its
      // `defaultEffort` and thinks. Without this, every caller that omits
      // reasoning (e.g. the eval harness) throws against these models.
      if (reasoning.effortSource === 'explicit') {
        const modelLabel = modelOverride ? `/${modelOverride}` : '';
        throw new KodaXProviderError(
          `${this.name}${modelLabel} does not support reasoning effort "${requestedEffort}".`,
          this.name,
          { failureCode: 'request_build_failed', stage: 'request_build' },
        );
      }
      if (capability.defaultEffort) {
        return {
          disabled: false,
          effort: capability.defaultEffort,
          requestedEffort,
        };
      }
    }

    if (
      !reasoning.enabled ||
      requestedEffort === 'none' ||
      (requestedEffort !== undefined && capability.disabledEfforts?.includes(requestedEffort))
    ) {
      return { disabled: true, requestedEffort };
    }

    if (!requestedEffort || requestedEffort === 'auto') {
      if (shouldLowerAutoReasoningEffort(capability)) {
        const resolved = resolveReasoningEffort({
          capability,
          explicitEffort: requestedEffort ?? 'auto',
        }).effectiveEffort;
        if (
          resolved === 'none' ||
          (resolved !== undefined && capability.disabledEfforts?.includes(resolved))
        ) {
          return {
            disabled: true,
            effort: resolved,
            requestedEffort,
          };
        }
        return {
          disabled: false,
          effort: resolved,
          requestedEffort,
        };
      }
      return { disabled: false, requestedEffort };
    }

    return {
      disabled: false,
      effort: capability.effortAliases?.[requestedEffort] ?? requestedEffort,
      requestedEffort,
    };
  }

  /**
   * Called when ECONNRESET/EPIPE is detected, indicating a stale keep-alive
   * socket.  Subclasses should override to rebuild their HTTP client with a
   * fresh connection pool so the next retry uses a new TCP connection.
   */
  protected onStaleConnection(): void {
    // Base implementation is a no-op; subclasses override when they hold
    // a pooled HTTP client (e.g. Anthropic SDK, OpenAI SDK).
  }

  protected isRateLimitError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const s = error.message.toLowerCase();
    // FEATURE_130 (v0.7.36): include 'overload' / '503' / '529' keywords so
    // server-overloaded responses also enter the retry path. Overload is
    // labeled as `reason="overloaded"` by classifyRateLimitReason — both
    // conditions flow through the same withRateLimit loop.
    return [
      'rate', 'limit', '速率', '频率', '1302', '429', 'too many',
      'overload', 'overwhelmed', '503', '529', 'busy',
    ].some(k => s.includes(k));
  }

  /**
   * FEATURE_130: classify a rate-limit error as either a 429-style
   * "rate-limit" or a 503/529-style "overloaded" condition. The
   * distinction matters for UI: "rate-limit" usually surfaces a
   * provider-supplied retry-after window; "overloaded" tends to fall
   * through to exponential backoff with no header. Both flow through
   * the same retry path; this only labels the event.
   */
  protected classifyRateLimitReason(error: unknown): 'rate-limit' | 'overloaded' {
    const s = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (
      s.includes('overload')
      || s.includes('overwhelmed')
      || s.includes('503')
      || s.includes('529')
      || s.includes('busy')
    ) {
      return 'overloaded';
    }
    return 'rate-limit';
  }

  /**
   * Extract Retry-After delay from error headers (429/529 responses).
   * Returns milliseconds, or undefined when no usable header is present.
   *
   * FEATURE_130 (v0.7.36): now delegates to the shared `parseRetryAfter`
   * helper so all built-in provider adapters get 4-form coverage without each
   * adapter rolling its own parser. The 4 forms supported are:
   *   - `Retry-After: <integer-seconds>`
   *   - `Retry-After: <HTTP-date>`
   *   - `retry-after-ms: <milliseconds>` (Anthropic extension)
   *   - exponential-backoff fallback (returned via `withRateLimit`,
   *     not through this helper — it is `undefined` here when no
   *     header is present, which the caller then resolves to backoff)
   */
  protected extractRetryAfterMs(error: unknown): number | undefined {
    const headers = extractHeadersFromError(error);
    if (!headers) return undefined;
    // Use a fixed attempt of 0 so the helper only returns a header
    // result; the backoff path is composed by the caller below.
    const result = parseRetryAfter(headers, { attempt: 0, withJitter: false });
    return result.type === 'header' ? result.waitMs : undefined;
  }

  private providerErrorMetadata(error: unknown): KodaXProviderErrorMetadata {
    const httpStatus = extractHttpStatus(error);
    const upstreamCode = extractErrorCode(error);
    const requestId = extractRequestId(error);
    const retryAfterMs = this.extractRetryAfterMs(error);
    return {
      stage: 'transport',
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(upstreamCode !== '' && /^[\w.:-]{1,200}$/.test(upstreamCode)
        ? { upstreamCode }
        : {}),
      ...(requestId !== undefined ? { requestId } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }

  /**
   * Detect "prompt too long / context window exceeded" errors and compute
   * a reduced max_tokens for retry.  Returns undefined if not a context
   * overflow error.
   */
  protected parseContextOverflow(error: unknown): number | undefined {
    const msg = getErrorMessage(error);
    // Anthropic: "prompt is too long: 180000 tokens > 200000 maximum"
    // OpenAI:    "maximum context length is 128000 tokens. However, you requested 150000 tokens"
    // Zhipu/Kimi variants with Chinese messages
    const patterns: Array<{
      readonly regex: RegExp;
      readonly inputGroup: number;
      readonly limitGroup: number;
    }> = [
      {
        regex: /(\d[\d,]*)\s*tokens?.*?(\d[\d,]*)\s*(?:maximum|limit|context)/i,
        inputGroup: 1,
        limitGroup: 2,
      },
      {
        regex: /maximum.*?(\d[\d,]*)\s*tokens?.*?requested.*?(\d[\d,]*)/i,
        inputGroup: 2,
        limitGroup: 1,
      },
      {
        regex: /exceeds?\s+.*?(\d[\d,]*)\s*.*?(?:limit|max|context|上限).*?(\d[\d,]*)/i,
        inputGroup: 1,
        limitGroup: 2,
      },
    ];
    for (const pattern of patterns) {
      const m = msg.match(pattern.regex);
      if (m) {
        const inputTokens = Number(m[pattern.inputGroup]!.replace(/,/g, ''));
        const contextLimit = Number(m[pattern.limitGroup]!.replace(/,/g, ''));
        const safetyBuffer = 1000;
        const available = Math.max(3000, contextLimit - inputTokens - safetyBuffer);
        return available;
      }
    }
    return undefined;
  }

  protected isContextOverflowError(error: unknown): boolean {
    const msg = getErrorMessage(error);
    return msg.includes('prompt is too long')
      || msg.includes('prompt too long')
      || msg.includes('context length')
      || msg.includes('context_length_exceeded')
      || msg.includes('context window')
      || msg.includes('context limit')
      || msg.includes('上下文长度');
  }

  protected async withRateLimit<T>(
    fn: (retryState: ProviderRequestRetryState) => Promise<T>,
    signal?: AbortSignal,
    retries = 3,
    onRateLimit?: (attempt: number, maxRetries: number, delayMs: number) => void,
    onRetryAfter?: KodaXOnRetryAfterCallback,
    reasoningGuard?: ReasoningRejectionGuard,
  ): Promise<T> {
    let effortRetried = false;
    const legacyMaxOutputTokensOverride = this.pendingLegacyMaxOutputTokensOverride;
    this.pendingLegacyMaxOutputTokensOverride = undefined;
    const retryState: ProviderRequestRetryState = {
      ...(legacyMaxOutputTokensOverride === undefined
        ? {}
        : { maxOutputTokensOverride: legacyMaxOutputTokensOverride }),
      suppressReasoningEffort: false,
    };
    for (let i = 0; i < retries; i++) {
      try {
        return await this.activeLegacyRequestOverride.run(
          retryState.maxOutputTokensOverride === undefined
            ? {}
            : { maxOutputTokensOverride: retryState.maxOutputTokensOverride },
          () => fn(retryState),
        );
      } catch (e) {
        // Context window overflow: compute reduced max_tokens and retry once
        if (this.isContextOverflowError(e) && retryState.maxOutputTokensOverride === undefined) {
          const reduced = this.parseContextOverflow(e);
          const currentLimit = retryState.maxOutputTokensLimit;
          if (reduced && (currentLimit === undefined || reduced < currentLimit)) {
            retryState.maxOutputTokensOverride = reduced;
            onRateLimit?.(i + 1, retries, 0);
            continue; // Retry immediately with reduced max_tokens
          }
        }

        if (this.isRateLimitError(e)) {
          // Last retry exhausted — throw. Append the provider's own error detail
          // (quota code, reset time — e.g. GLM's [1308] 5-hour-window message) so
          // users see WHY they were limited instead of only generic guidance.
          if (i === retries - 1) {
            const detail = getErrorMessage(e).trim();
            const suffix = detail ? `\n${detail}` : '';
            const metadata = this.providerErrorMetadata(e);
            throw new KodaXRateLimitError(
              `API rate limit exceeded after ${retries} retries. Please wait and try again later.${suffix}`,
              metadata.retryAfterMs ?? 60000,
              metadata,
            );
          }

          // FEATURE_130 (v0.7.36): centralized retry-after parsing through
          // `parseRetryAfter` — covers `Retry-After: <seconds>` /
          // `Retry-After: <HTTP-date>` / `retry-after-ms: <ms>` /
          // exponential-backoff fallback. The legacy 500*2^i backoff was
          // identical to base=500ms in the helper, so the wait math is
          // unchanged when there is no header present.
          const headers = extractHeadersFromError(e) ?? {};
          const retryDecision = parseRetryAfter(headers, {
            attempt: i,
            baseBackoffMs: 500,
            maxBackoffMs: 32_000,
            withJitter: true,
          });
          const delay = retryDecision.waitMs;
          const reason = this.classifyRateLimitReason(e);
          // Structured event for the FEATURE_130 UI countdown / cost
          // tracker. Fired BEFORE the sleep so the spinner can render
          // the wait duration in real time.
          onRetryAfter?.({
            provider: this.name,
            waitMs: delay,
            reason,
            source: retryDecision.source,
            attempt: i + 1,
            maxAttempts: retries,
          });
          if (onRateLimit) {
            onRateLimit(i + 1, retries, delay);
          } else if (!onRetryAfter) {
            // Only log to console when neither the legacy nor the
            // structured callback is wired — UI surfaces handle it
            // when at least one is set.
            console.log(`[Rate Limit] Retrying in ${delay / 1000}s (${i + 1}/${retries})...`);
          }

          if (signal?.aborted) {
            throw abortError();
          }

          await waitForRetryDelay(delay, signal);

          if (signal?.aborted) {
            throw abortError();
          }

          continue;
        }
        // Passive capability learning: a HARD reasoning-effort rejection is
        // ground truth that this provider/model doesn't support the rung.
        // Signal it (so the REPL narrows the ladder + switches to a safe
        // effort) AND self-heal THIS turn: flip the suppress flag and retry
        // once with the effort param dropped, so the request still completes
        // and the user never has to re-send their query.
        if (reasoningGuard && !effortRetried) {
          const rejection = classifyReasoningEffortRejection(e, reasoningGuard.effort);
          if (rejection) {
            reasoningGuard.onRejected?.({
              provider: this.name,
              model: reasoningGuard.model,
              effort: rejection.rejectedEffort,
            });
            retryState.suppressReasoningEffort = true;
            effortRetried = true;
            continue; // transparent retry without the rejected effort
          }
        }
        // A second effort rejection after we already dropped the param is not
        // expected; fall through to the typed error so the caller sees it.
        if (reasoningGuard && effortRetried) {
          const rejection = classifyReasoningEffortRejection(e, reasoningGuard.effort);
          if (rejection) {
            throw new KodaXReasoningEffortRejectedError(
              `${this.name} rejected reasoning effort "${rejection.rejectedEffort}" even after dropping it.`,
              this.name,
              rejection.rejectedEffort,
              reasoningGuard.model,
            );
          }
        }
        // Non-rate-limit errors
        if (e instanceof Error) {
          if (
            signal?.aborted &&
            (e.name === 'AbortError' || (await isProviderSdkAbortError(e)))
          ) {
            if (e.name === 'AbortError') {
              throw e;
            }
            throw new DOMException(e.message || 'Request aborted', 'AbortError');
          }

          // ECONNRESET / EPIPE: stale keep-alive socket.
          // Flag the provider so subclasses can rebuild the client with
          // a fresh connection pool on the next request.
          const errorCode = extractErrorCode(e);
          if (errorCode === 'ECONNRESET' || errorCode === 'EPIPE') {
            this.onStaleConnection();
          }

          if (e instanceof KodaXProviderError) throw e;

          throw new KodaXProviderError(
            `${this.name} API error: ${e.message}`,
            this.name,
            this.providerErrorMetadata(e),
          );
        }
        throw e;
      }
    }
    throw new KodaXError('Unexpected end of withRateLimit');
  }
}
