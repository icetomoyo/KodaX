/**
 * ../../index.js Compaction Module
 *
 * 上下文压缩模块 - 智能摘要与文件追踪
 */

// Types
export type {
  CompactionAnchor,
  CompactionConfig,
  CompactionDetails,
  CompactionReport,
  CompactionRequestMetrics,
  CompactionUpdate,
  CompactionResult,
  FileOperations,
} from './types.js';

export {
  COMPACTION_PROTECTION_RATIO,
  DEFAULT_COMPACTION_TRIGGER_PERCENT,
  MAX_COMPACTION_TRIGGER_PERCENT,
  MIN_COMPACTION_TRIGGER_PERCENT,
  normalizeCompactionConfig,
  resolveCompactionPolicy,
} from './policy.js';

export {
  collectUserQueryLedger,
  mergeUserQueryLedger,
  parseUserQueryLedger,
  renderUserQueryLedger,
} from './query-ledger.js';
export type { UserQueryLedgerEntry } from './query-ledger.js';
export type {
  CompactionTriggerSource,
  ResolvedCompactionPolicy,
} from './policy.js';

// File Tracking
export { extractArtifactLedger, extractFileOps, mergeArtifactLedger, mergeFileOps } from './file-tracker.js';

// Utils
export { serializeConversation } from './utils.js';

// Summary Generator
export {
  generateSummary,
  buildCompactionPromptSnapshot,
  buildCompactionCacheInstruction,
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_UPDATE_SUMMARY_PROMPT,
} from './summary-generator.js';
export type {
  CompactionCacheContext,
  CompactionProviderObserver,
  CompactionProviderRequest,
  CompactionProviderRouting,
  KodaXCompactionPromptVariant,
  KodaXCompactionPromptSection,
  KodaXCompactionPromptSnapshot,
} from './summary-generator.js';

// Compaction Core
export { needsCompaction, compact } from './compaction.js';

// Microcompaction
export { microcompact, DEFAULT_MICROCOMPACTION_CONFIG } from './microcompaction.js';
export type { MicrocompactionConfig } from './microcompaction.js';

// Bash Intent
export { extractBashIntent } from './bash-intent.js';

// Post-Compact Reconstruction
export {
  buildFileContentMessages,
  buildPostCompactAttachments,
  injectPostCompactAttachments,
  isPostCompactAttachment,
  stripPostCompactAttachments,
  DEFAULT_POST_COMPACT_CONFIG,
  POST_COMPACT_TOKEN_BUDGET,
  POST_COMPACT_MAX_TOKENS_PER_FILE,
} from './post-compact.js';
export type { PostCompactConfig, PostCompactAttachments } from './post-compact.js';
