/**
 * @kodax/agent Compaction Module
 *
 * 上下文压缩模块 - 智能摘要与文件追踪
 */

// Types
export type {
  CompactionAnchor,
  CompactionConfig,
  CompactionDetails,
  CompactionUpdate,
  CompactionResult,
  FileOperations,
} from './types.js';

// File Tracking
export { extractArtifactLedger, extractFileOps, mergeArtifactLedger, mergeFileOps } from './file-tracker.js';

// Utils
export { serializeConversation } from './utils.js';

// Summary Generator
export {
  generateSummary,
  buildCompactionPromptSnapshot,
} from './summary-generator.js';
export type {
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
  DEFAULT_POST_COMPACT_CONFIG,
} from './post-compact.js';
export type { PostCompactConfig, PostCompactAttachments } from './post-compact.js';
