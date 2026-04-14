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
  KodaXReasoningCapability,
  KodaXReasoningOverride,
  KodaXReasoningRequest,
  KodaXStreamResult,
} from '../types.js';
import { KodaXError, KodaXRateLimitError, KodaXProviderError } from '../errors.js';
import {
  cloneCapabilityProfile,
  NATIVE_PROVIDER_CAPABILITY_PROFILE,
} from './capability-profile.js';
import {
  getReasoningCapability,
  normalizeReasoningRequest,
} from '../reasoning.js';
import {
  buildReasoningOverrideKey,
  loadReasoningOverride,
  reasoningCapabilityToOverride,
  reasoningOverrideToCapability,
  saveReasoningOverride,
} from '../reasoning-overrides.js';

export abstract class KodaXBaseProvider {
  abstract readonly name: string;
  abstract readonly supportsThinking: boolean;
  protected abstract readonly config: KodaXProviderConfig;

  /**
   * When a "prompt too long / context window exceeded" error is detected,
   * this field is set to the reduced max output tokens for the next retry.
   * It is consumed once and cleared after use.
   */
  protected maxOutputTokensOverride?: number;

  abstract stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    signal?: AbortSignal
  ): Promise<KodaXStreamResult>;

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
    throw new KodaXProviderError(`${this.name} does not support non-streaming fallback`);
  }

  isConfigured(): boolean {
    return !!process.env[this.config.apiKeyEnv];
  }

  getModel(): string {
    return this.config.model;
  }

  getAvailableModels(): string[] {
    if (!this.config.models?.length) return [this.config.model];
    return [...new Set([this.config.model, ...this.config.models.map(m => m.id)])];
  }

  getModelDescriptor(modelId?: string): KodaXModelDescriptor | undefined {
    if (!modelId || modelId === this.config.model) {
      return { id: this.config.model };
    }
    return this.config.models?.find(m => m.id === modelId);
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
    const override = loadReasoningOverride(this.name, this.config, modelOverride);
    return override
      ? reasoningOverrideToCapability(override)
      : this.getConfiguredReasoningCapability(modelOverride);
  }

  getReasoningOverride(modelOverride?: string): KodaXReasoningOverride | undefined {
    return loadReasoningOverride(this.name, this.config, modelOverride);
  }

  getReasoningOverrideKey(modelOverride?: string): string {
    return buildReasoningOverrideKey(this.name, this.config, modelOverride);
  }

  protected persistReasoningCapabilityOverride(
    capability: KodaXReasoningCapability,
    modelOverride?: string,
  ): void {
    const override = reasoningCapabilityToOverride(capability);
    if (!override) {
      return;
    }
    saveReasoningOverride(this.name, this.config, override, modelOverride);
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

  protected getReasoningFallbackChain(
    capability: KodaXReasoningCapability,
  ): KodaXReasoningCapability[] {
    switch (capability) {
      case 'native-budget':
        return ['native-budget', 'native-toggle', 'none'];
      case 'native-effort':
        return ['native-effort', 'none'];
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
   * @returns 上下文窗口大小 (tokens)
   */
  getContextWindow(): number {
    return this.config.contextWindow ?? 200000;  // 默认 200k
  }

  protected getApiKey(): string {
    const key = process.env[this.config.apiKeyEnv];
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
  ): Required<KodaXReasoningRequest> {
    return normalizeReasoningRequest(reasoning);
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
    return ['rate', 'limit', '速率', '频率', '1302', '429', 'too many'].some(k => s.includes(k));
  }

  /**
   * Extract Retry-After delay from error headers (429/529 responses).
   * Returns milliseconds, or undefined if not available.
   */
  protected extractRetryAfterMs(error: unknown): number | undefined {
    // Anthropic SDK: error.headers?.['retry-after']
    const headers = (error as any)?.headers ?? (error as any)?.response?.headers;
    const raw = typeof headers?.get === 'function'
      ? headers.get('retry-after')
      : headers?.['retry-after'];
    if (!raw) return undefined;
    const seconds = Number(raw);
    if (!isNaN(seconds) && seconds > 0) {
      // Cap at 120s — beyond that, just fail and let the user know
      return Math.min(seconds * 1000, 120_000);
    }
    return undefined;
  }

  /**
   * Detect "prompt too long / context window exceeded" errors and compute
   * a reduced max_tokens for retry.  Returns undefined if not a context
   * overflow error.
   */
  protected parseContextOverflow(error: unknown): number | undefined {
    const msg = String((error as any)?.message ?? '');
    // Anthropic: "prompt is too long: 180000 tokens > 200000 maximum"
    // OpenAI:    "maximum context length is 128000 tokens. However, you requested 150000 tokens"
    // Zhipu/Kimi variants with Chinese messages
    const patterns = [
      /(\d[\d,]*)\s*tokens?.*?(\d[\d,]*)\s*(?:maximum|limit|context)/i,
      /maximum.*?(\d[\d,]*)\s*tokens?.*?requested.*?(\d[\d,]*)/i,
      /exceeds?\s+.*?(\d[\d,]*)\s*.*?(?:limit|max|上限).*?(\d[\d,]*)/i,
    ];
    for (const pat of patterns) {
      const m = msg.match(pat);
      if (m) {
        const a = Number(m[1]!.replace(/,/g, ''));
        const b = Number(m[2]!.replace(/,/g, ''));
        const inputTokens = Math.min(a, b);
        const contextLimit = Math.max(a, b);
        const safetyBuffer = 1000;
        const available = Math.max(3000, contextLimit - inputTokens - safetyBuffer);
        return available;
      }
    }
    return undefined;
  }

  protected isContextOverflowError(error: unknown): boolean {
    const msg = String((error as any)?.message ?? '').toLowerCase();
    return msg.includes('prompt is too long')
      || msg.includes('prompt too long')
      || msg.includes('context length')
      || msg.includes('context_length_exceeded')
      || msg.includes('context window')
      || msg.includes('上下文长度');
  }

  protected async withRateLimit<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
    retries = 3,
    onRateLimit?: (attempt: number, maxRetries: number, delayMs: number) => void
  ): Promise<T> {
    for (let i = 0; i < retries; i++) {
      try {
        const result = await fn();
        this.maxOutputTokensOverride = undefined; // Clear on success
        return result;
      } catch (e) {
        // Context window overflow: compute reduced max_tokens and retry once
        if (this.isContextOverflowError(e) && !this.maxOutputTokensOverride) {
          const reduced = this.parseContextOverflow(e);
          if (reduced) {
            this.maxOutputTokensOverride = reduced;
            onRateLimit?.(i + 1, retries, 0);
            continue; // Retry immediately with reduced max_tokens
          }
        }

        if (this.isRateLimitError(e)) {
          // Last retry exhausted — throw
          if (i === retries - 1) {
            throw new KodaXRateLimitError(
              `API rate limit exceeded after ${retries} retries. Please wait and try again later.`,
              60000
            );
          }

          // Exponential backoff with jitter, respecting Retry-After header
          const retryAfterMs = this.extractRetryAfterMs(e);
          const baseDelay = Math.min(500 * Math.pow(2, i), 32_000);
          const jitter = Math.random() * 0.25 * baseDelay;
          const delay = retryAfterMs ?? Math.round(baseDelay + jitter);

          if (onRateLimit) {
            onRateLimit(i + 1, retries, delay);
          } else {
            console.log(`[Rate Limit] Retrying in ${delay / 1000}s (${i + 1}/${retries})...`);
          }

          if (signal?.aborted) {
            throw new DOMException('Request aborted', 'AbortError');
          }

          await new Promise(resolve => setTimeout(resolve, delay));

          if (signal?.aborted) {
            throw new DOMException('Request aborted', 'AbortError');
          }

          continue;
        }
        // Non-rate-limit errors
        if (e instanceof Error) {
          if ((e.name === 'AbortError' || e.name === 'APIUserAbortError') && signal?.aborted) {
            if (e.name === 'AbortError') {
              throw e;
            }
            throw new DOMException(e.message || 'Request aborted', 'AbortError');
          }

          // ECONNRESET / EPIPE: stale keep-alive socket.
          // Flag the provider so subclasses can rebuild the client with
          // a fresh connection pool on the next request.
          const errorCode = (e as any)?.cause?.code ?? (e as any)?.code ?? '';
          if (errorCode === 'ECONNRESET' || errorCode === 'EPIPE') {
            this.onStaleConnection();
          }

          throw new KodaXProviderError(
            `${this.name} API error: ${e.message}`,
            this.name
          );
        }
        throw e;
      }
    }
    throw new KodaXError('Unexpected end of withRateLimit');
  }
}
