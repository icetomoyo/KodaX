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

export interface KodaXSessionMeta {
  _type: 'meta';
  title: string;
  id: string;
  gitRoot: string;
  createdAt: string;
}

// ============== 会话存储接口 ==============

export interface KodaXSessionStorage {
  save(id: string, data: { messages: KodaXMessage[]; title: string; gitRoot: string }): Promise<void>;
  load(id: string): Promise<{ messages: KodaXMessage[]; title: string; gitRoot: string } | null>;
  list?(gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number }>>;
  delete?(id: string): Promise<void>;
  deleteAll?(gitRoot?: string): Promise<void>;
}
