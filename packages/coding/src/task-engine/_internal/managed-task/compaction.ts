/**
 * Compaction hook for the Runner-driven path — v0.7.26 parity restore.
 *
 * Legacy `agent.ts` (v0.7.22) ran `intelligentCompact` before every
 * provider.stream call: check `needsCompaction` → fire
 * `onCompactStart` → call `intelligentCompact` → fire
 * `onCompactStats` / `onCompact` / `onCompactEnd` → replace local
 * messages with the compacted view. The Runner-driven rewrite dropped
 * this entire pipeline; AMA sessions that exceed the compaction
 * threshold hit context window overflow and provider 400s.
 *
 * This module provides a minimal faithful port:
 *   - loads compaction config from the repo root
 *   - tracks a per-run circuit breaker (same threshold as legacy)
 *   - delegates to `@kodax/agent/compact` for the actual summarisation
 *   - fires the legacy event surface (`onCompactStart` / `onCompactStats`
 *     / `onCompact` / `onCompactEnd`) so REPL can render its
 *     "compacting…" UI
 *
 * Post-compact artifact ledger + file content injection (legacy
 * `buildPostCompactAttachments` / `buildFileContentMessages` /
 * `injectPostCompactAttachments`) are intentionally deferred to a
 * follow-up: they require resolving artifact paths from mutation
 * tracker output and reading files with a token budget, which couples
 * tightly to the task-engine state that the Runner-driven path hasn't
 * surfaced yet. The base compaction prevents context-window overflow
 * immediately; the attachment enrichment is a later quality pass.
 */

import {
  compact as intelligentCompact,
  needsCompaction,
  type CompactionConfig,
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

      return result.messages as readonly AgentMessage[];
    } catch {
      consecutiveFailures += 1;
      return undefined;
    } finally {
      events?.onCompactEnd?.();
    }
  };
}
