/**
 * Compaction hook for the Runner-driven path — v0.7.26 parity.
 *
 * Legacy `agent.ts` (v0.7.22) ran `intelligentCompact` before every
 * provider.stream call: check `needsCompaction` → fire
 * `onCompactStart` → call `intelligentCompact` → fire
 * `onCompactStats` / `onCompact` / `onCompactEnd` → replace local
 * messages with the compacted view. The Runner-driven rewrite dropped
 * this entire pipeline; AMA sessions that exceed the compaction
 * threshold hit context window overflow and provider 400s.
 *
 * This module provides a full parity port:
 *   - loads compaction config from the repo root
 *   - tracks a per-run circuit breaker (same threshold as legacy)
 *   - delegates to `@kodax/agent/compact` for the actual summarisation
 *   - fires the legacy event surface (`onCompactStart` / `onCompactStats`
 *     / `onCompact` / `onCompactEnd` / `onCompactedMessages`) so the
 *     REPL can render its "compacting…" UI and refresh its local
 *     transcript mirror
 *   - re-injects the post-compact artifact ledger summary AND the
 *     recent-file contents (legacy `buildPostCompactAttachments` +
 *     `buildFileContentMessages` + `injectPostCompactAttachments`) —
 *     landed in commit 16e4093 (M3 parity). Without this step, long
 *     sessions crossing the compaction threshold lose post-mutation
 *     file context and the LLM hallucinates stale file state. The
 *     token budget is the smaller of (freedTokens × budgetRatio) and
 *     POST_COMPACT_TOKEN_BUDGET, matching Claude Code's fixed-cap
 *     policy.
 *
 * Behaviour delta vs legacy (documented):
 *   - custom-instructions arg to `intelligentCompact` is `undefined`
 *     (the Runner path doesn't expose per-compaction overrides);
 *   - systemPrompt arg is `undefined` (the provider carries it).
 */

import {
  buildFileContentMessages,
  buildPostCompactAttachments,
  compact as intelligentCompact,
  DEFAULT_POST_COMPACT_CONFIG,
  injectPostCompactAttachments,
  needsCompaction,
  POST_COMPACT_TOKEN_BUDGET,
  type CompactionConfig,
  type CompactionUpdate,
} from '@kodax/agent';

import type { AgentMessage } from '@kodax/core';

import { resolveProvider } from '../../../providers/index.js';
import { loadCompactionConfig } from '../../../compaction-config.js';
import type {
  KodaXEvents,
  KodaXMessage,
  KodaXOptions,
} from '../../../types.js';
import { estimateTokens } from '../../../tokenizer.js';

const COMPACT_CIRCUIT_BREAKER_LIMIT = 3;

export type RunnerCompactionHook = (
  transcript: readonly AgentMessage[],
) => Promise<readonly AgentMessage[] | undefined>;

/**
 * Build a compaction hook for `Runner.run`. The hook is safe to call on
 * every iteration — it short-circuits cheaply when the transcript is
 * below the trigger threshold. Errors are swallowed by core's hook
 * dispatch; any failure here skips compaction for that iteration.
 */
export async function buildManagedTaskCompactionHook(
  options: KodaXOptions,
): Promise<RunnerCompactionHook | undefined> {
  const compactionConfig: CompactionConfig = await loadCompactionConfig(
    options.context?.gitRoot ?? undefined,
  );
  if (!compactionConfig.enabled) {
    return undefined;
  }

  const provider = resolveProvider(options.provider ?? 'anthropic');
  const contextWindow = compactionConfig.contextWindow
    ?? provider.getContextWindow?.()
    ?? 200_000;
  const events = options.events;

  let consecutiveFailures = 0;

  return async (transcript) => {
    // Circuit breaker — matches legacy COMPACT_CIRCUIT_BREAKER_LIMIT.
    if (consecutiveFailures >= COMPACT_CIRCUIT_BREAKER_LIMIT) {
      return undefined;
    }

    // The Runner transcript carries an assistant/user/system mix that
    // maps 1:1 onto the KodaXMessage shape intelligentCompact expects.
    const messages = transcript as unknown as readonly KodaXMessage[];
    const mutableMessages = [...messages] as KodaXMessage[];
    const tokenEstimate = estimateTokens(mutableMessages);
    if (!needsCompaction(mutableMessages, compactionConfig, contextWindow, tokenEstimate)) {
      return undefined;
    }

    events?.onCompactStart?.();
    try {
      const result = await intelligentCompact(
        mutableMessages,
        compactionConfig,
        provider,
        contextWindow,
        undefined, // customInstructions — none for Runner-driven path
        undefined, // systemPrompt — provider carries its own system text
        tokenEstimate,
      );

      if (!result.compacted) {
        consecutiveFailures += 1;
        return undefined;
      }

      events?.onCompactStats?.({
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
      });
      events?.onCompact?.(result.tokensBefore);

      // M3 parity (v0.7.26) — post-compact file + artifact ledger
      // reinjection. Mirrors legacy `agent.ts:1740-1780`. When the
      // compaction result carries an `artifactLedger` (files the
      // assistant mutated or read), build the ledger summary + recent
      // file-content attachments and re-inject them into the compacted
      // transcript. Without this, long AMA sessions that hit compaction
      // lose critical file context (the summary keeps the task intent
      // but the post-mutation contents disappear).
      let compactedMessages = result.messages as readonly KodaXMessage[];
      let postCompactAttachments: readonly KodaXMessage[] | undefined;
      if (result.artifactLedger && result.artifactLedger.length > 0) {
        const freedTokens = Math.max(0, result.tokensBefore - result.tokensAfter);
        const attachments = buildPostCompactAttachments(
          result.artifactLedger,
          freedTokens,
        );
        const totalPostCompactBudget = Math.min(
          Math.floor(freedTokens * DEFAULT_POST_COMPACT_CONFIG.budgetRatio),
          POST_COMPACT_TOKEN_BUDGET,
        );
        const fileBudget = Math.max(0, totalPostCompactBudget - attachments.totalTokens);
        const fileMessages = fileBudget > 0
          ? await buildFileContentMessages(result.artifactLedger, fileBudget)
          : [];
        const fullAttachments = {
          ...attachments,
          fileMessages,
          totalTokens: attachments.totalTokens + estimateTokens(fileMessages as KodaXMessage[]),
        };
        if (fullAttachments.totalTokens > 0) {
          compactedMessages = injectPostCompactAttachments(
            compactedMessages as KodaXMessage[],
            fullAttachments,
          );
          postCompactAttachments = [
            ...(fullAttachments.ledgerMessage ? [fullAttachments.ledgerMessage] : []),
            ...fullAttachments.fileMessages,
          ];
        }
      }

      const compactionUpdate: CompactionUpdate | undefined = result.artifactLedger
        ? {
          anchor: result.anchor,
          artifactLedger: result.artifactLedger,
          memorySeed: result.memorySeed,
          postCompactAttachments,
        }
        : undefined;

      // F2 parity (v0.7.26) — fire `onCompactedMessages` after a
      // successful compaction so the REPL can refresh its local
      // transcript mirror (otherwise its cached `messages[]` still
      // points at the pre-compact array). Mirrors legacy
      // `agent.ts:1861`.
      events?.onCompactedMessages?.(compactedMessages as KodaXMessage[], compactionUpdate);

      // Reset the counter only when compaction produced a transcript
      // actually below the trigger. "Partial success" (same pruning
      // that left context above threshold) would otherwise never
      // backstop to degraded behaviour — matches legacy agent.ts:1810.
      const triggerTokens = contextWindow * (compactionConfig.triggerPercent / 100);
      if (result.tokensAfter < triggerTokens) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
      }

      return compactedMessages as readonly AgentMessage[];
    } catch {
      consecutiveFailures += 1;
      return undefined;
    } finally {
      events?.onCompactEnd?.();
    }
  };
}
