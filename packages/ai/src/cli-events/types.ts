/**
 * Unified event model for CLI-backed providers.
 * This hides the wire-format differences between Codex CLI and Gemini CLI.
 */
export type CLIEvent =
    | CLISessionStartEvent
    | CLIMessageEvent
    | CLIToolUseEvent
    | CLIToolResultEvent
    | CLIThinkingEvent
    | CLIErrorEvent
    | CLICompleteEvent;

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
    delta?: boolean; // Whether this chunk is streamed incrementally.
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
    command: string;              // e.g. "codex" or "gemini"
    baseArgs: string[];           // Provider-specific base arguments
    timeout?: number;             // Optional timeout in milliseconds
    cwd?: string;                 // Working directory for the subprocess
    env?: Record<string, string>; // Additional environment variables
}

export interface CLIExecutionOptions {
    prompt: string;
    sessionId?: string; // Session identifier for resume flows
    model?: string; // Model override for CLIs that support explicit selection
    signal?: AbortSignal; // Cancellation signal
}
