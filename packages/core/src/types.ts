/**
 * KodaX Core Types
 *
 * 核心类型定义 - 所有模块共享的类型接口
 */

// ============== Re-export AI Types from @kodax/ai ==============
// These are re-exported for backward compatibility
// New code should import directly from @kodax/ai

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
} from '@kodax/ai';

// ============== 会话元数据 ==============

export interface KodaXSessionMeta {
  _type: 'meta';
  title: string;
  id: string;
  gitRoot: string;
  createdAt: string;
}

// ============== 事件接口 ==============

export interface KodaXEvents {
  // 流式输出
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onThinkingEnd?: (thinking: string) => void;
  onToolUseStart?: (tool: { name: string; id: string }) => void;
  onToolResult?: (result: { id: string; name: string; content: string }) => void;
  onToolInputDelta?: (toolName: string, partialJson: string) => void;
  onStreamEnd?: () => void;

  // 状态通知
  onSessionStart?: (info: { provider: string; sessionId: string }) => void;
  onIterationStart?: (iter: number, maxIter: number) => void;
  onCompact?: (estimatedTokens: number) => void;
  onRetry?: (reason: string, attempt: number, maxAttempts: number) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;

  // 用户交互（可选，由 REPL 层实现）
  /** Tool execution hook - called before tool execution, return false to block - 工具执行前回调 */
  beforeToolExecute?: (tool: string, input: Record<string, unknown>) => Promise<boolean>;
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
  gitRoot?: string | null;
  projectSnapshot?: string;
  longRunning?: {
    featuresFile?: string;
    progressFile?: string;
  };
}

// Import KodaXMessage for KodaXSessionOptions
import type { KodaXMessage } from '@kodax/ai';

export interface KodaXOptions {
  provider: string;
  thinking?: boolean;
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
}

// ============== 会话存储接口 ==============

export interface KodaXSessionStorage {
  save(id: string, data: { messages: KodaXMessage[]; title: string; gitRoot: string }): Promise<void>;
  load(id: string): Promise<{ messages: KodaXMessage[]; title: string; gitRoot: string } | null>;
  list?(gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number }>>;
  delete?(id: string): Promise<void>;
  deleteAll?(gitRoot?: string): Promise<void>;
}

// ============== 工具执行上下文 ==============
// Simplified - no permission checks in core

export interface KodaXToolExecutionContext {
  /** File backups for undo functionality - 文件备份用于撤销功能 */
  backups: Map<string, string>;
  /** Git root directory - Git 根目录 */
  gitRoot?: string;
}
