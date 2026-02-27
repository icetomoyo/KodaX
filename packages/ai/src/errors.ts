/**
 * KodaX AI Errors
 *
 * AI 层错误类型 - 提供结构化的错误处理
 */

/** 基础 KodaX 错误类 */
export class KodaXError extends Error {
  constructor(message: string, public readonly code: string = 'KODAX_ERROR') {
    super(message);
    this.name = 'KodaXError';
  }
}

/** Provider 配置错误 */
export class KodaXProviderError extends KodaXError {
  constructor(message: string, public readonly provider?: string) {
    super(message, 'PROVIDER_ERROR');
    this.name = 'KodaXProviderError';
  }
}

/** API 速率限制错误 */
export class KodaXRateLimitError extends KodaXError {
  constructor(message: string, public readonly retryAfter?: number) {
    super(message, 'RATE_LIMIT_ERROR');
    this.name = 'KodaXRateLimitError';
  }
}
