/**
 * Post-compact attachment construction + injection — CAP-061
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-061-post-compact-attachment-construction--injection
 *
 * Class 1 (substrate). Sub-step within the compaction lifecycle that
 * runs ONLY when `intelligentCompact` succeeded with a non-empty
 * `artifactLedger`. Builds the post-compact ledger summary message
 * (`buildPostCompactAttachments`), reads the recently-modified files
 * within the remaining budget (`buildFileContentMessages`), injects
 * the resulting message bundle into the compacted history
 * (`injectPostCompactAttachments`), and returns a flat list of the
 * attachments for FEATURE_072 lineage compaction routing.
 *
 * Budget allocation:
 *   `totalPostCompactBudget = min(freedTokens × budgetRatio, POST_COMPACT_TOKEN_BUDGET)`
 * Ledger first; files use the remainder. The absolute cap aligns with
 * Claude Code's `POST_COMPACT_TOKEN_BUDGET` (fixed cap, not
 * proportional to freed tokens).
 *
 * Time-ordering constraint: WITHIN compact orchestration (CAP-060),
 * AFTER `intelligentCompact` returns success; BEFORE setting
 * `compacted` and emitting `onCompactStats` / `onCompact`.
 *
 * Migration history: extracted from `agent.ts:633-667` — pre-FEATURE_100
 * baseline — during FEATURE_100 P3.4b.
 */

import type { KodaXMessage } from '@kodax/ai';
import type { CompactionResult } from '@kodax/agent';
import {
  buildPostCompactAttachments,
  buildFileContentMessages,
  injectPostCompactAttachments,
  DEFAULT_POST_COMPACT_CONFIG,
  POST_COMPACT_TOKEN_BUDGET,
} from '@kodax/agent';
import { estimateTokens } from '../../tokenizer.js';

export interface ApplyPostCompactAttachmentsInput {
  /**
   * The post-compact messages array as returned by `intelligentCompact`.
   * The function returns a NEW array with attachments injected (no
   * mutation).
   */
  readonly compacted: KodaXMessage[];
  /** `result.artifactLedger` from `intelligentCompact` — must be non-empty. */
  readonly artifactLedger: NonNullable<CompactionResult['artifactLedger']>;
  /** `result.tokensBefore` from `intelligentCompact`. */
  readonly tokensBefore: number;
  /** `result.tokensAfter` from `intelligentCompact`. */
  readonly tokensAfter: number;
}

export interface ApplyPostCompactAttachmentsOutput {
  /** Compacted messages with the attachments bundle injected. */
  readonly compacted: KodaXMessage[];
  /**
   * Flat `[ledgerMessage, ...fileMessages]` list — routed via
   * `compactionUpdate.postCompactAttachments` for FEATURE_072 lineage
   * compaction (REPL-side native storage on the CompactionEntry).
   * Empty when the bundle's totalTokens is zero.
   */
  readonly postCompactAttachmentsForLineage: readonly KodaXMessage[];
}

/**
 * Apply post-compact attachments to a compacted message array. The
 * caller is responsible for the precondition: `artifactLedger` is
 * non-empty (the inline call site at `agent.ts` gates on this before
 * invoking).
 */
export async function applyPostCompactAttachments(
  input: ApplyPostCompactAttachmentsInput,
): Promise<ApplyPostCompactAttachmentsOutput> {
  const freedTokens = input.tokensBefore - input.tokensAfter;
  const attachments = buildPostCompactAttachments(input.artifactLedger, freedTokens);

  // Budget = total post-compact budget minus ledger tokens, capped by
  // absolute budget. Aligns with Claude Code's POST_COMPACT_TOKEN_BUDGET
  // (fixed cap, not proportional).
  const totalPostCompactBudget = Math.min(
    Math.floor(freedTokens * DEFAULT_POST_COMPACT_CONFIG.budgetRatio),
    POST_COMPACT_TOKEN_BUDGET,
  );
  const fileBudget = Math.max(0, totalPostCompactBudget - attachments.totalTokens);
  const fileMessages = fileBudget > 0
    ? await buildFileContentMessages(input.artifactLedger, fileBudget)
    : [];

  const fullAttachments = {
    ...attachments,
    fileMessages,
    totalTokens: attachments.totalTokens + estimateTokens(fileMessages as KodaXMessage[]),
  };

  if (fullAttachments.totalTokens <= 0) {
    return { compacted: input.compacted, postCompactAttachmentsForLineage: [] };
  }

  const compacted = injectPostCompactAttachments(input.compacted, fullAttachments);
  // Flat list for compactionUpdate: preserves [ledgerMessage, ...fileMessages] order.
  const postCompactAttachmentsForLineage: readonly KodaXMessage[] = [
    ...(fullAttachments.ledgerMessage ? [fullAttachments.ledgerMessage] : []),
    ...fullAttachments.fileMessages,
  ];

  return { compacted, postCompactAttachmentsForLineage };
}
