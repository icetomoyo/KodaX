/**
 * KodaX Core Types
 *
 * 核心类型定义 - 所有模块共享的类型接口
 */

// ============== 内容块类型 ==============

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

export type KodaXContentBlock =
  | KodaXTextBlock
  | KodaXToolUseBlock
  | KodaXToolResultBlock
  | KodaXThinkingBlock
  | KodaXRedactedThinkingBlock;

// ============== 消息类型 ==============

export interface KodaXMessage {
  role: 'user' | 'assistant';
  content: string | KodaXContentBlock[];
}

export interface KodaXSessionMeta {
  _type: 'meta';
  title: string;
  id: string;
  gitRoot: string;
  createdAt: string;
}

// ============== 流式结果类型 ==============

export interface KodaXStreamResult {
  textBlocks: KodaXTextBlock[];
  toolBlocks: KodaXToolUseBlock[];
  thinkingBlocks: (KodaXThinkingBlock | KodaXRedactedThinkingBlock)[];
}

// ============== 工具定义 ==============

export interface KodaXToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ============== Provider 配置 ==============

export interface KodaXProviderConfig {
  apiKeyEnv: string;
  baseUrl?: string;
  model: string;
  supportsThinking: boolean;
}

export interface KodaXProviderStreamOptions {
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onThinkingEnd?: (thinking: string) => void;
  onToolInputDelta?: (toolName: string, partialJson: string) => void;
}

// ============== 事件接口 ==============

export interface KodaXEvents {
  // 流式输出
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string, charCount: number) => void;
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

  // 用户交互（可选，由 CLI 层实现）
  onConfirm?: (tool: string, input: Record<string, unknown>) => Promise<boolean>;
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

export interface KodaXOptions {
  provider: string;
  thinking?: boolean;
  maxIter?: number;
  parallel?: boolean;
  auto?: boolean;
  confirmTools?: Set<string>;
  session?: KodaXSessionOptions;
  context?: KodaXContextOptions;
  events: KodaXEvents;
}

// ============== 结果类型 ==============

export interface KodaXResult {
  success: boolean;
  lastText: string;
  signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  signalReason?: string;
  messages: KodaXMessage[];
  sessionId: string;
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

export interface KodaXToolExecutionContext {
  confirmTools: Set<string>;
  backups: Map<string, string>;
  auto: boolean;
  onConfirm?: (tool: string, input: Record<string, unknown>) => Promise<boolean>;
}

// ============== 配置类型 ==============

export interface KodaXConfig {
  provider?: string;
  thinking?: boolean;
  auto?: boolean;
}
