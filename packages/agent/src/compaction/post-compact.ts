/**
 * Post-Compact Reconstruction
 *
 * After compaction, injects artifact ledger summary and recently modified
 * file content back into the context so the agent remembers what it
 * operated on without re-reading files.
 *
 * Budget rule: total post-compact attachments are capped by the smaller of
 * (freed tokens × budgetRatio) and POST_COMPACT_TOKEN_BUDGET (absolute cap).
 * The absolute cap mirrors Claude Code's `POST_COMPACT_TOKEN_BUDGET = 50_000`
 * and prevents re-inflation when a single compaction frees a huge chunk.
 * Within the budget: ledger gets ≤15%, rest goes to file content
 * (per-file cap = min(perFileShare × total, POST_COMPACT_MAX_TOKENS_PER_FILE),
 * max 5 files).
 *
 * Idempotence: `injectPostCompactAttachments` strips any prior
 * `[Post-compact: ...]` system messages before inserting new ones, so a flat
 * messages array that survives across compaction rounds does not accumulate
 * multiple generations of post-compact attachments.
 */

import fs from 'fs/promises';
import type { KodaXMessage } from '@kodax/ai';
import type { KodaXSessionArtifactLedgerEntry } from '../types.js';
import { estimateTokens } from '../tokenizer.js';

/**
 * Absolute cap on total post-compact attachment tokens.
 * Mirrors Claude Code's POST_COMPACT_TOKEN_BUDGET (services/compact/compact.ts).
 */
export const POST_COMPACT_TOKEN_BUDGET = 50_000;

/**
 * Per-file hard cap on content tokens.
 * Mirrors Claude Code's POST_COMPACT_MAX_TOKENS_PER_FILE.
 */
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000;

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

/** Prefix used for all post-compact injected system messages. Used for dedup. */
const POST_COMPACT_MESSAGE_PREFIX = '[Post-compact:';

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
  // Cap by BOTH the proportional budget and an absolute ceiling so a single
  // big compaction can't re-inflate the context with a huge injection.
  const totalBudget = Math.min(
    Math.floor(freedTokens * config.budgetRatio),
    POST_COMPACT_TOKEN_BUDGET,
  );
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
 * Check whether a message is a previously-injected post-compact attachment
 * (ledger summary or file content). These must be stripped before a new
 * injection so attachments don't accumulate across compaction rounds.
 *
 * Mirrors Claude Code's `readFileState.clear()` discipline: each compaction
 * replaces the post-compact attachments wholesale, rather than stacking them.
 */
function isPostCompactAttachment(msg: KodaXMessage): boolean {
  return msg.role === 'system'
    && typeof msg.content === 'string'
    && msg.content.startsWith(POST_COMPACT_MESSAGE_PREFIX);
}

/**
 * Inject post-compact attachments into the compacted message array.
 *
 * Inserts after the compaction summary (first system message with the
 * summary prefix) and before the protected tail. Any existing post-compact
 * attachment messages in the input are stripped first to keep the injection
 * idempotent — without this, compaction repeated across iterations would
 * stack N generations of attachments, causing monotonic context growth.
 */
export function injectPostCompactAttachments(
  messages: KodaXMessage[],
  attachments: PostCompactAttachments,
): KodaXMessage[] {
  // Always strip prior attachments, even when the new injection is empty,
  // so a caller that explicitly wants to "reset" attachments gets a clean slate.
  const stripped = messages.some(isPostCompactAttachment)
    ? messages.filter((msg) => !isPostCompactAttachment(msg))
    : messages;

  if (!attachments.ledgerMessage && attachments.fileMessages.length === 0) {
    return stripped;
  }

  const toInject: KodaXMessage[] = [];
  if (attachments.ledgerMessage) toInject.push(attachments.ledgerMessage);
  toInject.push(...attachments.fileMessages);

  // Insert after the compaction summary (identified by its unique prefix)
  const summaryIdx = stripped.findIndex(
    (msg) => msg.role === 'system'
      && typeof msg.content === 'string'
      && msg.content.startsWith('[对话历史摘要]'),
  );

  if (summaryIdx >= 0) {
    return [
      ...stripped.slice(0, summaryIdx + 1),
      ...toInject,
      ...stripped.slice(summaryIdx + 1),
    ];
  }

  // No summary message found — prepend
  return [...toInject, ...stripped];
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

/**
 * Read recently modified files from disk and build system messages for
 * post-compact context restoration.
 *
 * @param ledger - Artifact ledger from compaction
 * @param budgetTokens - Remaining token budget after ledger injection
 * @param config - Budget configuration
 * @returns File content messages to merge into PostCompactAttachments.fileMessages
 */
export async function buildFileContentMessages(
  ledger: readonly KodaXSessionArtifactLedgerEntry[],
  budgetTokens: number,
  config: PostCompactConfig = DEFAULT_POST_COMPACT_CONFIG,
): Promise<readonly KodaXMessage[]> {
  if (budgetTokens <= 0) return [];

  // Pick recently modified/created files, sorted newest-first by timestamp
  const fileEntries = ledger
    .filter((e) => e.kind === 'file_modified' || e.kind === 'file_created')
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // Deduplicate by target path (keep most recent)
  const seen = new Set<string>();
  const unique: KodaXSessionArtifactLedgerEntry[] = [];
  for (const entry of fileEntries) {
    if (!seen.has(entry.target)) {
      seen.add(entry.target);
      unique.push(entry);
    }
  }

  const candidates = unique.slice(0, config.maxFiles);
  if (candidates.length === 0) return [];

  // Per-file cap is the smaller of the configured share and the absolute
  // ceiling (POST_COMPACT_MAX_TOKENS_PER_FILE). Prevents a large budget from
  // letting a single file consume the whole attachment slot.
  const perFileBudget = Math.min(
    Math.floor(budgetTokens * config.perFileShare),
    POST_COMPACT_MAX_TOKENS_PER_FILE,
  );
  const messages: KodaXMessage[] = [];
  let usedTokens = 0;

  for (const entry of candidates) {
    if (usedTokens >= budgetTokens) break;

    const content = await readFileHead(entry.target, perFileBudget);
    if (!content) continue;

    const msg: KodaXMessage = {
      role: 'system',
      content: `[Post-compact: file content] ${entry.target}\n${content}`,
    };
    const msgTokens = estimateTokens([msg]);
    if (usedTokens + msgTokens > budgetTokens) break;

    messages.push(msg);
    usedTokens += msgTokens;
  }

  return messages;
}

/** Read the head of a file, truncated to fit within a token budget. */
async function readFileHead(filePath: string, maxTokens: number): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    // Split into lines and take enough to fit the budget
    const lines = raw.split('\n');
    const chunks: string[] = [];
    let tokens = 0;
    for (const line of lines) {
      // Rough estimate: 1 token ≈ 4 chars
      const lineTokens = Math.ceil(line.length / 4) + 1;
      if (tokens + lineTokens > maxTokens) {
        chunks.push('[... truncated for post-compact budget]');
        break;
      }
      chunks.push(line);
      tokens += lineTokens;
    }
    return chunks.length > 0 ? chunks.join('\n') : null;
  } catch {
    // File may have been deleted or moved since the ledger was recorded
    return null;
  }
}
