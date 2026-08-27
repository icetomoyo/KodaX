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
export interface KodaXProviderErrorMetadata {
  /** Stable KodaX classification hint; never an upstream response body. */
  readonly failureCode?:
    | 'provider_not_registered'
    | 'request_build_failed'
    | 'protocol_mismatch'
    | 'response_stream_error';
  readonly stage?: 'catalog' | 'request_build' | 'transport' | 'response_stream';
  readonly httpStatus?: number;
  readonly upstreamCode?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
}

export class KodaXProviderError extends KodaXError {
  constructor(
    message: string,
    public readonly provider?: string,
    public readonly metadata?: KodaXProviderErrorMetadata,
  ) {
    super(message, 'PROVIDER_ERROR');
    this.name = 'KodaXProviderError';
  }
}

/** API 速率限制错误 */
export class KodaXRateLimitError extends KodaXError {
  constructor(
    message: string,
    public readonly retryAfter?: number,
    public readonly metadata?: KodaXProviderErrorMetadata,
  ) {
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

/**
 * Reasoning-effort rejection (passive capability learning). Thrown when a
 * provider HARD-rejects a reasoning-effort value; the rejected rung has already
 * been signalled via `onReasoningEffortRejected` so the caller can record it
 * and retry with a safe effort.
 */
export class KodaXReasoningEffortRejectedError extends KodaXProviderError {
  constructor(
    message: string,
    provider: string,
    public readonly rejectedEffort: string,
    public readonly model: string,
  ) {
    super(message, provider);
    this.name = 'KodaXReasoningEffortRejectedError';
  }
}

/** Tool call ID 不匹配错误 */
export class KodaXToolCallIdError extends KodaXError {
  constructor(message: string) {
    super(message, 'TOOL_CALL_ID_ERROR');
    this.name = 'KodaXToolCallIdError';
  }
}
