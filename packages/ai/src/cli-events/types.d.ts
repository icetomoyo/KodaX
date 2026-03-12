/**
 * CLI 执行事件 - 统一抽象层，屏蔽两个 CLI 的格式差异
 */
export type CLIEvent = CLISessionStartEvent | CLIMessageEvent | CLIToolUseEvent | CLIToolResultEvent | CLIThinkingEvent | CLIErrorEvent | CLICompleteEvent;
export interface CLISessionStartEvent {
    type: 'session_start';
    timestamp: number;
    sessionId: string;
    model: string;
    raw: unknown;
}
export interface CLIMessageEvent {
    type: 'message';
    timestamp: number;
    role: 'user' | 'assistant';
    content: string;
    delta?: boolean;
    raw: unknown;
}
export interface CLIToolUseEvent {
    type: 'tool_use';
    timestamp: number;
    toolId: string;
    toolName: string;
    parameters: Record<string, unknown>;
    raw: unknown;
}
export interface CLIToolResultEvent {
    type: 'tool_result';
    timestamp: number;
    toolId: string;
    status: 'success' | 'error';
    output: string;
    raw: unknown;
}
export interface CLIThinkingEvent {
    type: 'thinking';
    timestamp: number;
    content: string;
    delta?: boolean;
    raw: unknown;
}
export interface CLIErrorEvent {
    type: 'error';
    timestamp: number;
    errorType: string;
    message: string;
    code?: number;
    raw: unknown;
}
export interface CLICompleteEvent {
    type: 'complete';
    timestamp: number;
    status: 'success' | 'failed';
    usage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    };
    raw: unknown;
}
export interface CLIExecutorConfig {
    command: string;
    baseArgs: string[];
    timeout?: number;
    cwd?: string;
    env?: Record<string, string>;
}
export interface CLIExecutionOptions {
    prompt: string;
    sessionId?: string;
    signal?: AbortSignal;
}
//# sourceMappingURL=types.d.ts.map