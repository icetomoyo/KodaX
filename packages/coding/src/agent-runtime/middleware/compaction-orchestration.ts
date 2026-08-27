/**
 * Compaction lifecycle orchestration — CAP-060 + CAP-062 + CAP-063
 *
 * Capability inventory:
 *   - docs/features/v0.7.29-capability-inventory.md#cap-060-compaction-lifecycle-orchestration-intelligentcompact--circuit-breaker--events
 *   - docs/features/v0.7.29-capability-inventory.md#cap-062-graceful-compact-degradation-gating
 *   - docs/features/v0.7.29-capability-inventory.md#cap-063-pre-stream-validateandfixtoolhistory--oncompactedmessages-emission
 *
 * Current contract: default compaction is physical-capacity-driven and gives
 * the semantic summarizer complete evidence. Hard pressure may bypass
 * cooldown while the breaker is closed; an open breaker returns typed
 * capacity without another summary. A first still-over compacted transcript
 * commits best-effort with a `stillOverCapacity` flag (FEATURE_296).
 * Deterministic destructive pruning is an explicit legacy opt-in only.
 *
 * Class 1 (substrate). Three sequential phases of the compaction
 * lifecycle:
 *
 *   1. **`tryIntelligentCompact` (CAP-060)** — Runs `intelligentCompact`
 *      under a try/catch/finally with the four lifecycle events
 *      (`onCompactStart` / `onCompactStats` / `onCompact` / `onCompactEnd`),
 *      delegates post-compact attachment construction to CAP-061
 *      (`applyPostCompactAttachments`), and accounts for the circuit
 *      breaker counter:
 *      - SUCCESS that drops below trigger → reset counter to 0
 *      - PARTIAL SUCCESS still over trigger → increment counter
 *      - LLM threw → increment counter; fall through to graceful
 *      - CIRCUIT BREAKER TRIPPED (counter ≥ limit) → skip LLM, return
 *        identity so graceful degradation runs unconditionally
 *
 *   2. **`applyGracefulDegradationGate` (CAP-062)** — When
 *      `needsCompact` is true AND `estimateTokens(compacted) >
 *      triggerTokens × pruningGapRatio`, runs the deterministic
 *      `gracefulCompactDegradation` (CAP-028) and emits
 *      `onCompactStats` / `onCompact` if it actually pruned. Catches
 *      three branches:
 *      a. LLM threw (compacted === messages from catch)
 *      b. Circuit breaker tripped (else branch entered with no
 *         compacted-vs-messages diff)
 *      c. LLM partial success that left context still too high
 *
 *   3. **`commitCompactedHistory` (CAP-063)** — Always runs
 *      `validateAndFixToolHistory` (CAP-002) on the post-compaction
 *      messages, commits via `messages = compacted`, and emits
 *      `onCompactedMessages` only when `didCompactMessages` is true.
 *      Returns a fresh `contextTokenSnapshot` only when compaction
 *      actually fired (caller keeps the existing snapshot otherwise).
 *
 * **`runCompactionLifecycle`** is the umbrella that composes all three
 * for the agent.ts call site.
 *
 * Migration history: extracted from `agent.ts:605-744` — pre-FEATURE_100
 * baseline — during FEATURE_100 P3.4c.
 */

import type {
  KodaXBaseProvider,
  KodaXMessage,
  KodaXReasoningRequest,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import {
  ContextCapacityError,
  compact as intelligentCompact,
  emitKodaXDiagnostic,
  exceedsContextCapacity,
  needsCompaction,
  reclaimReservedResponseTokens,
  type CompactionConfig,
  type CompactionUpdate,
} from '@kodax-ai/agent';
import {
  CODING_SUMMARY_PROMPT,
  CODING_UPDATE_SUMMARY_PROMPT,
} from '../coding-compaction-prompts.js';
import type { KodaXContextTokenSnapshot, KodaXEvents } from '../../types.js';
import { estimateTokens } from '../../tokenizer.js';
import { validateAndFixToolHistory } from '@kodax-ai/agent';
import { gracefulCompactDegradation } from '@kodax-ai/agent';
import { applyPostCompactAttachments } from './post-compact-attachments.js';
import { createCompactionPromptCacheObserver } from '../prompt-cache-diagnostics.js';
import {
  consumeCompactionCooldown,
  createCompactionAntiThrashState,
  recordCompactionSavings,
  shouldSkipLlmCompaction,
  type CompactionAntiThrashConfig,
  type CompactionAntiThrashState,
} from './compaction-pressure.js';
import { hasIrreducibleUserInput } from '../../capacity-recovery.js';

export const COMPACT_CIRCUIT_BREAKER_LIMIT = 3;

// ---------------------------------------------------------------------------
// CAP-060 — tryIntelligentCompact
// ---------------------------------------------------------------------------

export interface TryIntelligentCompactInput {
  readonly messages: KodaXMessage[];
  readonly needsCompact: boolean;
  readonly compactConsecutiveFailures: number;
  readonly compactionConfig: CompactionConfig;
  readonly provider: KodaXBaseProvider;
  readonly model?: string;
  readonly contextId?: string;
  readonly contextKind?: 'root' | 'child';
  readonly parentContextId?: string;
  readonly agentId?: string;
  readonly contextWindow: number;
  readonly systemPrompt: string;
  readonly toolDefinitions?: readonly KodaXToolDefinition[];
  readonly reasoning?: boolean | KodaXReasoningRequest;
  readonly currentTokens: number;
  readonly reservedResponseTokens?: number;
  readonly events: KodaXEvents;
  readonly compactionAntiThrash?: CompactionAntiThrashState;
  readonly compactionAntiThrashConfig?: CompactionAntiThrashConfig;
  readonly emitCompactionDiagnostics?: boolean;
  readonly disablePromptCache?: boolean;
  /** Opaque Provider cache-routing key inherited from the logical context. */
  readonly promptCacheKey?: string;
  /** Defaults to {@link COMPACT_CIRCUIT_BREAKER_LIMIT}; tests may override. */
  readonly circuitBreakerLimit?: number;
}

export interface TryIntelligentCompactOutput {
  readonly compacted: KodaXMessage[];
  readonly compactionUpdate: CompactionUpdate | undefined;
  readonly didCompactMessages: boolean;
  readonly nextCompactConsecutiveFailures: number;
  readonly nextCompactionAntiThrash: CompactionAntiThrashState;
}

/**
 * CAP-060: semantic compaction with circuit-breaker and lifecycle events.
 * Breaker/cooldown skips apply only to optional early compaction. Hard
 * physical pressure may bypass cooldown until the breaker limit, then ends
 * with typed capacity instead of retrying the summarizer without a bound.
 */
export async function tryIntelligentCompact(
  input: TryIntelligentCompactInput,
): Promise<TryIntelligentCompactOutput> {
  const limit = input.circuitBreakerLimit ?? COMPACT_CIRCUIT_BREAKER_LIMIT;
  const circuitBreakerTripped = input.compactConsecutiveFailures >= limit;
  const antiThrash = input.compactionAntiThrash ?? createCompactionAntiThrashState();
  const requiresCapacityRelief = exceedsContextCapacity({
    contextWindow: input.contextWindow,
    currentTokens: input.currentTokens,
    reservedResponseTokens: input.reservedResponseTokens,
  });
  const hasIrreducibleInput = hasIrreducibleUserInput(
    input.messages,
    input.contextWindow,
  );

  if (circuitBreakerTripped && requiresCapacityRelief && !hasIrreducibleInput) {
    throw new ContextCapacityError({
      contextWindow: input.contextWindow,
      currentTokens: input.currentTokens,
      reservedResponseTokens: input.reservedResponseTokens,
    }, 'History compaction');
  }

  if (!input.needsCompact || (circuitBreakerTripped && !requiresCapacityRelief)) {
    return {
      compacted: input.messages,
      compactionUpdate: undefined,
      didCompactMessages: false,
      nextCompactConsecutiveFailures: input.compactConsecutiveFailures,
      nextCompactionAntiThrash: antiThrash,
    };
  }

  if (shouldSkipLlmCompaction(antiThrash, input.currentTokens) && !requiresCapacityRelief) {
    const nextAntiThrash = consumeCompactionCooldown(antiThrash);
    input.events.onContextCompactionSkipped?.({
      ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
      ...(input.contextKind !== undefined ? { contextKind: input.contextKind } : {}),
      ...(input.parentContextId !== undefined
        ? { parentContextId: input.parentContextId }
        : {}),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      reason: antiThrash.cooldownTurnsRemaining > 0
        ? 'low_savings_cooldown'
        : 'covered_context_unchanged',
      currentTokens: input.currentTokens,
      contextWindow: input.contextWindow,
      triggerPercent: input.compactionConfig.triggerPercent,
      cooldownTurnsRemaining: nextAntiThrash.cooldownTurnsRemaining,
      lowSavingsStreak: nextAntiThrash.lowSavingsStreak,
    });
    return {
      compacted: input.messages,
      compactionUpdate: undefined,
      didCompactMessages: false,
      nextCompactConsecutiveFailures: input.compactConsecutiveFailures,
      nextCompactionAntiThrash: nextAntiThrash,
    };
  }

  let compacted: KodaXMessage[] = input.messages;
  let compactionUpdate: CompactionUpdate | undefined;
  let didCompactMessages = false;
  let nextFailures = input.compactConsecutiveFailures;
  let nextCompactionAntiThrash = antiThrash;

  input.events.onCompactStart?.();
  try {
    const compactionObserver = input.emitCompactionDiagnostics === true
      ? createCompactionPromptCacheObserver({
          events: input.events,
          enabled: true,
          provider: input.provider,
          providerName: input.provider.name,
          ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
          ...(input.contextKind !== undefined ? { contextKind: input.contextKind } : {}),
          ...(input.parentContextId !== undefined
            ? { parentContextId: input.parentContextId }
            : {}),
          ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
          model: input.model ?? input.provider.getModel(),
          disablePromptCache: input.disablePromptCache,
        })
      : undefined;
    const result = await intelligentCompact(
      input.messages,
      input.compactionConfig,
      input.provider,
      input.contextWindow,
      undefined, // customInstructions
      input.systemPrompt,
      input.currentTokens,
      CODING_SUMMARY_PROMPT,
      CODING_UPDATE_SUMMARY_PROMPT,
      input.model,
      false,
      input.reservedResponseTokens,
      input.toolDefinitions
        ? {
            tools: input.toolDefinitions,
            reasoning: input.reasoning,
          }
        : undefined,
      compactionObserver,
      input.promptCacheKey !== undefined
        ? { promptCacheKey: input.promptCacheKey }
        : undefined,
    );

    if (result.compacted) {
      compacted = result.messages;

      // CAP-061: post-compact attachment construction + injection.
      // FEATURE_072: `postCompactAttachmentsForLineage` is also routed
      // via `compactionUpdate.postCompactAttachments` for REPL-side
      // native storage on the CompactionEntry.
      const semanticCompacted = compacted;
      let postCompactAttachmentsForLineage: readonly KodaXMessage[] = [];
      if (result.artifactLedger && result.artifactLedger.length > 0) {
        const attached = await applyPostCompactAttachments({
          compacted,
          artifactLedger: result.artifactLedger,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
        });
        compacted = attached.compacted;
        postCompactAttachmentsForLineage = attached.postCompactAttachmentsForLineage;
        const fixedOverheadTokens = Math.max(
          0,
          input.currentTokens - estimateTokens(input.messages),
        );
        if (exceedsContextCapacity({
          contextWindow: input.contextWindow,
          currentTokens: fixedOverheadTokens + estimateTokens(compacted),
          reservedResponseTokens: input.reservedResponseTokens,
        })) {
          compacted = semanticCompacted;
          postCompactAttachmentsForLineage = [];
        }
      }

      didCompactMessages = true;
      // Only reset the counter when compaction actually reduced
      // context below trigger. "Partial success" (pruning only with
      // silent summary failure) would otherwise keep the counter at
      // zero forever and prevent graceful degradation from ever running.
      const fixedOverheadTokens = Math.max(
        0,
        input.currentTokens - estimateTokens(input.messages),
      );
      const postCompactTokens = fixedOverheadTokens + estimateTokens(compacted);
      const savings = recordCompactionSavings(
        antiThrash,
        {
          tokensBefore: input.currentTokens,
          tokensAfter: postCompactTokens,
        },
        input.compactionAntiThrashConfig,
      );
      nextCompactionAntiThrash = savings.state;

      // Compaction observability reaches every output mode through the
      // lifecycle events emitted below (`onCompactStats` / `onCompact`): the
      // Ink TUI renders an inline "Context auto-compacted" notice, the plain
      // CLI prints a dim line, and `--json` emits a `compact.finish` record.
      // This raw diagnostic trace is debug-only, gated behind
      // `KODAX_DEBUG_COMPACTION`. Real compaction failures below are reported
      // unconditionally through diagnostics. Rationale: the REPL
      // renderer runs with `patchConsole: false`, so a bare `console.*` write
      // bypasses the render engine, lands below the live region, and desyncs
      // the cell frame — corrupting the interactive screen.
      if (process.env.KODAX_DEBUG_COMPACTION) {
        emitKodaXDiagnostic({
          source: 'coding:compaction',
          level: 'debug',
          message: 'Compaction triggered.',
          detail: {
            contextWindow: input.contextWindow,
            triggerPercent: input.compactionConfig.triggerPercent,
            capacityDriven: requiresCapacityRelief,
            tokensBefore: input.currentTokens,
            tokensAfter: postCompactTokens,
            reduction: input.currentTokens - postCompactTokens,
          },
        });
      }
      if (savings.enteredCooldown && process.env.KODAX_DEBUG_COMPACTION) {
        emitKodaXDiagnostic({
          source: 'coding:compaction',
          level: 'debug',
          message: 'Compaction low-savings cooldown entered.',
          detail: {
            savingsRatio: savings.savingsRatio,
            cooldownTurnsRemaining: savings.state.cooldownTurnsRemaining,
          },
        });
      }
      if (!needsCompaction(
        compacted,
        input.compactionConfig,
        input.contextWindow,
        postCompactTokens,
        input.reservedResponseTokens,
      )) {
        nextFailures = 0;
      } else if (hasIrreducibleInput) {
        // A fresh request that is larger than the model window cannot be
        // repaired by summarizing history. The request-copy degradation rung
        // owns it, so it must not consume or trip the summarizer breaker.
        nextFailures = 0;
      } else {
        // Counter increment is load-bearing (drives the circuit breaker) and
        // stays unconditional; only the diagnostic line is debug-gated.
        nextFailures = input.compactConsecutiveFailures + 1;
        if (process.env.KODAX_DEBUG_COMPACTION) {
          emitKodaXDiagnostic({
            source: 'coding:compaction',
            level: 'debug',
            message: 'Compaction partial success remained above trigger.',
            detail: {
              postCompactTokens,
              capacityDriven: requiresCapacityRelief,
              attempt: nextFailures,
              limit,
            },
          });
        }
      }

      compactionUpdate = {
        preCompactionMessages: input.messages,
        anchor: result.anchor
          ? { ...result.anchor, tokensAfter: postCompactTokens }
          : undefined,
        artifactLedger: result.artifactLedger,
        memorySeed: result.memorySeed,
        report: result.report,
        postCompactAttachments:
          postCompactAttachmentsForLineage.length > 0
            ? postCompactAttachmentsForLineage
            : undefined,
      };
      input.events.onCompactStats?.({
        tokensBefore: input.currentTokens,
        tokensAfter: postCompactTokens,
      });
      input.events.onCompact?.(postCompactTokens);
    } else {
      compacted = result.messages;
    }
  } catch (error) {
    if (
      error instanceof ContextCapacityError
      && !hasIrreducibleInput
    ) {
      throw error;
    }
    // Error is handled, not swallowed: the counter increment drives the
    // circuit breaker and we fall through to deterministic graceful
    // degradation below. Report the real failure through diagnostics; raw
    // console output remains forbidden because it can corrupt Ink rendering.
    nextFailures = error instanceof ContextCapacityError && hasIrreducibleInput
      ? 0
      : input.compactConsecutiveFailures + 1;
    emitKodaXDiagnostic({
      source: 'coding:compaction',
      level: 'error',
      message: `Compaction LLM summary failed (attempt ${nextFailures}/${limit}).`,
      detail: error,
    });
    // Fall through to graceful degradation: return messages identity.
    compacted = input.messages;
  } finally {
    input.events.onCompactEnd?.();
  }

  return {
    compacted,
    compactionUpdate,
    didCompactMessages,
    nextCompactConsecutiveFailures: nextFailures,
    nextCompactionAntiThrash,
  };
}

// ---------------------------------------------------------------------------
// CAP-062 — applyGracefulDegradationGate
// ---------------------------------------------------------------------------

export interface GracefulDegradationGateInput {
  readonly compacted: KodaXMessage[];
  readonly needsCompact: boolean;
  readonly contextWindow: number;
  readonly compactionConfig: CompactionConfig;
  readonly currentTokens: number;
  readonly fixedOverheadTokens?: number;
  readonly reservedResponseTokens?: number;
  readonly events: KodaXEvents;
}

export interface GracefulDegradationGateOutput {
  readonly compacted: KodaXMessage[];
  readonly didCompactMessages: boolean;
}

/**
 * Current CAP-062 contract: default no-op. Explicit legacy deterministic
 * pruning can run only when `pruningThresholdTokens` is configured and the
 * complete request remains physically over capacity.
 */
export function applyGracefulDegradationGate(
  input: GracefulDegradationGateInput,
): GracefulDegradationGateOutput {
  if (!input.needsCompact) {
    return { compacted: input.compacted, didCompactMessages: false };
  }
  if (input.compactionConfig.pruningThresholdTokens === undefined) {
    return { compacted: input.compacted, didCompactMessages: false };
  }
  const fixedOverheadTokens = input.fixedOverheadTokens ?? Math.max(
    0,
    input.currentTokens - estimateTokens(input.compacted),
  );
  const candidateTokens = fixedOverheadTokens + estimateTokens(input.compacted);
  if (!exceedsContextCapacity({
    contextWindow: input.contextWindow,
    currentTokens: candidateTokens,
    reservedResponseTokens: input.reservedResponseTokens,
  })) {
    return { compacted: input.compacted, didCompactMessages: false };
  }
  const degraded = gracefulCompactDegradation(
    input.compacted,
    input.contextWindow,
    input.compactionConfig,
    {
      fixedOverheadTokens,
      reservedResponseTokens: input.reservedResponseTokens,
    },
  );
  if (degraded === input.compacted) {
    return { compacted: input.compacted, didCompactMessages: false };
  }
  // A fresh array is only a candidate. Validate real reduction and physical
  // sendability before surfacing success or committing replacement history.
  const tokensBeforeFallback = estimateTokens(input.compacted);
  const degradedTokens = estimateTokens(degraded);
  const tokensAfter = fixedOverheadTokens + degradedTokens;
  const fitsPhysicalCapacity = !exceedsContextCapacity({
    contextWindow: input.contextWindow,
    currentTokens: tokensAfter,
    reservedResponseTokens: input.reservedResponseTokens,
  });
  if (degradedTokens >= tokensBeforeFallback || !fitsPhysicalCapacity) {
    return { compacted: input.compacted, didCompactMessages: false };
  }
  // Valid pruning happened — emit and surface didCompactMessages so commit
  // step (CAP-063) fires `onCompactedMessages`.
  input.events.onCompactStats?.({
    tokensBefore: input.currentTokens,
    tokensAfter,
  });
  input.events.onCompact?.(tokensAfter);
  return { compacted: degraded, didCompactMessages: true };
}

// ---------------------------------------------------------------------------
// CAP-063 — commitCompactedHistory
// ---------------------------------------------------------------------------

export interface CommitCompactedHistoryInput {
  readonly compacted: KodaXMessage[];
  readonly didCompactMessages: boolean;
  readonly compactionUpdate: CompactionUpdate | undefined;
  readonly events: KodaXEvents;
  readonly physicalTokensAfter?: number;
  readonly tokensBefore?: number;
  readonly elapsedMs?: number;
  readonly source?: 'automatic_threshold' | 'physical_capacity';
}

export interface CommitCompactedHistoryOutput {
  readonly messages: KodaXMessage[];
  /**
   * New snapshot when compaction fired this turn; `undefined` when
   * nothing changed so the caller keeps its existing snapshot.
   */
  readonly contextTokenSnapshot: KodaXContextTokenSnapshot | undefined;
}

/**
 * CAP-063: pre-stream `validateAndFixToolHistory` + `onCompactedMessages`
 * emission. Always validates the post-compaction history (orphan
 * tool_uses removed via CAP-002), commits via the returned `messages`,
 * and emits `onCompactedMessages` only when compaction fired.
 */
export async function commitCompactedHistory(
  input: CommitCompactedHistoryInput,
): Promise<CommitCompactedHistoryOutput> {
  // Always validate before sending to API — prevents "tool_call_id
  // is not found" errors caused by corrupted history.
  const validated = validateAndFixToolHistory(input.compacted);
  if (!input.didCompactMessages) {
    return { messages: validated, contextTokenSnapshot: undefined };
  }
  const compactedEstimate = estimateTokens(input.compacted);
  const validatedEstimate = estimateTokens(validated);
  const snapshot: KodaXContextTokenSnapshot = {
    currentTokens: Math.max(
      0,
      Math.round(
        (input.physicalTokensAfter ?? compactedEstimate)
          + validatedEstimate
          - compactedEstimate,
      ),
    ),
    baselineEstimatedTokens: validatedEstimate,
    source: 'estimate',
  };
  await input.events.onCompactedMessages?.(validated, input.compactionUpdate);
  const report = input.compactionUpdate?.report;
  if (input.tokensBefore !== undefined && input.elapsedMs !== undefined) {
    input.events.onContextCompactionFinished?.({
      source: input.source ?? (report?.triggerSource === 'physical_capacity'
        ? 'physical_capacity'
        : 'automatic_threshold'),
      tokensBefore: input.tokensBefore,
      tokensAfter: snapshot.currentTokens,
      committed: true,
      elapsedMs: input.elapsedMs,
      ...(report ?? {}),
    });
  }
  return { messages: validated, contextTokenSnapshot: snapshot };
}

// ---------------------------------------------------------------------------
// Umbrella — runCompactionLifecycle
// ---------------------------------------------------------------------------

export interface CompactionLifecycleInput {
  readonly messages: KodaXMessage[];
  readonly needsCompact: boolean;
  readonly compactConsecutiveFailures: number;
  readonly compactionConfig: CompactionConfig;
  readonly provider: KodaXBaseProvider;
  readonly model?: string;
  readonly contextId?: string;
  readonly contextKind?: 'root' | 'child';
  readonly parentContextId?: string;
  readonly agentId?: string;
  readonly contextWindow: number;
  readonly systemPrompt: string;
  readonly toolDefinitions?: readonly KodaXToolDefinition[];
  readonly reasoning?: boolean | KodaXReasoningRequest;
  readonly currentTokens: number;
  readonly reservedResponseTokens?: number;
  readonly events: KodaXEvents;
  readonly compactionAntiThrash?: CompactionAntiThrashState;
  readonly compactionAntiThrashConfig?: CompactionAntiThrashConfig;
  readonly emitCompactionDiagnostics?: boolean;
  readonly disablePromptCache?: boolean;
  /** Opaque Provider cache-routing key inherited from the logical context. */
  readonly promptCacheKey?: string;
  readonly circuitBreakerLimit?: number;
}

export interface CompactionLifecycleOutput {
  readonly messages: KodaXMessage[];
  readonly compactionUpdate: CompactionUpdate | undefined;
  readonly didCompactMessages: boolean;
  readonly nextCompactConsecutiveFailures: number;
  readonly nextCompactionAntiThrash: CompactionAntiThrashState;
  /**
   * Fresh snapshot when compaction fired; `undefined` otherwise so
   * the caller keeps its existing per-turn snapshot.
   */
  readonly contextTokenSnapshot: KodaXContextTokenSnapshot | undefined;
  /**
   * FEATURE_296 (ADR-067): the compacted transcript exceeds the physical
   * next-request budget even at the floor-bounded shrunk reserve (T3); it is
   * committed best-effort and the recovery ladder owns the next request
   * instead of aborting the run.
   */
  readonly stillOverCapacity?: boolean;
}

/**
 * Compose the three compaction phases into one call. The current default is
 * semantic summary, no-op legacy degradation, then validated commit. A final
 * physical-capacity check reports a still-over compacted transcript as
 * `stillOverCapacity` (FEATURE_296) instead of aborting the run.
 * Phase ordering is load-bearing:
 *   1. `tryIntelligentCompact` — LLM compact (or skip on circuit
 *      breaker / `!needsCompact`)
 *   2. `applyGracefulDegradationGate` — deterministic prune fallback
 *      (handles all three "still too big" cases)
 *   3. `commitCompactedHistory` — validate + commit + event emission
 */
export async function runCompactionLifecycle(
  input: CompactionLifecycleInput,
): Promise<CompactionLifecycleOutput> {
  const startedAt = Date.now();
  const llmPhase = await tryIntelligentCompact({
    messages: input.messages,
    needsCompact: input.needsCompact,
    compactConsecutiveFailures: input.compactConsecutiveFailures,
    compactionConfig: input.compactionConfig,
    provider: input.provider,
    model: input.model,
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
    ...(input.contextKind !== undefined ? { contextKind: input.contextKind } : {}),
    ...(input.parentContextId !== undefined
      ? { parentContextId: input.parentContextId }
      : {}),
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    contextWindow: input.contextWindow,
    systemPrompt: input.systemPrompt,
    toolDefinitions: input.toolDefinitions,
    reasoning: input.reasoning,
    currentTokens: input.currentTokens,
    reservedResponseTokens: input.reservedResponseTokens,
    events: input.events,
    compactionAntiThrash: input.compactionAntiThrash,
    compactionAntiThrashConfig: input.compactionAntiThrashConfig,
    emitCompactionDiagnostics: input.emitCompactionDiagnostics,
    disablePromptCache: input.disablePromptCache,
    promptCacheKey: input.promptCacheKey,
    circuitBreakerLimit: input.circuitBreakerLimit,
  });
  const degradationPhase = applyGracefulDegradationGate({
    compacted: llmPhase.compacted,
    needsCompact: input.needsCompact,
    contextWindow: input.contextWindow,
    compactionConfig: input.compactionConfig,
    currentTokens: input.currentTokens,
    fixedOverheadTokens: Math.max(
      0,
      input.currentTokens - estimateTokens(input.messages),
    ),
    reservedResponseTokens: input.reservedResponseTokens,
    events: input.events,
  });
  const didCompactMessages =
    llmPhase.didCompactMessages || degradationPhase.didCompactMessages;
  const physicalTokensAfter = Math.max(
    0,
    input.currentTokens - estimateTokens(input.messages),
  ) + estimateTokens(degradationPhase.compacted);
  // FEATURE_296 T3: judge against the floor-bounded shrunk reserve first —
  // a reclaimable escalation reserve is relief, not debt.
  const stillOverCapacity = exceedsContextCapacity({
    contextWindow: input.contextWindow,
    currentTokens: physicalTokensAfter,
    reservedResponseTokens: reclaimReservedResponseTokens({
      contextWindow: input.contextWindow,
      currentTokens: physicalTokensAfter,
      reservedResponseTokens: input.reservedResponseTokens,
    }),
  });
  if (stillOverCapacity) {
    // FEATURE_296 (ADR-067): a still-over compacted transcript commits
    // best-effort (no larger than the pre-compaction transcript); the
    // recovery ladder owns the next request instead of aborting the run.
    emitKodaXDiagnostic({
      source: 'coding:compaction-orchestration',
      level: 'error',
      message:
        `Compacted history still requires ${physicalTokensAfter} tokens against the `
        + `${input.contextWindow}-token window; the recovery ladder must relieve `
        + `capacity before the next request.`,
    });
  }
  const compactionUpdate = didCompactMessages
    ? {
        ...(llmPhase.compactionUpdate ?? {}),
        preCompactionMessages: input.messages,
      }
    : undefined;
  const commitPhase = await commitCompactedHistory({
    compacted: degradationPhase.compacted,
    didCompactMessages,
    compactionUpdate,
    events: input.events,
    physicalTokensAfter,
    tokensBefore: input.currentTokens,
    elapsedMs: Date.now() - startedAt,
    source: exceedsContextCapacity({
      contextWindow: input.contextWindow,
      currentTokens: input.currentTokens,
      reservedResponseTokens: input.reservedResponseTokens,
    })
      ? 'physical_capacity'
      : 'automatic_threshold',
  });
  return {
    messages: commitPhase.messages,
    compactionUpdate,
    didCompactMessages,
    nextCompactConsecutiveFailures: llmPhase.nextCompactConsecutiveFailures,
    nextCompactionAntiThrash: llmPhase.nextCompactionAntiThrash,
    contextTokenSnapshot: commitPhase.contextTokenSnapshot,
    ...(stillOverCapacity ? { stillOverCapacity: true } : {}),
  };
}
