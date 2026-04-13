/**
 * Post-Compact Reconstruction
 *
 * After compaction, injects artifact ledger summary and recently modified
 * file content back into the context so the agent remembers what it
 * operated on without re-reading files.
 *
 * Budget rule: total post-compact attachments ≤ 50% of freed space.
 * Within the budget: ledger gets ≤15%, rest goes to file content
 * (per-file cap = 20% of total budget, max 5 files).
 */

import type { KodaXMessage } from '@kodax/ai';
import type { KodaXSessionArtifactLedgerEntry } from '../types.js';
import { estimateTokens } from '../tokenizer.js';

export interface PostCompactConfig {
  /** Ratio of freed tokens to use for post-compact attachments. Default 0.5. */
  readonly budgetRatio: number;
  /** Maximum files to inject. Default 5. */
  readonly maxFiles: number;
  /** Ledger share as fraction of total budget. Default 0.15. */
  readonly ledgerShare: number;
  /** Per-file share as fraction of total budget. Default 0.20. */
  readonly perFileShare: number;
}

export const DEFAULT_POST_COMPACT_CONFIG: PostCompactConfig = {
  budgetRatio: 0.5,
  maxFiles: 5,
  ledgerShare: 0.15,
  perFileShare: 0.20,
};

export interface PostCompactAttachments {
  readonly ledgerMessage: KodaXMessage | null;
  readonly fileMessages: readonly KodaXMessage[];
  readonly totalTokens: number;
}

/**
 * Build post-compact system messages from the artifact ledger.
 * Does NOT read files from disk — that is the caller's responsibility.
 *
 * @param ledger - The artifact ledger from compaction
 * @param freedTokens - Tokens freed by compaction (tokensBefore - tokensAfter)
 * @param config - Budget configuration
 * @returns Attachments to inject after the compacted messages
 */
export function buildPostCompactAttachments(
  ledger: readonly KodaXSessionArtifactLedgerEntry[],
  freedTokens: number,
  config: PostCompactConfig = DEFAULT_POST_COMPACT_CONFIG,
): PostCompactAttachments {
  const MIN_USEFUL_BUDGET = 20; // Below this, any injection is noise
  const totalBudget = Math.floor(freedTokens * config.budgetRatio);
  if (totalBudget < MIN_USEFUL_BUDGET || ledger.length === 0) {
    return { ledgerMessage: null, fileMessages: [], totalTokens: 0 };
  }

  const ledgerBudget = Math.max(1, Math.floor(totalBudget * config.ledgerShare));
  const ledgerSummary = renderLedgerSummary(ledger, ledgerBudget);
  const ledgerMessage: KodaXMessage | null = ledgerSummary
    ? { role: 'system', content: `[Post-compact: recent operations]\n${ledgerSummary}` }
    : null;

  const ledgerTokens = ledgerMessage ? estimateTokens([ledgerMessage]) : 0;

  return {
    ledgerMessage,
    fileMessages: [],
    totalTokens: ledgerTokens,
  };
}

/**
 * Inject post-compact attachments into the compacted message array.
 * Inserts after the summary message (first system message) and before
 * the protected tail.
 */
export function injectPostCompactAttachments(
  messages: KodaXMessage[],
  attachments: PostCompactAttachments,
): KodaXMessage[] {
  if (!attachments.ledgerMessage && attachments.fileMessages.length === 0) {
    return messages;
  }

  const toInject: KodaXMessage[] = [];
  if (attachments.ledgerMessage) toInject.push(attachments.ledgerMessage);
  toInject.push(...attachments.fileMessages);

  // Insert after the compaction summary (identified by its unique prefix)
  const summaryIdx = messages.findIndex(
    (msg) => msg.role === 'system'
      && typeof msg.content === 'string'
      && msg.content.startsWith('[对话历史摘要]'),
  );

  if (summaryIdx >= 0) {
    return [
      ...messages.slice(0, summaryIdx + 1),
      ...toInject,
      ...messages.slice(summaryIdx + 1),
    ];
  }

  // No summary message found — prepend
  return [...toInject, ...messages];
}

/**
 * Render a compact text summary of the artifact ledger.
 * Groups entries by kind for readability.
 */
function renderLedgerSummary(
  ledger: readonly KodaXSessionArtifactLedgerEntry[],
  budgetTokens: number,
): string | null {
  const modified = ledger.filter((e) => e.kind === 'file_modified' || e.kind === 'file_created');
  const read = ledger.filter((e) => e.kind === 'file_read');
  const searches = ledger.filter((e) => e.kind === 'search_scope');
  const commands = ledger.filter((e) => e.kind === 'command_scope');

  const lines: string[] = [];

  if (modified.length > 0) {
    const items = modified.map((e) => {
      const action = e.action ?? e.kind.replace('file_', '');
      return `${e.displayTarget ?? e.target} (${action})`;
    });
    lines.push(`Modified: ${items.join(', ')}`);
  }

  if (read.length > 0) {
    const items = read.map((e) => e.displayTarget ?? e.target);
    lines.push(`Read: ${items.join(', ')}`);
  }

  if (searches.length > 0) {
    const items = searches.slice(-5).map((e) => {
      const scope = e.metadata?.path ?? '';
      return scope ? `${e.sourceTool} "${e.target}" ${scope}` : `${e.sourceTool} "${e.target}"`;
    });
    lines.push(`Search: ${items.join(', ')}`);
  }

  if (commands.length > 0) {
    const items = commands.slice(-5).map((e) =>
      e.action && e.action !== e.target
        ? `${e.action} ${e.displayTarget ?? e.target}`
        : e.displayTarget ?? e.target,
    );
    lines.push(`Commands: ${items.join(', ')}`);
  }

  if (lines.length === 0) return null;

  const summary = lines.join('\n');
  // Respect budget — return null if budget exhausted, truncate if over
  const summaryTokens = estimateTokens([{ role: 'system', content: summary }]);
  if (summaryTokens > budgetTokens) {
    if (budgetTokens <= 0) return null;
    const ratio = budgetTokens / summaryTokens;
    return summary.slice(0, Math.floor(summary.length * ratio));
  }

  return summary;
}
