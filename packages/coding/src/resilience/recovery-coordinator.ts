/**
 * KodaX Recovery Coordinator (Feature 045)
 *
 * Orchestrates the 4-step recovery ladder:
 * 1. Fresh connection retry — retry with same messages (pre-delta failures)
 * 2. Stable boundary retry — reconstruct from stable boundary (mid-stream failures)
 * 3. Non-streaming fallback — switch to non-streaming mode
 * 4. Manual continue — stop and ask user for intervention
 */

import type {
  KodaXMessage,
  KodaXContentBlock,
  KodaXThinkingBlock,
  KodaXRedactedThinkingBlock,
} from '@kodax/ai';
import type {
  ResilienceClassification,
  RecoveryAction,
  RecoveryLadderStep,
  RecoveryDecision,
  RecoveryResult,
  ProviderResilienceConfig,
  FailureStage,
} from './types.js';
import { StableBoundaryTracker } from './stable-boundary.js';
import { reconstructMessagesWithToolGuard } from './tool-guard.js';

// ============== Constants ==============

/** Stages that should use fresh connection retry (same messages). */
const PRE_DELTA_STAGES: FailureStage[] = [
  'before_request_accepted',
  'before_first_delta',
];

/** Error classes that can benefit from non-streaming fallback.
 *
 * `connection_failure` (undici `TypeError: terminated`) is included because
 * mid-stream RST from weak providers (notably zhipu-coding) reproducibly
 * happens at the text → tool_use transition: the server buffers a large
 * tool_use input before streaming it, and some link in the chain kills the
 * idle TCP connection during that buffering window. The non-streaming
 * `/v1/messages` path has no such intermediate window — the server computes
 * the full response internally and returns it as a single HTTP body, so
 * switching to it on repeated terminations frequently salvages the turn. */
const STREAMING_ERROR_CLASSES: ResilienceClassification['errorClass'][] = [
  'stream_idle_timeout',
  'chunk_timeout',
  'incomplete_stream',
  'connection_failure',
];

// ============== Coordinator ==============

export class ProviderRecoveryCoordinator {
  private readonly config: Required<ProviderResilienceConfig>;
  private nonStreamingFallbackUsed = false;
  // Single-shot guard for thinking sanitisation. The first
  // `reasoning_content_required` 400 triggers a sanitize-and-retry; if
  // the retry hits the same error class again we fall through to
  // manual_continue rather than loop. v0.7.28.
  private thinkingSanitizationUsed = false;

  constructor(
    private readonly boundaryTracker: StableBoundaryTracker,
    config: ProviderResilienceConfig,
  ) {
    // Resolve config with defaults
    this.config = {
      requestTimeoutMs: config.requestTimeoutMs ?? 600_000,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? 60_000,
      chunkTimeoutMs: config.chunkTimeoutMs ?? 30_000,
      maxRetries: config.maxRetries ?? 4,
      maxRetryDelayMs: config.maxRetryDelayMs ?? 60_000,
      enableNonStreamingFallback: config.enableNonStreamingFallback ?? true,
    };
  }

  // ============== Decision ==============

  /**
   * Determines the recovery action for a given failure.
   *
   * The recovery ladder selects the mildest appropriate action:
   * - Step 1 (fresh_connection_retry): For pre-delta failures
   * - Step 2 (stable_boundary_retry): For mid-stream failures
   * - Step 3 (non_streaming_fallback): For repeated streaming failures
   * - Step 4 (manual_continue): When all retries are exhausted
   */
  decideRecoveryAction(
    error: Error,
    classified: ResilienceClassification,
    attempt: number,
  ): RecoveryDecision {
    // Non-retryable errors → manual continue immediately
    if (!classified.retryable) {
      return {
        action: 'manual_continue',
        ladderStep: 4,
        delayMs: 0,
        maxDelayMs: this.config.maxRetryDelayMs,
        shouldUseNonStreaming: false,
        reasonCode: classified.errorClass,
        failureStage: classified.failureStage,
      };
    }

    // Thinking-mode contract violation: special-case ahead of the
    // generic retry-budget gate so the sanitize-and-retry attempt fires
    // even when the original retry budget is small. Single-shot:
    // subsequent encounters fall through to manual_continue. v0.7.28.
    if (
      classified.errorClass === 'reasoning_content_required' &&
      !this.thinkingSanitizationUsed
    ) {
      this.thinkingSanitizationUsed = true;
      return {
        action: 'sanitize_thinking_and_retry',
        ladderStep: 2,
        delayMs: 0,
        maxDelayMs: this.config.maxRetryDelayMs,
        shouldUseNonStreaming: false,
        reasonCode: classified.errorClass,
        failureStage: classified.failureStage,
      };
    }

    // Retries exhausted → manual continue
    if (attempt >= this.config.maxRetries) {
      return {
        action: 'manual_continue',
        ladderStep: 4,
        delayMs: 0,
        maxDelayMs: this.config.maxRetryDelayMs,
        shouldUseNonStreaming: false,
        reasonCode: classified.errorClass,
        failureStage: classified.failureStage,
      };
    }

    // Calculate delay with exponential backoff + jitter
    const delayMs = calculateRetryDelay(
      classified.baseRetryDelay,
      attempt,
      this.config.maxRetryDelayMs,
    );

    // Cap server Retry-After to our maximum
    const serverRetryAfterMs = extractServerRetryAfter(error);
    const effectiveDelayMs = serverRetryAfterMs !== undefined
      ? Math.min(serverRetryAfterMs, this.config.maxRetryDelayMs)
      : delayMs;

    // Determine ladder step based on failure stage and error class
    const { action, ladderStep, shouldUseNonStreaming } =
      this.selectRecoveryStrategy(classified, attempt);

    return {
      action,
      ladderStep,
      delayMs: effectiveDelayMs,
      maxDelayMs: this.config.maxRetryDelayMs,
      shouldUseNonStreaming,
      reasonCode: classified.errorClass,
      failureStage: classified.failureStage,
      serverRetryAfterMs,
    };
  }

  // ============== Execution ==============

  /**
   * Executes a recovery decision by reconstructing messages
   * from the stable boundary.
   *
   * @param messages - The current message list
   * @param decision - The recovery decision to execute
   * @returns Recovery result with reconstructed messages
   */
  executeRecovery(
    messages: KodaXMessage[],
    decision: RecoveryDecision,
  ): RecoveryResult {
    switch (decision.action) {
      case 'fresh_connection_retry':
        return this.executeFreshConnectionRetry(messages, decision);
      case 'stable_boundary_retry':
        return this.executeStableBoundaryRetry(messages, decision);
      case 'non_streaming_fallback':
        return this.executeNonStreamingFallback(messages, decision);
      case 'manual_continue':
        return this.executeManualContinue(messages, decision);
      case 'sanitize_thinking_and_retry':
        return this.executeSanitizeThinking(messages, decision);
    }
  }

  // ============== Strategy Selection ==============

  private selectRecoveryStrategy(
    classified: ResilienceClassification,
    attempt: number,
  ): { action: RecoveryAction; ladderStep: RecoveryLadderStep; shouldUseNonStreaming: boolean } {
    const stage = classified.failureStage;
    const errorClass = classified.errorClass;

    // Check if non-streaming fallback is appropriate
    const isStreamingError = STREAMING_ERROR_CLASSES.includes(errorClass);
    const shouldTryFallback =
      isStreamingError &&
      this.config.enableNonStreamingFallback &&
      !this.nonStreamingFallbackUsed &&
      attempt >= 2;

    if (shouldTryFallback) {
      this.nonStreamingFallbackUsed = true;
      return {
        action: 'non_streaming_fallback',
        ladderStep: 3,
        shouldUseNonStreaming: true,
      };
    }

    // Pre-delta failures → fresh connection retry (step 1)
    if (PRE_DELTA_STAGES.includes(stage)) {
      return {
        action: 'fresh_connection_retry',
        ladderStep: 1,
        shouldUseNonStreaming: false,
      };
    }

    // Mid-stream failures → stable boundary retry (step 2)
    return {
      action: 'stable_boundary_retry',
      ladderStep: 2,
      shouldUseNonStreaming: false,
    };
  }

  // ============== Execution Strategies ==============

  private executeFreshConnectionRetry(
    messages: KodaXMessage[],
    _decision: RecoveryDecision,
  ): RecoveryResult {
    // Fresh connection retry: use same messages, no reconstruction needed
    const snapshot = this.boundaryTracker.snapshot();
    return {
      messages: [...messages],
      droppedToolCallIds: [],
      executedToolCallIds: [...snapshot.executedToolCallIds],
      fallbackUsed: this.nonStreamingFallbackUsed,
    };
  }

  private executeStableBoundaryRetry(
    messages: KodaXMessage[],
    _decision: RecoveryDecision,
  ): RecoveryResult {
    // Recover to stable boundary and reconstruct messages
    const recovery = this.boundaryTracker.recoverToStableBoundary(messages);

    // Apply tool guard to ensure executed tool results are preserved
    const reconstructed = reconstructMessagesWithToolGuard(
      recovery.messages,
      recovery.executedToolCallIds,
      recovery.droppedToolCallIds,
    );

    return {
      messages: reconstructed,
      droppedToolCallIds: recovery.droppedToolCallIds,
      executedToolCallIds: recovery.executedToolCallIds,
      fallbackUsed: this.nonStreamingFallbackUsed,
    };
  }

  private executeNonStreamingFallback(
    messages: KodaXMessage[],
    _decision: RecoveryDecision,
  ): RecoveryResult {
    // Same as stable boundary retry but with non-streaming mode
    const recovery = this.boundaryTracker.recoverToStableBoundary(messages);

    const reconstructed = reconstructMessagesWithToolGuard(
      recovery.messages,
      recovery.executedToolCallIds,
      recovery.droppedToolCallIds,
    );

    return {
      messages: reconstructed,
      droppedToolCallIds: recovery.droppedToolCallIds,
      executedToolCallIds: recovery.executedToolCallIds,
      fallbackUsed: true,
    };
  }

  private executeManualContinue(
    messages: KodaXMessage[],
    _decision: RecoveryDecision,
  ): RecoveryResult {
    // Manual continue: return messages as-is
    const snapshot = this.boundaryTracker.snapshot();
    return {
      messages: [...messages],
      droppedToolCallIds: [...snapshot.pendingToolCallIds],
      executedToolCallIds: [...snapshot.executedToolCallIds],
      fallbackUsed: this.nonStreamingFallbackUsed,
    };
  }

  // Strip thinking and redacted_thinking blocks from every assistant
  // turn in history. The resulting wire-form (after L1 always-attach)
  // sends `reasoning_content: ''` for every turn, which deepseek
  // thinking-mode accepts without complaint, and Anthropic interprets
  // as "no prior thinking" so the next turn naturally generates fresh
  // thinking. If a turn becomes empty after stripping (was thinking-
  // only), inject a minimal text placeholder to keep user/assistant
  // alternation valid. v0.7.28.
  private executeSanitizeThinking(
    messages: KodaXMessage[],
    _decision: RecoveryDecision,
  ): RecoveryResult {
    const snapshot = this.boundaryTracker.snapshot();
    const sanitized = sanitizeThinkingBlocks(messages);
    return {
      messages: sanitized,
      droppedToolCallIds: [],
      executedToolCallIds: [...snapshot.executedToolCallIds],
      fallbackUsed: this.nonStreamingFallbackUsed,
    };
  }

  // ============== Reset ==============

  /**
   * Resets the coordinator for a new request chain.
   */
  reset(): void {
    this.nonStreamingFallbackUsed = false;
    this.thinkingSanitizationUsed = false;
  }
}

// ============== Thinking Sanitization ==============

/**
 * Strips thinking and redacted_thinking blocks from every assistant
 * turn in history. Used by `sanitize_thinking_and_retry` recovery to
 * recover from servers that reject the replay because their thinking-
 * mode invariants were violated (e.g., deepseek "must be passed back",
 * Anthropic "thinking signature invalid").
 *
 * Behavior:
 * - thinking and redacted_thinking blocks: removed
 * - text, tool_use, tool_result blocks: preserved
 * - assistant turns that become empty after stripping (were thinking-
 *   only) get a minimal '...' text placeholder so user/assistant
 *   alternation stays valid for the retry
 * - non-array (string) content: preserved as-is
 *
 * Idempotent: running it twice on the same messages produces the same
 * result.
 */
export function sanitizeThinkingBlocks(messages: KodaXMessage[]): KodaXMessage[] {
  return messages.map((msg) => {
    if (msg.role !== 'assistant') return msg;
    if (typeof msg.content === 'string') return msg;
    if (!Array.isArray(msg.content)) return msg;

    const filtered = (msg.content as KodaXContentBlock[]).filter(
      (block): block is Exclude<
        KodaXContentBlock,
        KodaXThinkingBlock | KodaXRedactedThinkingBlock
      > => block.type !== 'thinking' && block.type !== 'redacted_thinking',
    );

    if (filtered.length === 0) {
      // Was thinking-only — keep a placeholder so the retry doesn't
      // break user/assistant alternation. '...' is the same convention
      // used by anthropic.ts:657 / openai.ts content fallback.
      return {
        ...msg,
        content: [{ type: 'text' as const, text: '...' }],
      };
    }

    return { ...msg, content: filtered };
  });
}

// ============== Delay Calculation ==============

/**
 * Calculates retry delay with exponential backoff and jitter.
 *
 * @param baseDelay - Base delay in ms
 * @param attempt - Current attempt number (0-based)
 * @param maxDelay - Maximum allowed delay
 * @returns Delay in ms with jitter applied
 */
function calculateRetryDelay(
  baseDelay: number,
  attempt: number,
  maxDelay: number,
): number {
  // Exponential backoff: baseDelay * 2^attempt
  const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);

  // Add jitter: random value between 0 and 1000ms
  const jitter = Math.random() * 1000;

  // Cap at max delay
  return Math.min(exponentialDelay + jitter, maxDelay);
}

/**
 * Extracts server-provided Retry-After value from error.
 * Returns undefined if not available.
 */
function extractServerRetryAfter(error: Error): number | undefined {
  // KodaXRateLimitError has retryAfter field
  if ('retryAfter' in error && typeof (error as { retryAfter?: unknown }).retryAfter === 'number') {
    return (error as { retryAfter: number }).retryAfter * 1000; // Convert seconds to ms
  }
  return undefined;
}
