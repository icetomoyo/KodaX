/**
 * @kodax/agent Compaction Types
 */

import type { KodaXMessage } from '@kodax/ai';
import type {
  KodaXCompactMemorySeed,
  KodaXSessionArtifactLedgerEntry,
} from '../types.js';

export interface CompactionConfig {
  /** Whether automatic compaction is enabled. */
  enabled: boolean;
  /** Trigger compaction when context usage exceeds this percentage of the window. */
  triggerPercent: number;
  /**
   * @deprecated V2 compaction no longer uses this option.
   *
   * The system now combines protected recent context, lightweight pruning, and
   * rolling summaries automatically.
   */
  keepRecentPercent?: number;
  /** Percentage of the most recent context that is never compacted or pruned. Defaults to 20. */
  protectionPercent?: number;
  /**
   * Percentage of the context window used as the chunk size for each rolling
   * summary pass. Defaults to 10.
   */
  rollingSummaryPercent?: number;
  /** Prune oversized tool results when they exceed roughly this many tokens. Defaults to 500. */
  pruningThresholdTokens?: number;
  /**
   * Gap ratio for prune fast-return. After pruning, if remaining tokens still exceed
   * triggerTokens * pruningGapRatio, the system continues to the summarization path
   * instead of returning early. Defaults to 0.8.
   */
  pruningGapRatio?: number;
  /** Optional override for the provider context window. */
  contextWindow?: number;
}

export interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface CompactionAnchor {
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  entriesRemoved: number;
  reason: string;
  artifactLedgerId?: string;
  details?: CompactionDetails;
  memorySeed?: KodaXCompactMemorySeed;
}

export interface CompactionUpdate {
  anchor?: CompactionAnchor;
  artifactLedger?: KodaXSessionArtifactLedgerEntry[];
  memorySeed?: KodaXCompactMemorySeed;
}

export interface CompactionResult {
  compacted: boolean;
  messages: KodaXMessage[];
  summary?: string;
  tokensBefore: number;
  tokensAfter: number;
  entriesRemoved: number;
  details?: CompactionDetails;
  artifactLedger?: KodaXSessionArtifactLedgerEntry[];
  anchor?: CompactionAnchor;
  memorySeed?: KodaXCompactMemorySeed;
}

export interface FileOperations {
  readFiles: string[];
  modifiedFiles: string[];
}
