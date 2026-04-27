/**
 * Provider retry / recovery substrate — CAP-031 + CAP-065 + CAP-069 + CAP-070
 *
 * Capability inventory:
 *   - docs/features/v0.7.29-capability-inventory.md#cap-031-transient-provider-retry-description
 *   - docs/features/v0.7.29-capability-inventory.md#cap-065-resilience-config--recovery-coordinator-construction
 *   - docs/features/v0.7.29-capability-inventory.md#cap-069-recovery-pipeline-classify--decide
 *   - docs/features/v0.7.29-capability-inventory.md#cap-070-abort-error-translation
 *
 * Class 1 (substrate). Four pieces of the per-stream retry pipeline:
 *
 *   - `describeTransientProviderRetry` (CAP-031, P2): error → human label
 *     for the retry banner (REPL + runner-driven both consume).
 *
 *   - `buildResilienceSession` (CAP-065, P3.2e): create the per-turn
 *     `ResilienceConfig` + `ProviderRecoveryCoordinator` pair. The
 *     coordinator is constructed fresh per turn so single-shot latches
 *     (e.g., sanitize-thinking-and-retry) reset cleanly. The tracker is
 *     supplied externally so it shares ownership with
 *     `BoundaryTrackerSession` (CAP-068).
 *
 *   - `translateAbortError` (CAP-070, P3.2e): if the caught error is
 *     an AbortError that was caused by the retry-timer abort (NOT by
 *     the caller's abortSignal), rewrite it into a transient
 *     `KodaXNetworkError` so the recovery pipeline treats it as a
 *     stalled-stream rather than a clean cancel. Async (dynamic import
 *     of `@kodax/ai`).
 *
 *   - `runRecoveryPipeline` (CAP-069, P3.2e): single per-attempt
 *     decision pass — classifyResilienceError → telemetryClassify →
 *     decideRecoveryAction → telemetryDecision → emit
 *     onProviderRecovery + (conditional) onRetry. Returns the decision
 *     so the caller branches on `decision.action` /
 *     `decision.shouldUseNonStreaming`.
 */

import type { KodaXBaseProvider } from '@kodax/ai';
import type { KodaXEvents } from '../types.js';
import {
  classifyResilienceError,
  resolveResilienceConfig,
  ProviderRecoveryCoordinator,
  type ProviderResilienceConfig,
  type RecoveryDecision,
  type ResilienceClassification,
} from '../resilience/index.js';
import { telemetryClassify, telemetryDecision } from '../resilience/telemetry.js';
import type { StableBoundaryTracker } from '../resilience/stable-boundary.js';

// ── CAP-031 ──────────────────────────────────────────────────────────────

export function describeTransientProviderRetry(error: Error): string {
  const message = error.message.toLowerCase();
  if (error.name === 'StreamIncompleteError' || message.includes('stream incomplete')) {
    return 'Stream interrupted before completion';
  }
  if (message.includes('stream stalled') || message.includes('delayed response') || message.includes('60s idle')) {
    return 'Stream stalled';
  }
  if (message.includes('hard timeout') || message.includes('10 minutes')) {
    return 'Provider response timed out';
  }
  if (
    message.includes('socket hang up')
    || message.includes('connection error')
    || message.includes('econnrefused')
    || message.includes('enotfound')
    || message.includes('fetch failed')
    || message.includes('network')
  ) {
    return 'Provider connection error';
  }
  if (message.includes('timed out') || message.includes('timeout') || message.includes('etimedout')) {
    return 'Provider request timed out';
  }
  if (message.includes('aborted')) {
    return 'Provider stream aborted';
  }
  return 'Transient provider error';
}

// ── CAP-065 ──────────────────────────────────────────────────────────────

export interface ResilienceSession {
  readonly resilienceCfg: Required<ProviderResilienceConfig>;
  readonly recoveryCoordinator: ProviderRecoveryCoordinator;
}

/**
 * Build the per-turn resilience session: resolve the
 * `ProviderResilienceConfig` for the current provider and construct a
 * fresh `ProviderRecoveryCoordinator` bound to the supplied tracker.
 *
 * The coordinator's single-shot latches (e.g.,
 * `sanitize-thinking-and-retry`) reset cleanly because each turn
 * builds a new session. Sharing the tracker with `BoundaryTrackerSession`
 * (CAP-068) is mandatory — `decideRecoveryAction` reads the same
 * tracker that stream-handler-wiring marks via `markX`, so passing a
 * different instance silently corrupts failure-stage classification.
 */
export function buildResilienceSession(
  providerName: string,
  streamProvider: KodaXBaseProvider,
  tracker: StableBoundaryTracker,
): ResilienceSession {
  const resilienceCfg = resolveResilienceConfig(providerName);
  const recoveryCoordinator = new ProviderRecoveryCoordinator(tracker, {
    ...resilienceCfg,
    enableNonStreamingFallback:
      resilienceCfg.enableNonStreamingFallback && streamProvider.supportsNonStreamingFallback(),
  });
  return { resilienceCfg, recoveryCoordinator };
}

// ── CAP-070 ──────────────────────────────────────────────────────────────

/**
 * Translate an `AbortError` caused by the retry timer (NOT by the
 * caller's abort signal) into a transient `KodaXNetworkError`. This
 * routes the recovery pipeline through the normal "stalled stream"
 * path rather than treating it as a clean user-cancel.
 *
 * If the error is not an AbortError, or if the caller's abort signal
 * fired (i.e. the user pressed Ctrl+C), the original error is returned
 * unchanged so the catch path can distinguish user-cancel from
 * timer-driven aborts.
 *
 * Async because `KodaXNetworkError` is loaded via dynamic import to
 * avoid pulling the full `@kodax/ai` error surface into the agent
 * substrate eagerly.
 */
export async function translateAbortError(
  error: Error,
  retryTimeoutController: AbortController,
  callerAbortSignal: AbortSignal | undefined,
): Promise<Error> {
  if (
    error.name === 'AbortError'
    && retryTimeoutController.signal.aborted
    && !callerAbortSignal?.aborted
  ) {
    const reason = (retryTimeoutController.signal.reason as Error | undefined)?.message ?? 'Stream stalled';
    const { KodaXNetworkError } = await import('@kodax/ai');
    return new KodaXNetworkError(reason, true);
  }
  return error;
}

// ── CAP-069 ──────────────────────────────────────────────────────────────

export interface RecoveryPipelineInput {
  readonly error: Error;
  readonly failureStage: ReturnType<StableBoundaryTracker['inferFailureStage']>;
  readonly attempt: number;
  readonly events: KodaXEvents;
  readonly resilienceCfg: Required<ProviderResilienceConfig>;
  readonly recoveryCoordinator: ProviderRecoveryCoordinator;
}

export interface RecoveryPipelineResult {
  readonly classified: ResilienceClassification;
  readonly decision: RecoveryDecision;
}

/**
 * Per-attempt recovery decision pass. Runs the 4-step pipeline:
 *
 *   1. `classifyResilienceError(error, failureStage)` →
 *      `telemetryClassify`
 *   2. `recoveryCoordinator.decideRecoveryAction(...)` →
 *      `telemetryDecision`
 *   3. Emit `events.onProviderRecovery` (always, when defined)
 *   4. Emit `events.onRetry` ONLY when there is no
 *      `onProviderRecovery` listener AND the decision is not
 *      `manual_continue` (the legacy fallback banner — `onProviderRecovery`
 *      supersedes it for hosts that handle the richer event)
 *
 * Returns the classified error + decision so the caller can branch on
 * `decision.action` / `decision.shouldUseNonStreaming` /
 * `decision.delayMs`.
 */
export function runRecoveryPipeline(
  input: RecoveryPipelineInput,
): RecoveryPipelineResult {
  const classified = classifyResilienceError(input.error, input.failureStage);
  telemetryClassify(input.error, classified);
  const decision = input.recoveryCoordinator.decideRecoveryAction(
    input.error,
    classified,
    input.attempt,
  );
  telemetryDecision(decision, input.attempt);

  input.events.onProviderRecovery?.({
    stage: decision.failureStage,
    errorClass: decision.reasonCode,
    attempt: input.attempt,
    maxAttempts: input.resilienceCfg.maxRetries,
    delayMs: decision.delayMs,
    recoveryAction: decision.action,
    ladderStep: decision.ladderStep,
    fallbackUsed: decision.shouldUseNonStreaming,
    serverRetryAfterMs: decision.serverRetryAfterMs,
  });

  if (!input.events.onProviderRecovery && decision.action !== 'manual_continue') {
    input.events.onRetry?.(
      `${describeTransientProviderRetry(input.error)} · retry ${input.attempt}/${input.resilienceCfg.maxRetries} in ${Math.round(decision.delayMs / 1000)}s`,
      input.attempt,
      input.resilienceCfg.maxRetries,
    );
  }

  return { classified, decision };
}
