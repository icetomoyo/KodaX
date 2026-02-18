/**
 * KodaX Base Provider
 *
 * Provider 抽象基类 - 所有 Provider 的公共基础
 */

import { KodaXProviderConfig, KodaXMessage, KodaXToolDefinition, KodaXProviderStreamOptions, KodaXStreamResult } from '../types.js';
import { KodaXError, KodaXRateLimitError, KodaXProviderError } from '../errors.js';

export abstract class KodaXBaseProvider {
  abstract readonly name: string;
  abstract readonly supportsThinking: boolean;
  protected abstract readonly config: KodaXProviderConfig;

  abstract stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    thinking?: boolean,
    streamOptions?: KodaXProviderStreamOptions
  ): Promise<KodaXStreamResult>;

  isConfigured(): boolean {
    return !!process.env[this.config.apiKeyEnv];
  }

  getModel(): string {
    return this.config.model;
  }

  protected getApiKey(): string {
    const key = process.env[this.config.apiKeyEnv];
    if (!key) throw new Error(`${this.config.apiKeyEnv} not set`);
    return key;
  }

  protected isRateLimitError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const s = error.message.toLowerCase();
    return ['rate', 'limit', '速率', '频率', '1302', '429', 'too many'].some(k => s.includes(k));
  }

  protected async withRateLimit<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
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
          // 抛出速率限制错误，包含重试信息
          throw new KodaXRateLimitError(
            `API rate limit hit. Retrying in ${delay / 1000}s (${i + 1}/${retries})`,
            delay
          );
        }
        // 对于其他错误，包装成 Provider 错误
        if (e instanceof Error) {
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
