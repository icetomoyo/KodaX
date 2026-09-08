/**
 * ../../index.js Compaction Types
 */

import type { KodaXMessage, KodaXReasoningRequest, KodaXTokenUsage } from '@kodax-ai/llm';
import type {
  KodaXCompactMemorySeed,
  KodaXSessionArtifactLedgerEntry,
} from '../../types.js';

export interface CompactionConfig {
  /** Independent of the main turn; defaults off, or to a low supported effort on always-on models. */
  reasoning?: boolean | KodaXReasoningRequest;
  /** @deprecated Automatic large compaction is always enabled. */
  enabled: boolean;
  /**
   * Automatic large-compaction threshold percentage. Defaults to 75 and is
   * normalized to the inclusive 15-90 range.
   */
  triggerPercent: number;
  /**
   * Optional absolute token threshold. Missing or zero is inactive; otherwise
   * the smaller percentage/absolute/physical threshold wins.
   */
  triggerTokens?: number;
  /**
   * @deprecated V2 compaction no longer uses this option.
   * FEATURE_272 derives protection from the effective trigger and covers the
   * complete eligible prefix in one logical wave.
   */
  keepRecentPercent?: number;
  /**
   * @deprecated Large compaction protects 20% of its effective trigger.
   * Retained only for source compatibility with v0.7.x callers.
   */
  protectionPercent?: number;
  /**
   * @deprecated FEATURE_272 replaces rolling summary passes with one complete
   * eligible-prefix wave. Retained for source compatibility.
   */
  rollingSummaryPercent?: number;
  /**
   * Explicit legacy opt-in for destructive emergency pruning after semantic
   * compaction cannot restore a physically valid request. Undefined keeps the
   * fallback disabled.
   */
  pruningThresholdTokens?: number;
  /**
   * Legacy deterministic-pruning gap ratio. Only relevant when
   * `pruningThresholdTokens` is explicitly configured.
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
  /**
   * Exact host-only snapshot used to reconcile lineage before durable commit.
   * It is intentionally not part of the persisted CompactionEntry or provider
   * context. Hosts may evict old message bodies only after saving this state.
   */
  preCompactionMessages?: readonly KodaXMessage[];
  anchor?: CompactionAnchor;
  artifactLedger?: KodaXSessionArtifactLedgerEntry[];
  memorySeed?: KodaXCompactMemorySeed;
  /**
   * FEATURE_072: ledger-summary + file-content messages produced by
   * `buildPostCompactAttachments` + `buildFileContentMessages`. Agent.ts
   * passes these separately from the kept-tail messages so REPL-side
   * `applySessionCompaction` can store them natively on the CompactionEntry
   * rather than inlining them as loose `[Post-compact: ...]` system messages
   * in lineage. Agent.ts keeps inlining them into its local flat `messages`
   * via `injectPostCompactAttachments` (P4 belt-and-suspenders); the lineage
   * is the persistence source of truth.
   */
  postCompactAttachments?: readonly KodaXMessage[];
  /** Canonical metrics for one committed large-compaction transaction. */
  report?: CompactionReport;
}

export interface CompactionReport {
  /** Physical summary calls, including map/reduce; never contains prompt or output text. */
  readonly summaryRequests?: readonly CompactionRequestMetrics[];
  /** Durable history commit only; excludes summary generation. */
  readonly commitMs?: number;
  readonly strategy: 'full_prefix' | 'map_reduce';
  readonly triggerSource: 'percentage' | 'absolute' | 'physical_capacity';
  readonly effectiveTriggerTokens: number;
  readonly protectedBudgetTokens: number;
  readonly fixedInputTokens: number;
  readonly eligibleTokens: number;
  readonly rawTailTokens: number;
  readonly summaryTokens: number;
  readonly queryLedgerTokens: number;
}

export interface CompactionRequestMetrics {
  readonly provider: string;
  readonly model: string;
  /** Requested summary policy; the provider may adapt it to its capabilities. */
  readonly reasoning: boolean | KodaXReasoningRequest;
  readonly prepareMs: number;
  readonly credentialMs: number;
  /** Includes retries and their waits. firstDeltaMs is an offset within this duration. */
  readonly providerMs: number;
  readonly firstDeltaMs?: number;
  /** Retries reported by the provider adapter; excludes opaque upstream retries. */
  readonly retryCount: number;
  readonly retryWaitMs: number;
  readonly usage?: KodaXTokenUsage;
  readonly stopReason?: string;
  readonly outcome: 'succeeded' | 'failed';
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
  report?: CompactionReport;
}

export interface FileOperations {
  readFiles: string[];
  modifiedFiles: string[];
}
