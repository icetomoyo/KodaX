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

/** 网络错误 (超时, 连接被拒绝等) */
export class KodaXNetworkError extends KodaXError {
  constructor(message: string, public readonly isTimeout: boolean = false) {
    super(message, 'NETWORK_ERROR');
    this.name = 'KodaXNetworkError';
  }
}

/** Tool call ID 不匹配错误 */
export class KodaXToolCallIdError extends KodaXError {
  constructor(message: string) {
    super(message, 'TOOL_CALL_ID_ERROR');
    this.name = 'KodaXToolCallIdError';
  }
}
