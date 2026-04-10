/**
 * KodaX Resilience Debug Telemetry (Feature 045)
 *
 * Outputs detailed recovery information when debug mode is enabled.
 * Enable via environment variables:
 *   KODAX_DEBUG_STREAM=1
 *   KODAX_DEBUG_RESILIENCE=1
 */

import type {
  ResilienceClassification,
  RecoveryDecision,
  ProviderExecutionState,
} from './types.js';

// ============== Debug Check ==============

const DEBUG_ENABLED =
  process.env.KODAX_DEBUG_STREAM === '1' ||
  process.env.KODAX_DEBUG_RESILIENCE === '1';

// ============== Telemetry Functions ==============

/**
 * Logs a resilience classification event.
 */
export function telemetryClassify(
  error: Error,
  classified: ResilienceClassification,
): void {
  if (!DEBUG_ENABLED) return;

  console.error('[resilience:classify]', {
    rawError: error.message,
    errorClass: classified.errorClass,
    failureStage: classified.failureStage,
    retryable: classified.retryable,
    maxRetries: classified.maxRetries,
  });
}

/**
 * Logs a recovery decision.
 */
export function telemetryDecision(
  decision: RecoveryDecision,
  attempt: number,
): void {
  if (!DEBUG_ENABLED) return;

  console.error('[resilience:decision]', {
    action: decision.action,
    ladderStep: decision.ladderStep,
    attempt,
    delayMs: decision.delayMs,
    maxDelayMs: decision.maxDelayMs,
    reasonCode: decision.reasonCode,
    failureStage: decision.failureStage,
    shouldUseNonStreaming: decision.shouldUseNonStreaming,
    serverRetryAfterMs: decision.serverRetryAfterMs,
  });
}

/**
 * Logs the stable boundary snapshot.
 */
export function telemetryBoundary(
  state: Readonly<ProviderExecutionState>,
): void {
  if (!DEBUG_ENABLED) return;

  console.error('[resilience:boundary]', {
    requestId: state.requestId,
    provider: state.provider,
    attempt: state.attempt,
    lastStableMessageIndex: state.lastStableMessageIndex,
    executedToolCallIds: state.executedToolCallIds,
    pendingToolCallIds: state.pendingToolCallIds,
    visibleLiveTextLength: state.visibleLiveTextLength,
    visibleThinkingLength: state.visibleThinkingLength,
    fallbackUsed: state.fallbackUsed,
    failureStage: state.failureStage,
  });
}

/**
 * Logs a recovery execution.
 */
export function telemetryRecovery(
  action: string,
  result: {
    droppedToolCallIds: string[];
    executedToolCallIds: string[];
    fallbackUsed: boolean;
  },
): void {
  if (!DEBUG_ENABLED) return;

  console.error('[resilience:recovery]', {
    action,
    droppedToolCallIds: result.droppedToolCallIds,
    executedToolCallIds: result.executedToolCallIds,
    fallbackUsed: result.fallbackUsed,
  });
}
