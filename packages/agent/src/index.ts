/**
 * @kodax/agent
 *
 * 通用 Agent 框架 - 会话管理和消息处理
 *
 * 这个包提供了通用的 Agent 功能：
 * - 会话 ID 生成和标题提取
 * - Token 估算
 * - 消息压缩
 * - 通用常量配置
 */

// ============== Types ==============
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
  KodaXJsonValue,
  KodaXExtensionSessionRecord,
  KodaXExtensionSessionState,
  KodaXExtensionStoreEntry,
  KodaXExtensionStore,
  KodaXCompactMemoryProgress,
  KodaXCompactMemorySeed,
  KodaXSessionArchiveMarkerEntry,
  KodaXSessionBranchSummaryEntry,
  KodaXSessionCompactionEntry,
  KodaXSessionData,
  KodaXSessionEntry,
  KodaXSessionEntryBase,
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionLabelEntry,
  KodaXSessionLineage,
  KodaXSessionMessageEntry,
  KodaXSessionNavigationOptions,
  KodaXSessionMeta,
  KodaXSessionScope,
  KodaXSessionRuntimeInfo,
  KodaXSessionStorage,
  KodaXSessionTreeNode,
  KodaXSessionUiHistoryItem,
  KodaXSessionUiHistoryItemType,
  KodaXSessionWorkspaceKind,
  SessionErrorMetadata,
} from './types.js';

// ============== Constants ==============
export {
  KODAX_MAX_TOKENS,
  KODAX_DEFAULT_TIMEOUT,
  KODAX_HARD_TIMEOUT,
  KODAX_COMPACT_THRESHOLD,
  KODAX_COMPACT_KEEP_RECENT,
  KODAX_MAX_RETRIES,
  KODAX_RETRY_BASE_DELAY,
  KODAX_MAX_INCOMPLETE_RETRIES,
  KODAX_MAX_MAXTOKENS_RETRIES,
  KODAX_STAGGER_DELAY,
  KODAX_API_MIN_INTERVAL,
  PROMISE_PATTERN,
} from './constants.js';

// ============== Session ==============
export {
  generateSessionId,
  extractTitleFromMessages,
} from './session.js';

export {
  appendSessionLineageLabel,
  applySessionCompaction,
  archiveOldIslands,
  buildSessionTree,
  countActiveLineageMessages,
  createSessionLineage,
  forkSessionLineage,
  getSessionLineagePath,
  getSessionMessagesFromLineage,
  resolveSessionLineageTarget,
  findPreviousUserEntryId,
  rewindSessionLineage,
  setSessionLineageActiveEntry,
} from './session-lineage.js';

// ============== Tokenizer ==============
export {
  estimateTokens,
  countTokens,
} from './tokenizer.js';

// ============== Messages ==============
export {
  compactMessages,
} from './messages.js';

// ============== Compaction ==============
export type {
  CompactionAnchor,
  CompactionConfig,
  CompactionDetails,
  CompactionUpdate,
  CompactionResult,
  FileOperations,
} from './compaction/types.js';

export {
  extractArtifactLedger,
  extractFileOps,
  mergeArtifactLedger,
  mergeFileOps,
} from './compaction/file-tracker.js';

export {
  serializeConversation,
} from './compaction/utils.js';

export {
  generateSummary,
  buildCompactionPromptSnapshot,
} from './compaction/summary-generator.js';
export type {
  KodaXCompactionPromptVariant,
  KodaXCompactionPromptSection,
  KodaXCompactionPromptSnapshot,
} from './compaction/summary-generator.js';

export {
  needsCompaction,
  compact,
} from './compaction/compaction.js';

export {
  microcompact,
  DEFAULT_MICROCOMPACTION_CONFIG,
} from './compaction/microcompaction.js';
export type {
  MicrocompactionConfig,
} from './compaction/microcompaction.js';

export {
  buildFileContentMessages,
  buildPostCompactAttachments,
  injectPostCompactAttachments,
  DEFAULT_POST_COMPACT_CONFIG,
} from './compaction/post-compact.js';
export type {
  PostCompactConfig,
  PostCompactAttachments,
} from './compaction/post-compact.js';

// ============== Extension Persistence (FEATURE_034) ==============
export {
  FileExtensionStore,
  createExtensionStore,
} from './persistence.js';
