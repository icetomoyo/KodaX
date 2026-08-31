/**
 * @kodax-ai/agent Types
 *
 * 通用 Agent 类型定义
 */

// ============== Re-export AI Types from @kodax-ai/llm ==============

export type {
  KodaXImageBlock,
  KodaXTextBlock,
  KodaXToolUseBlock,
  KodaXToolResultBlock,
  KodaXThinkingBlock,
  KodaXRedactedThinkingBlock,
  KodaXContentBlock,
  KodaXMessage,
  KodaXTaskResultMetadata,
  KodaXTaskResultSource,
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
  // v0.7.35.1 FEATURE_142 (A-R4): KodaXHarnessProfile / KodaXChildFanoutClass
  // removed — coding-routing-specific, see ADR-021. Coding-side consumers
  // import directly from `@kodax-ai/llm`. (AMA-controller advisory types were
  // deleted in ADR-043.)
  KodaXTaskRoutingDecision,
  KodaXThinkingBudgetMap,
  KodaXTaskBudgetOverrides,
  KodaXReasoningRequest,
} from '@kodax-ai/llm';

// Import for local types
import type { KodaXMessage } from '@kodax-ai/llm';
import type { AgentActorSnapshot } from './actors/types.js';

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
  /**
   * Stable logical identity for this transcript item. Cloned/forked entries get
   * a fresh physical `id` but keep their source entry's `logicalId`, allowing
   * SDK hosts to group or fold cloned history without comparing content.
   */
  logicalId?: string;
  /** Direct physical predecessor entry id this clone was copied from (the
   * clone source's own id, not a transitive root — see the SDK embedder guide). */
  sourceEntryId?: string;
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
  /**
   * FEATURE_072: post-compact ledger summary + file-content messages that
   * are inlined after the compaction summary at slicer time
   * (`getSessionMessagesFromLineage`). Stored here so they leave the active
   * path automatically when a new compaction entry is appended.
   *
   * NOTE: attachments are emitted by the slicer, NOT by `getContextMessagesForEntry`
   * — preserving the latter's 1-to-1 contract that `entryMatchesContextMessage`
   * and FEATURE_073's future slicing both depend on.
   */
  postCompactAttachments?: readonly KodaXMessage[];
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

export interface KodaXSessionArchiveMarkerEntry extends KodaXSessionEntryBase {
  type: 'archive_marker';
  /** Links to the corresponding batch in the .archive.jsonl sidecar file */
  archiveBatchId: string;
  /** Number of entries that were archived in this batch */
  archivedEntryCount: number;
  /** Brief summary of the archived content */
  summary: string;
}

export interface KodaXSessionRewindMarkerEntry extends KodaXSessionEntryBase {
  type: 'rewind_marker';
  targetId: string;
  fromId?: string;
  truncatedCount: number;
  summary: string;
}

export interface KodaXSessionClientNoticeEntry extends KodaXSessionEntryBase {
  type: 'client_notice';
  source: string;
  content: string;
  turnId?: string;
  payload?: KodaXJsonValue;
}

export interface KodaXMemoryOutcomeDigest {
  readonly id: string;
  readonly reviewKey: string;
  /** Stable root-episode identity; absent on pre-F263 digests. */
  readonly episodeId?: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly sequence: number;
  readonly objective: string;
  readonly actionSignature?: string;
  readonly approach: string;
  /**
   * `cancelled` is reserved for a host-bound explicit Memory intent. Ordinary
   * cancelled episodes do not produce an outcome digest.
   */
  readonly outcome: 'succeeded' | 'failed' | 'cancelled';
  readonly summary: string;
  readonly preconditions?: string;
  readonly lesson?: string;
  readonly evidenceRefs: readonly string[];
  readonly evidence?: readonly KodaXMemoryOutcomeEvidence[];
  /**
   * Explicit durable intent captured from the Action LLM and bound by the
   * host to an exact quote in the current user turn. It is evidence for the
   * governed reviewer, never proof that Memory was queued or applied.
   */
  readonly memoryIntent?: KodaXMemoryIntent;
  /** Explicit Memory operations already completed during this episode. */
  readonly handledMemoryOperations?: readonly KodaXHandledMemoryOperation[];
  readonly memoryInfluence?: readonly KodaXMemoryInfluenceRef[];
  readonly visibility: 'prompt_safe' | 'private' | 'sensitive';
  readonly createdAt: string;
}

export interface KodaXHandledMemoryOperation {
  readonly operation: 'remember' | 'correct' | 'forget';
  readonly disposition?: 'applied' | 'decision' | 'blocked';
  readonly statement?: string;
  readonly claimKey?: string;
  readonly targetRefIds: readonly string[];
}

export interface KodaXMemoryIntent {
  readonly operation: 'remember' | 'correct';
  readonly evidenceRef: string;
  /** Sanitized model-derived claim proposed for governed review. */
  readonly candidateStatement: string;
  /** Sanitized representation of the exact current-user quote verified by the host. */
  readonly userQuote: string;
}

export interface KodaXMemoryOutcomeEvidence {
  readonly ref: string;
  readonly grade: 'authoritative' | 'verified' | 'corroborated' | 'observed' | 'inferred';
  readonly source: 'user' | 'host' | 'tool' | 'environment' | 'agent';
  readonly verdict?: 'passed' | 'failed' | 'inconclusive';
  readonly observedAt: string;
}

export interface KodaXMemoryInfluenceRef {
  readonly decisionReceiptRef: string;
  readonly grade: 'direct' | 'supporting' | 'exposed' | 'unknown';
}

export interface KodaXSessionMemoryOutcomeDigestEntry extends KodaXSessionEntryBase {
  readonly type: 'memory_outcome_digest';
  readonly digest: KodaXMemoryOutcomeDigest;
  /** Durable F263 review job identity. Absent on pre-F263 lineage records. */
  readonly jobId?: string;
}

export interface KodaXSessionMemoryReviewReceiptEntry extends KodaXSessionEntryBase {
  readonly type: 'memory_review_receipt';
  /** Distinguishes repeated review keys across branch epochs. */
  readonly jobId?: string;
  readonly reviewKey: string;
  readonly proposalIds: readonly string[];
  readonly status: 'completed' | 'no_action';
  readonly completedAt: string;
}

// ============== Goal (FEATURE_192 v0.7.44) ==============

export type KodaXGoalStatus =
  | 'active'
  | 'paused'
  | 'budget_limited'
  | 'blocked'
  | 'complete';

/**
 * Persistent user-set goal state. v0.7.44 FEATURE_192 — backs the
 * `/goal` slash command and the get_goal / create_goal / update_goal
 * tools.
 *
 * Persistence model: each lifecycle event (create / update / pause /
 * resume / clear / budget_limited / blocked / complete) appends a
 * `KodaXSessionGoalEntry` carrying a frozen `KodaXGoalState` snapshot
 * to the session lineage. `readLatestGoalFromBranch` walks the active
 * branch's message-entry IDs and returns the latest goal entry whose
 * parentId belongs to that branch — so forks and rewinds naturally
 * drop goals attached to abandoned message paths.
 */
export interface KodaXGoalState {
  readonly version: 1;
  /** `${createdAt}-${rand}` — stable across updates of the same goal. */
  readonly id: string;
  readonly objective: string;
  readonly status: KodaXGoalStatus;
  /** Optional explicit token budget; null when the user did not set one. */
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
  /** Consecutive turns the model has reported the same blocker. */
  readonly blockerTurnCount: number;
  /** The blocker_kind string the model last reported, or null. */
  readonly lastBlockerKind: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type KodaXGoalEventType =
  | 'created'
  | 'updated'
  | 'paused'
  | 'resumed'
  | 'cleared'
  | 'budget_limited'
  | 'blocked'
  | 'complete';

export interface KodaXSessionGoalEntry extends KodaXSessionEntryBase {
  type: 'goal';
  /** Snapshot at time of event; `null` only when `event === 'cleared'`. */
  goal: KodaXGoalState | null;
  event: KodaXGoalEventType;
}

export type KodaXSessionEntry =
  | KodaXSessionMessageEntry
  | KodaXSessionCompactionEntry
  | KodaXSessionBranchSummaryEntry
  | KodaXSessionLabelEntry
  | KodaXSessionArchiveMarkerEntry
  | KodaXSessionRewindMarkerEntry
  | KodaXSessionClientNoticeEntry
  | KodaXSessionMemoryOutcomeDigestEntry
  | KodaXSessionMemoryReviewReceiptEntry
  | KodaXSessionGoalEntry;

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
  entry: Exclude<
    KodaXSessionEntry,
    KodaXSessionLabelEntry
      | KodaXSessionGoalEntry
      | KodaXSessionClientNoticeEntry
      | KodaXSessionRewindMarkerEntry
      | KodaXSessionMemoryOutcomeDigestEntry
      | KodaXSessionMemoryReviewReceiptEntry
  >;
  children: KodaXSessionTreeNode[];
  label?: string;
  active: boolean;
}

export type KodaXSessionScope = 'user' | 'managed-task-worker';

export type KodaXSessionUiTextHistoryItemType =
  | 'user'
  | 'assistant'
  | 'system'
  | 'thinking'
  | 'error'
  | 'event'
  | 'info'
  | 'hint'
  | 'sidecar';

export type KodaXSessionUiHistoryItemType =
  | KodaXSessionUiTextHistoryItemType
  | 'tool_group';

export interface KodaXSessionUiTextHistoryItem {
  type: KodaXSessionUiTextHistoryItemType;
  text: string;
  /** Original UI event time in epoch milliseconds. Absent on older sessions. */
  timestamp?: number;
  /** Display-only item that is authoritative even without a canonical message anchor. */
  presentationOnly?: true;
  icon?: string;
  compactText?: string;
}

export type KodaXSessionUiToolCallStatus =
  | 'success'
  | 'error'
  | 'cancelled'
  | 'awaiting_approval';

export interface KodaXSessionUiToolCall {
  id: string;
  name: string;
  status: KodaXSessionUiToolCallStatus;
  input?: { [key: string]: KodaXJsonValue };
  preview?: string;
  output?: string;
  error?: string;
  startTime?: number;
  endTime?: number;
}

export interface KodaXSessionUiToolGroupHistoryItem {
  type: 'tool_group';
  /** Original UI event time in epoch milliseconds. Absent on older sessions. */
  timestamp?: number;
  tools: KodaXSessionUiToolCall[];
}

export type KodaXSessionUiHistoryItem =
  | KodaXSessionUiTextHistoryItem
  | KodaXSessionUiToolGroupHistoryItem;

export type KodaXSessionWorkspaceKind = 'detected' | 'managed';

export interface KodaXSessionRuntimeInfo {
  canonicalRepoRoot?: string;
  workspaceRoot?: string;
  executionCwd?: string;
  branch?: string;
  workspaceKind?: KodaXSessionWorkspaceKind;
  // FEATURE_247 (R5) — structured profile/runtime identity so an SDK embedder
  // (e.g. KodaX-Space) can restore a historical Partner session and keep it a
  // Partner after fork, without packing everything into the opaque `tag`. All
  // optional and opaque to the agent layer (plain strings — no coding-layer
  // enum imports, preserving layer independence). Absent on old session files.
  /** SDK consumer surface/profile label, e.g. `'code'` | `'partner'`. */
  surface?: string;
  /** SDK consumer profile id (stable name or UUID). */
  profileId?: string;
  /** SDK consumer profile version. */
  profileVersion?: string;
  /** LLM provider alias active at session start, e.g. `'anthropic'`. */
  provider?: string;
  /** Model identifier active at session start. */
  model?: string;
  /** Reasoning mode active at session start. */
  reasoningMode?: string;
  /** Permission mode active at session start, e.g. `'auto'` | `'plan'`. */
  permissionMode?: string;
  /** Agent mode active at session start, e.g. `'sa'` | `'ama'`. */
  agentMode?: string;
  /** Runtime-owned exact linked-worktree roots admitted for this Session. */
  sandboxWorktreeRoots?: string[];
}

export interface KodaXSessionData {
  messages: KodaXMessage[];
  title: string;
  gitRoot: string;
  /** Consumer-owned private string persisted with the session. */
  tag?: string;
  runtimeInfo?: KodaXSessionRuntimeInfo;
  scope?: KodaXSessionScope;
  uiHistory?: KodaXSessionUiHistoryItem[];
  errorMetadata?: SessionErrorMetadata;
  extensionState?: KodaXExtensionSessionState;
  extensionRecords?: KodaXExtensionSessionRecord[];
  lineage?: KodaXSessionLineage;
  artifactLedger?: KodaXSessionArtifactLedgerEntry[];
  /** Runtime-owned F270 Actor tree snapshot; persisted with the session owner. */
  actorSnapshot?: AgentActorSnapshot;
}

export interface KodaXSessionMeta {
  _type: 'meta';
  title: string;
  id: string;
  gitRoot: string;
  /** Consumer-owned private string persisted with the session. */
  tag?: string;
  runtimeInfo?: KodaXSessionRuntimeInfo;
  createdAt: string;
  scope?: KodaXSessionScope;
  uiHistory?: KodaXSessionUiHistoryItem[];
  extensionState?: KodaXExtensionSessionState;
  extensionRecordCount?: number;
  artifactLedgerCount?: number;
  /** Runtime-owned F270 Actor tree snapshot; absent on pre-v0.7.72 sessions. */
  actorSnapshot?: AgentActorSnapshot;
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
  /** Atomically updates Runtime-owned Session metadata without replacing transcript state. */
  mutateRuntimeInfo?(
    id: string,
    mutation: (
      runtimeInfo: KodaXSessionRuntimeInfo | undefined,
    ) => KodaXSessionRuntimeInfo | undefined,
  ): Promise<boolean>;
  /**
   * Atomically mutates context-silent lineage state against the latest
   * persisted session. Hosts that own session persistence may expose this
   * without allowing the runner to write a stale full snapshot. Returns
   * true when the session existed and the callback was evaluated, including
   * an idempotent no-op; false only when the session was not found.
   */
  mutateLineage?(
    id: string,
    mutation: (lineage: KodaXSessionLineage) => KodaXSessionLineage,
  ): Promise<boolean>;
  getLineage?(id: string): Promise<KodaXSessionLineage | null>;
  /** Exact lineage merged from the active session file and island sidecars. */
  loadFullLineage?(id: string): Promise<KodaXSessionLineage | null>;
  setActiveEntry?(
    id: string,
    selector: string,
    options?: KodaXSessionNavigationOptions,
  ): Promise<KodaXSessionData | null>;
  setLabel?(id: string, selector: string, label?: string): Promise<KodaXSessionData | null>;
  rewind?(id: string, selector?: string): Promise<KodaXSessionData | null>;
  fork?(
    id: string,
    selector?: string,
    options?: { sessionId?: string; title?: string },
  ): Promise<{ sessionId: string; data: KodaXSessionData } | null>;
  list?(
    gitRoot?: string,
    options?: { limit?: number; includeArchived?: boolean },
  ): Promise<Array<{
    id: string;
    title: string;
    msgCount: number;
    tag?: string;
    runtimeInfo?: KodaXSessionRuntimeInfo;
  }>>;
  delete?(id: string): Promise<void>;
  deleteAll?(gitRoot?: string): Promise<void>;
}
