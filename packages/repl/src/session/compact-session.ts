/**
 * FEATURE_247 (R6) — imperative session compaction.
 *
 * Lets an SDK embedder (KodaX-Space) compact a session by id immediately —
 * e.g. when the user clicks a "/compact" button — instead of forging a token
 * snapshot or appending an empty message to trip auto-compaction. Loads the
 * session, runs the same `compact()` pass the REPL `/compact` command uses,
 * applies the result to the session lineage (so `loadFullTranscript` / resume
 * see the compaction entry), and writes it back.
 *
 * Applies uniformly to Partner and Coder sessions. Failures normally return
 * `{ compacted: false, reason }`; trusted Runtime callers may request propagation.
 */

import {
  applySessionCompaction,
  buildPostCompactAttachments,
  compact,
  createSessionLineage,
  estimateTokens,
  getSessionMessagesFromLineage,
  normalizeCompactionConfig,
  type KodaXMessage,
  type CompactionReport,
} from '@kodax-ai/agent';
import {
  CODING_SUMMARY_PROMPT,
  CODING_UPDATE_SUMMARY_PROMPT,
  resolveProvider,
} from '@kodax-ai/coding';

import { FileSessionStorage } from '../interactive/storage.js';
import { loadCompactionConfig } from '../common/compaction-config.js';
import type { SessionData } from '../ui/utils/session-storage.js';

export interface CompactSessionOptions {
  /** Provider alias for the summarizer. Defaults to the session's persisted provider, then 'anthropic'. */
  readonly provider?: string;
  /** Model override forwarded to the summarizer. */
  readonly model?: string;
  /** Custom summarizer instructions (same as `/compact <text>`). */
  readonly customInstructions?: string;
  /** Provider context-window override (tokens). Otherwise resolved from the provider/model. */
  readonly contextWindow?: number;
  /** Percentage threshold used to derive the protected tail (normalized to 15-90). */
  readonly triggerPercent?: number;
  /** Optional absolute threshold used to derive the protected tail; zero is inactive. */
  readonly triggerTokens?: number;
  /** Sessions directory (mirrors createSessionManager's override). */
  readonly sessionsDir?: string;
  /** Injected storage instance (takes precedence over sessionsDir). */
  readonly storage?: FileSessionStorage;
  /** Trusted Runtime seam used to preserve broker/lease failures as RPC errors. */
  readonly propagateErrors?: boolean;
}

export interface CompactSessionResult {
  /** True when the session was actually rewritten. */
  readonly compacted: boolean;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  /** The rewritten (or unchanged) message list. */
  readonly messages: KodaXMessage[];
  /** Canonical component accounting for a committed compaction. */
  readonly report?: CompactionReport;
  /** Populated when `compacted` is false to explain why (not-found / no-op / error). */
  readonly reason?: string;
}

function resolveStorage(options?: CompactSessionOptions): FileSessionStorage {
  if (options?.storage) return options.storage;
  return options?.sessionsDir !== undefined
    ? new FileSessionStorage({ sessionsDir: options.sessionsDir })
    : new FileSessionStorage();
}

/**
 * Compact a session by id, writing the result (lineage + messages) back to
 * storage. Never throws.
 */
export async function compactSession(
  sessionId: string,
  options?: CompactSessionOptions,
): Promise<CompactSessionResult> {
  const empty: CompactSessionResult = {
    compacted: false,
    tokensBefore: 0,
    tokensAfter: 0,
    messages: [],
  };
  try {
    const storage = resolveStorage(options);
    const data = await storage.load(sessionId);
    if (!data) {
      return { ...empty, reason: `session not found: ${sessionId}` };
    }

    const messages = data.messages;
    const providerName = options?.provider ?? data.runtimeInfo?.provider ?? 'anthropic';
    const provider = resolveProvider(providerName);
    if (!provider) {
      return { ...empty, messages, reason: `provider not found: ${providerName}` };
    }

    const contextWindow =
      options?.contextWindow
      ?? provider.getEffectiveContextWindow?.(options?.model)
      ?? provider.getContextWindow?.()
      ?? 200_000;
    const currentTokens = estimateTokens(messages);
    const loadedCompactionConfig = await loadCompactionConfig();
    const compactionConfig = normalizeCompactionConfig({
      ...loadedCompactionConfig,
      contextWindow,
      triggerPercent: options?.triggerPercent ?? loadedCompactionConfig.triggerPercent,
      triggerTokens: options?.triggerTokens ?? loadedCompactionConfig.triggerTokens,
    });

    const result = await compact(
      messages,
      compactionConfig,
      provider,
      contextWindow,
      options?.customInstructions,
      undefined,
      currentTokens,
      CODING_SUMMARY_PROMPT,
      CODING_UPDATE_SUMMARY_PROMPT,
      options?.model,
      true,
      provider.getEffectiveMaxOutputTokens(options?.model),
    );

    if (!result.compacted) {
      return {
        compacted: false,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        messages,
        reason: 'no compaction needed',
      };
    }

    // Persist lineage-correctly so loadFullTranscript / resume see the
    // compaction entry (not just a flat message-list swap).
    const anchor = result.anchor ?? {
      summary: result.summary ?? '',
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      reason: 'manual',
    };
    // Attach a "recent operations" ledger summary so the resumed session keeps
    // the post-compact context the /compact middleware path injects. Without it,
    // an SDK-initiated compaction drops that context and the next turn may
    // re-read files it had already touched. File-content messages stay out of
    // this lightweight path (they need async reads); the ledger summary is
    // synchronous and covers the common case.
    const ledger = result.artifactLedger ?? data.artifactLedger ?? [];
    const freedTokens = Math.max(0, (result.tokensBefore ?? 0) - (result.tokensAfter ?? 0));
    const { ledgerMessage } = buildPostCompactAttachments(ledger, freedTokens);
    const postCompactAttachments = ledgerMessage ? [ledgerMessage] : [];
    const exactBase = createSessionLineage(messages, data.lineage);
    const preliminaryLineage = applySessionCompaction(
      exactBase,
      result.messages,
      anchor,
      postCompactAttachments,
    );
    const finalMessages = getSessionMessagesFromLineage(preliminaryLineage);
    const finalTokensAfter = estimateTokens(finalMessages);
    const latestCompaction = [...preliminaryLineage.entries]
      .reverse()
      .find((entry) => entry.type === 'compaction');
    const newLineage = latestCompaction
      ? {
          ...preliminaryLineage,
          entries: preliminaryLineage.entries.map((entry) => (
            entry.id === latestCompaction.id && entry.type === 'compaction'
              ? { ...entry, tokensAfter: finalTokensAfter }
              : entry
          )),
        }
      : preliminaryLineage;

    const updated: SessionData = {
      ...data,
      messages: finalMessages,
      lineage: newLineage,
      artifactLedger: result.artifactLedger ?? data.artifactLedger,
    };
    await storage.save(sessionId, updated);

    return {
      compacted: true,
      tokensBefore: result.tokensBefore,
      tokensAfter: finalTokensAfter,
      messages: finalMessages,
      report: result.report,
    };
  } catch (error) {
    if (options?.propagateErrors === true) throw error;
    return {
      ...empty,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
