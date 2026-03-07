/**
 * @kodax/agent Types
 *
 * 通用 Agent 类型定义
 */

// ============== Re-export AI Types from @kodax/ai ==============

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

// Import for local types
import type { KodaXMessage } from '@kodax/ai';

// ============== 会话元数据 ==============

/**
 * Session error metadata - 会话错误元数据
 * Used for error recovery and session cleanup - 用于错误恢复和会话清理
 */
export interface SessionErrorMetadata {
  /** Last error message - 最后的错误消息 */
  lastError?: string;
  /** Last error timestamp - 最后错误时间戳 */
  lastErrorTime?: number;
  /** Consecutive error count - 连续错误计数 */
  consecutiveErrors: number;
}

export interface KodaXSessionMeta {
  _type: 'meta';
  title: string;
  id: string;
  gitRoot: string;
  createdAt: string;
  /** Error metadata for recovery - 错误元数据用于恢复 */
  errorMetadata?: SessionErrorMetadata;
}

// ============== 会话存储接口 ==============

export interface KodaXSessionStorage {
  save(id: string, data: { messages: KodaXMessage[]; title: string; gitRoot: string; errorMetadata?: SessionErrorMetadata }): Promise<void>;
  load(id: string): Promise<{ messages: KodaXMessage[]; title: string; gitRoot: string; errorMetadata?: SessionErrorMetadata } | null>;
  list?(gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number }>>;
  delete?(id: string): Promise<void>;
  deleteAll?(gitRoot?: string): Promise<void>;
}
