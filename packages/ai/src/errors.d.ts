/**
 * KodaX AI Errors
 *
 * AI 层错误类型 - 提供结构化的错误处理
 */
/** 基础 KodaX 错误类 */
export declare class KodaXError extends Error {
    readonly code: string;
    constructor(message: string, code?: string);
}
/** Provider 配置错误 */
export declare class KodaXProviderError extends KodaXError {
    readonly provider?: string | undefined;
    constructor(message: string, provider?: string | undefined);
}
/** API 速率限制错误 */
export declare class KodaXRateLimitError extends KodaXError {
    readonly retryAfter?: number | undefined;
    constructor(message: string, retryAfter?: number | undefined);
}
/** 网络错误 (超时, 连接被拒绝等) */
export declare class KodaXNetworkError extends KodaXError {
    readonly isTimeout: boolean;
    constructor(message: string, isTimeout?: boolean);
}
/** Tool call ID 不匹配错误 */
export declare class KodaXToolCallIdError extends KodaXError {
    constructor(message: string);
}
//# sourceMappingURL=errors.d.ts.map