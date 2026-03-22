/**
 * KodaX Core Types
 *
 * 核心类型定义 - 重新导出 @kodax/agent 类型 + Coding 特定类型
 */

// ============== Import from @kodax/agent ==============
// 通用 Agent 类型从 @kodax/agent 导入

import type {
  KodaXTextBlock,
  KodaXToolUseBlock,
  KodaXToolResultBlock,
  KodaXThinkingBlock,
  KodaXRedactedThinkingBlock,
  KodaXContentBlock,
  KodaXMessage,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningCapability,
  KodaXReasoningMode,
  KodaXThinkingDepth,
  KodaXTaskType,
  KodaXExecutionMode,
  KodaXRiskLevel,
  KodaXTaskRoutingDecision,
  KodaXThinkingBudgetMap,
  KodaXTaskBudgetOverrides,
  KodaXReasoningRequest,
  KodaXSessionMeta,
  KodaXSessionStorage,
  SessionErrorMetadata,
} from '@kodax/agent';

// Re-export all types from @kodax/agent
export type {
  KodaXTextBlock,
  KodaXToolUseBlock,
  KodaXToolResultBlock,
  KodaXThinkingBlock,
  KodaXRedactedThinkingBlock,
  KodaXContentBlock,
  KodaXMessage,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningCapability,
  KodaXReasoningMode,
  KodaXThinkingDepth,
  KodaXTaskType,
  KodaXExecutionMode,
  KodaXRiskLevel,
  KodaXTaskRoutingDecision,
  KodaXThinkingBudgetMap,
  KodaXTaskBudgetOverrides,
  KodaXReasoningRequest,
  KodaXSessionMeta,
  KodaXSessionStorage,
  SessionErrorMetadata,
};

// ============== 事件接口 ==============

export interface KodaXEvents {
  // 流式输出
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onThinkingEnd?: (thinking: string) => void;
  onToolUseStart?: (tool: { name: string; id: string; input?: Record<string, unknown> }) => void;
  onToolResult?: (result: { id: string; name: string; content: string }) => void;
  onToolInputDelta?: (toolName: string, partialJson: string) => void;
  onStreamEnd?: () => void;

  // 状态通知
  onSessionStart?: (info: { provider: string; sessionId: string }) => void;
  onIterationStart?: (iter: number, maxIter: number) => void;
  /** Called after each iteration with current token count for UI updates */
  onIterationEnd?: (info: { iter: number; maxIter: number; tokenCount: number }) => void;
  onCompactStart?: () => void;
  /** Emitted when compaction finishes and actually changed the context */
  onCompact?: (estimatedTokens: number) => void;
  /** Emitted when compaction changes the context so UI can refresh token usage immediately */
  onCompactStats?: (info: { tokensBefore: number; tokensAfter: number }) => void;
  /** Emitted to silently dismiss the compaction UI if compaction aborted or completed without changes */
  onCompactEnd?: () => void;
  /** Whether the caller has queued follow-up input waiting for the next round */
  hasPendingInputs?: () => boolean;
  onRetry?: (reason: string, attempt: number, maxAttempts: number) => void;
  onProviderRateLimit?: (attempt: number, maxRetries: number, delayMs: number) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;

  // 用户交互（可选，由 REPL 层实现）
  /** Tool execution hook - called before tool execution, return false to block - 工具执行前回调 */
  beforeToolExecute?: (
    tool: string,
    input: Record<string, unknown>,
    meta?: { toolId?: string }
  ) => Promise<boolean | string>;
  /** Ask user a question interactively - Issue 069 - 交互式向用户提问 */
  askUser?: (options: AskUserQuestionOptions) => Promise<string>;
}

// ============== Agent 选项 ==============

export interface KodaXSessionOptions {
  id?: string;
  resume?: boolean;
  autoResume?: boolean;
  storage?: KodaXSessionStorage;
  initialMessages?: KodaXMessage[];
}

export interface KodaXContextOptions {
  /** Project root used for project-scoped prompts, permissions, and path policy. */
  gitRoot?: string | null;
  /**
   * Explicit working directory used for prompt context, relative tool paths,
   * and shell execution. Defaults to `gitRoot`, then `process.cwd()`.
   */
  executionCwd?: string;
  projectSnapshot?: string;
  longRunning?: {
    featuresFile?: string;
    progressFile?: string;
  };
  /** Skills system prompt snippet for progressive disclosure - Skills 系统提示词片段（渐进式披露） */
  skillsPrompt?: string;
  /** Internal execution-mode overlay appended to the system prompt */
  promptOverlay?: string;
}

export interface KodaXOptions {
  provider: string;
  model?: string;
  modelOverride?: string;
  thinking?: boolean;
  reasoningMode?: KodaXReasoningMode;
  maxIter?: number;
  parallel?: boolean;
  session?: KodaXSessionOptions;
  context?: KodaXContextOptions;
  events?: KodaXEvents;
  /** AbortSignal for cancelling the API request */
  abortSignal?: AbortSignal;
}

// ============== 结果类型 ==============

export interface KodaXResult {
  success: boolean;
  lastText: string;
  signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  signalReason?: string;
  messages: KodaXMessage[];
  sessionId: string;
  /** 是否被用户中断 (Ctrl+C) */
  interrupted?: boolean;
  /** 是否达到迭代上限 */
  limitReached?: boolean;
  /** Error metadata for recovery - 错误元数据用于恢复 */
  errorMetadata?: SessionErrorMetadata;
}

// ============== 工具执行上下文 ==============
// Simplified - no permission checks in core

export interface AskUserQuestionOptions {
  question: string;
  options: Array<{
    label: string;
    description?: string;
    value: string;
  }>;
  default?: string;
  intent?: "generic" | "plan-handoff";
  targetMode?: "accept-edits";
  scope?: "session";
  resumeBehavior?: "continue";
}

export interface KodaXToolExecutionContext {
  /** File backups for undo functionality - 文件备份用于撤销功能 */
  backups: Map<string, string>;
  /** Git root directory - Git 根目录 */
  gitRoot?: string;
  /** Working directory used to resolve relative paths and execute shell commands. */
  executionCwd?: string;
  /** Ask user a question interactively - 交互式向用户提问 (Issue 069) */
  askUser?: (options: AskUserQuestionOptions) => Promise<string>;
}
