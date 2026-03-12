/**
 * KodaX AI Types
 *
 * AI 层类型定义 - 所有 Provider 共享的类型接口
 */
export interface KodaXTextBlock {
    type: 'text';
    text: string;
}
export interface KodaXToolUseBlock {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
}
export interface KodaXToolResultBlock {
    type: 'tool_result';
    tool_use_id: string;
    content: string;
    is_error?: boolean;
}
export interface KodaXThinkingBlock {
    type: 'thinking';
    thinking: string;
    signature?: string;
}
export interface KodaXRedactedThinkingBlock {
    type: 'redacted_thinking';
    data: string;
}
export type KodaXContentBlock = KodaXTextBlock | KodaXToolUseBlock | KodaXToolResultBlock | KodaXThinkingBlock | KodaXRedactedThinkingBlock;
export interface KodaXMessage {
    role: 'user' | 'assistant' | 'system';
    content: string | KodaXContentBlock[];
}
export interface KodaXStreamResult {
    textBlocks: KodaXTextBlock[];
    toolBlocks: KodaXToolUseBlock[];
    thinkingBlocks: (KodaXThinkingBlock | KodaXRedactedThinkingBlock)[];
}
export interface KodaXToolDefinition {
    name: string;
    description: string;
    input_schema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}
export interface KodaXProviderConfig {
    apiKeyEnv: string;
    baseUrl?: string;
    model: string;
    supportsThinking: boolean;
    /** 模型的上下文窗口大小 (tokens) */
    contextWindow?: number;
}
export interface KodaXProviderStreamOptions {
    onTextDelta?: (text: string) => void;
    onThinkingDelta?: (text: string) => void;
    onThinkingEnd?: (thinking: string) => void;
    onToolInputDelta?: (toolName: string, partialJson: string) => void;
    /** 当底层 API 遇到 Rate Limit 进行重试时触发 */
    onRateLimit?: (attempt: number, maxRetries: number, delayMs: number) => void;
    /** 会话标识，用于多轮对话上下文恢复 */
    sessionId?: string;
    /** AbortSignal for cancelling the stream request */
    signal?: AbortSignal;
}
//# sourceMappingURL=types.d.ts.map