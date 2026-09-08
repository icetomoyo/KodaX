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
  compact,
  createSessionLineage,
  estimateTokens,
  getSessionMessagesFromLineage,
  normalizeCompactionConfig,
  type KodaXMessage,
  type CompactionReport,
  type CompactionConfig,
} from '@kodax-ai/agent';
import {
  CODING_SUMMARY_PROMPT,
  CODING_UPDATE_SUMMARY_PROMPT,
  resolveProvider,
  applyPostCompactAttachments,
} from '@kodax-ai/coding';

import { FileSessionStorage } from '../interactive/storage.js';
import { loadCompactionConfig } from '../common/compaction-config.js';
import type { SessionData } from '../ui/utils/session-storage.js';

export interface CompactSessionOptions {
  /** Summary policy, normally supplied by the Runtime Session settings. */
  readonly reasoning?: CompactionConfig['reasoning'];
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
 * storage. Returns failures unless `propagateErrors` is explicitly enabled.
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
    const model = options?.model
      ?? (providerName === data.runtimeInfo?.provider ? data.runtimeInfo.model : undefined);
    const provider = resolveProvider(providerName);
    if (!provider) {
      return { ...empty, messages, reason: `provider not found: ${providerName}` };
    }

    const contextWindow =
      options?.contextWindow
      ?? provider.getEffectiveContextWindow?.(model)
      ?? provider.getContextWindow?.()
      ?? 200_000;
    const currentTokens = estimateTokens(messages);
    const loadedCompactionConfig = await loadCompactionConfig();
    const compactionConfig = normalizeCompactionConfig({
      ...loadedCompactionConfig,
      ...(options?.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
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
      model,
      true,
      provider.getEffectiveMaxOutputTokens(model),
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
    const anchor = {
      summary: result.summary ?? '',
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      ...result.anchor,
      reason: 'manual',
    };
    const attached = await applyPostCompactAttachments({
      compacted: result.messages,
      artifactLedger: result.artifactLedger ?? data.artifactLedger ?? [],
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      capacity: { contextWindow, reservedResponseTokens: provider.getEffectiveMaxOutputTokens(model) },
    });
    const exactBase = createSessionLineage(messages, data.lineage);
    const preliminaryLineage = applySessionCompaction(
      exactBase,
      attached.compacted,
      anchor,
      attached.postCompactAttachmentsForLineage,
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
    const commitStartedAt = performance.now();
    await storage.save(sessionId, updated);
    const commitMs = performance.now() - commitStartedAt;

    return {
      compacted: true,
      tokensBefore: result.tokensBefore,
      tokensAfter: finalTokensAfter,
      messages: finalMessages,
      report: result.report ? { ...result.report, commitMs } : undefined,
    };
  } catch (error) {
    if (options?.propagateErrors === true) throw error;
    return {
      ...empty,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
