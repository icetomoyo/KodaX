/**
 * @kodax/agent Types
 *
 * 通用 Agent 类型定义
 */

// ============== Re-export AI Types from @kodax/ai ==============

export type {
  KodaXImageBlock,
  KodaXTextBlock,
  KodaXToolUseBlock,
  KodaXToolResultBlock,
  KodaXThinkingBlock,
  KodaXRedactedThinkingBlock,
  KodaXContentBlock,
  KodaXMessage,
  KodaXTokenUsage,
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
  KodaXTaskComplexity,
  KodaXTaskWorkIntent,
  KodaXTaskFamily,
  KodaXTaskActionability,
  KodaXExecutionPattern,
  KodaXMutationSurface,
  KodaXAssuranceIntent,
  KodaXHarnessProfile,
  KodaXAmaProfile,
  KodaXAmaTactic,
  KodaXAmaFanoutClass,
  KodaXAmaFanoutPolicy,
  KodaXAmaControllerDecision,
  KodaXTaskRoutingDecision,
  KodaXThinkingBudgetMap,
  KodaXTaskBudgetOverrides,
  KodaXReasoningRequest,
} from '@kodax/ai';

// Import for local types
import type { KodaXMessage } from '@kodax/ai';

export type KodaXJsonPrimitive = string | number | boolean | null;
export type KodaXJsonValue =
  | KodaXJsonPrimitive
  | KodaXJsonValue[]
  | { [key: string]: KodaXJsonValue };

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

export interface KodaXExtensionSessionRecord {
  id: string;
  extensionId: string;
  type: string;
  ts: number;
  data?: KodaXJsonValue;
  dedupeKey?: string;
}

export type KodaXExtensionSessionState = Record<string, Record<string, KodaXJsonValue>>;

export interface KodaXSessionEntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface KodaXSessionMessageEntry extends KodaXSessionEntryBase {
  type: 'message';
  message: KodaXMessage;
}

export interface KodaXSessionCompactionEntry extends KodaXSessionEntryBase {
  type: 'compaction';
  summary: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  artifactLedgerId?: string;
  reason?: string;
  details?: KodaXJsonValue;
  memorySeed?: KodaXCompactMemorySeed;
}

export interface KodaXSessionBranchSummaryEntry extends KodaXSessionEntryBase {
  type: 'branch_summary';
  summary: string;
  fromId?: string;
  details?: KodaXJsonValue;
}

export interface KodaXSessionLabelEntry extends KodaXSessionEntryBase {
  type: 'label';
  targetId: string;
  label?: string;
}

export type KodaXSessionEntry =
  | KodaXSessionMessageEntry
  | KodaXSessionCompactionEntry
  | KodaXSessionBranchSummaryEntry
  | KodaXSessionLabelEntry;

export interface KodaXSessionArtifactLedgerEntry {
  id: string;
  kind:
    | 'file_read'
    | 'file_modified'
    | 'file_created'
    | 'file_deleted'
    | 'path_scope'
    | 'search_scope'
      | 'command_scope'
      | 'check_result'
      | 'decision'
      | 'image_input'
      | 'tombstone';
  sourceTool?: string;
  action?: string;
  target: string;
  displayTarget?: string;
  summary?: string;
  sessionEntryId?: string;
  timestamp: string;
  metadata?: Record<string, KodaXJsonValue>;
}

export interface KodaXCompactMemoryProgress {
  completed: string[];
  inProgress: string[];
  blockers: string[];
}

export interface KodaXCompactMemorySeed {
  objective?: string;
  constraints: string[];
  progress: KodaXCompactMemoryProgress;
  keyDecisions: string[];
  nextSteps: string[];
  keyContext: string[];
  importantTargets: string[];
  tombstones: string[];
}

export interface KodaXSessionLineage {
  version: 2;
  activeEntryId: string | null;
  entries: KodaXSessionEntry[];
}

export interface KodaXSessionNavigationOptions {
  summarizeCurrentBranch?: boolean;
}

export interface KodaXSessionTreeNode {
  entry: Exclude<KodaXSessionEntry, KodaXSessionLabelEntry>;
  children: KodaXSessionTreeNode[];
  label?: string;
  active: boolean;
}

export type KodaXSessionScope = 'user' | 'managed-task-worker';

export type KodaXSessionUiHistoryItemType =
  | 'user'
  | 'assistant'
  | 'system'
  | 'thinking'
  | 'error'
  | 'event'
  | 'info'
  | 'hint';

export interface KodaXSessionUiHistoryItem {
  type: KodaXSessionUiHistoryItemType;
  text: string;
  icon?: string;
  compactText?: string;
}

export type KodaXSessionWorkspaceKind = 'detected' | 'managed';

export interface KodaXSessionRuntimeInfo {
  canonicalRepoRoot?: string;
  workspaceRoot?: string;
  executionCwd?: string;
  branch?: string;
  workspaceKind?: KodaXSessionWorkspaceKind;
}

export interface KodaXSessionData {
  messages: KodaXMessage[];
  title: string;
  gitRoot: string;
  runtimeInfo?: KodaXSessionRuntimeInfo;
  scope?: KodaXSessionScope;
  uiHistory?: KodaXSessionUiHistoryItem[];
  errorMetadata?: SessionErrorMetadata;
  extensionState?: KodaXExtensionSessionState;
  extensionRecords?: KodaXExtensionSessionRecord[];
  lineage?: KodaXSessionLineage;
  artifactLedger?: KodaXSessionArtifactLedgerEntry[];
}

export interface KodaXSessionMeta {
  _type: 'meta';
  title: string;
  id: string;
  gitRoot: string;
  runtimeInfo?: KodaXSessionRuntimeInfo;
  createdAt: string;
  scope?: KodaXSessionScope;
  uiHistory?: KodaXSessionUiHistoryItem[];
  extensionState?: KodaXExtensionSessionState;
  extensionRecordCount?: number;
  artifactLedgerCount?: number;
  lineageVersion?: 2;
  activeEntryId?: string | null;
  lineageEntryCount?: number;
  activeMessageCount?: number;
  /** Error metadata for recovery - 错误元数据用于恢复 */
  errorMetadata?: SessionErrorMetadata;
}

// ============== Extension Persistence Store (FEATURE_034) ==============

/**
 * Extension-scoped persistence entry.
 *
 * Each entry belongs to a namespace (extensionId) and carries
 * a string key, a JSON-safe value, and an opaque version tag
 * used for optimistic concurrency control.
 */
export interface KodaXExtensionStoreEntry {
  key: string;
  value: KodaXJsonValue;
  version: string;
  updatedAt: number;
}

/**
 * Extension persistence store interface (FEATURE_034 manual persistence).
 *
 * Implementations provide a durable key-value store scoped to a single
 * extension identity.  The store is independent of session lifecycle —
 * data survives across sessions and restarts.
 */
export interface KodaXExtensionStore {
  /**
   * Read a single key.
   * Returns `undefined` when the key does not exist.
   */
  get(key: string): Promise<KodaXExtensionStoreEntry | undefined>;

  /**
   * Write a key-value pair.
   *
   * When `expectedVersion` is provided the write only succeeds when the
   * stored entry's version still matches (optimistic concurrency).
   * Returns the new entry on success, or `false` on version mismatch.
   */
  put(
    key: string,
    value: KodaXJsonValue,
    options?: { expectedVersion?: string },
  ): Promise<KodaXExtensionStoreEntry | false>;

  /**
   * Remove a key.
   * Returns `true` when the key existed and was removed.
   */
  delete(key: string): Promise<boolean>;

  /**
   * List all keys (optionally filtered by prefix).
   */
  list(options?: { prefix?: string }): Promise<string[]>;

  /**
   * Clear all keys (optionally filtered by prefix).
   * Returns the number of entries removed.
   */
  clear(options?: { prefix?: string }): Promise<number>;
}

// ============== 会话存储接口 ==============

export interface KodaXSessionStorage {
  save(id: string, data: KodaXSessionData): Promise<void>;
  load(id: string): Promise<KodaXSessionData | null>;
  getLineage?(id: string): Promise<KodaXSessionLineage | null>;
  setActiveEntry?(
    id: string,
    selector: string,
    options?: KodaXSessionNavigationOptions,
  ): Promise<KodaXSessionData | null>;
  setLabel?(id: string, selector: string, label?: string): Promise<KodaXSessionData | null>;
  fork?(
    id: string,
    selector?: string,
    options?: { sessionId?: string; title?: string },
  ): Promise<{ sessionId: string; data: KodaXSessionData } | null>;
  list?(gitRoot?: string): Promise<Array<{
    id: string;
    title: string;
    msgCount: number;
    runtimeInfo?: KodaXSessionRuntimeInfo;
  }>>;
  delete?(id: string): Promise<void>;
  deleteAll?(gitRoot?: string): Promise<void>;
}
