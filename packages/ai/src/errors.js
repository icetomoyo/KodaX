/**
 * KodaX AI Errors
 *
 * AI 层错误类型 - 提供结构化的错误处理
 */
/** 基础 KodaX 错误类 */
export class KodaXError extends Error {
    code;
    constructor(message, code = 'KODAX_ERROR') {
        super(message);
        this.code = code;
        this.name = 'KodaXError';
    }
}
/** Provider 配置错误 */
export class KodaXProviderError extends KodaXError {
    provider;
    constructor(message, provider) {
        super(message, 'PROVIDER_ERROR');
        this.provider = provider;
        this.name = 'KodaXProviderError';
    }
}
/** API 速率限制错误 */
export class KodaXRateLimitError extends KodaXError {
    retryAfter;
    constructor(message, retryAfter) {
        super(message, 'RATE_LIMIT_ERROR');
        this.retryAfter = retryAfter;
        this.name = 'KodaXRateLimitError';
    }
}
/** 网络错误 (超时, 连接被拒绝等) */
export class KodaXNetworkError extends KodaXError {
    isTimeout;
    constructor(message, isTimeout = false) {
        super(message, 'NETWORK_ERROR');
        this.isTimeout = isTimeout;
        this.name = 'KodaXNetworkError';
    }
}
/** Tool call ID 不匹配错误 */
export class KodaXToolCallIdError extends KodaXError {
    constructor(message) {
        super(message, 'TOOL_CALL_ID_ERROR');
        this.name = 'KodaXToolCallIdError';
    }
}
//# sourceMappingURL=errors.js.map