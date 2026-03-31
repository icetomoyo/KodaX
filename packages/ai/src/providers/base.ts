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

  abstract stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    signal?: AbortSignal
  ): Promise<KodaXStreamResult>;

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

  protected isRateLimitError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const s = error.message.toLowerCase();
    return ['rate', 'limit', '速率', '频率', '1302', '429', 'too many'].some(k => s.includes(k));
  }

  protected async withRateLimit<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
    retries = 3,
    onRateLimit?: (attempt: number, maxRetries: number, delayMs: number) => void
  ): Promise<T> {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (e) {
        if (this.isRateLimitError(e)) {
          const delay = (i + 1) * 2000;

          // 最后一次重试失败，抛出错误
          if (i === retries - 1) {
            throw new KodaXRateLimitError(
              `API rate limit exceeded after ${retries} retries. Please wait and try again later.`,
              60000
            );
          }

          // 显示重试信息
          if (onRateLimit) {
            onRateLimit(i + 1, retries, delay);
          } else {
            console.log(`[Rate Limit] Retrying in ${delay / 1000}s (${i + 1}/${retries})...`);
          }

          // 检查是否已被取消
          if (signal?.aborted) {
            throw new DOMException('Request aborted', 'AbortError');
          }

          // 等待后再重试
          await new Promise(resolve => setTimeout(resolve, delay));

          // 等待后再次检查（防止等待期间被取消）
          if (signal?.aborted) {
            throw new DOMException('Request aborted', 'AbortError');
          }

          // 继续循环，执行下一次 fn()
          continue;
        }
        // 对于其他错误，包装成 Provider 错误
        if (e instanceof Error) {
          // 区分用户主动取消和网络层面的 Abort 
          // (包含标准的 AbortError 以及部分 SDK 特有的 APIUserAbortError)
          if ((e.name === 'AbortError' || e.name === 'APIUserAbortError') && signal?.aborted) {
            // 将其规范化为 AbortError 抛出，让分类器将其统一识别为 USER_ABORT
            if (e.name === 'AbortError') {
              throw e;
            }
            throw new DOMException(e.message || 'Request aborted', 'AbortError');
          }
          throw new KodaXProviderError(
            `${this.name} API error: ${e.message}`,
            this.name
          );
        }
        throw e;
      }
    }
    // TypeScript 需要返回值，但这个代码理论上不会被执行
    throw new KodaXError('Unexpected end of withRateLimit');
  }
}
