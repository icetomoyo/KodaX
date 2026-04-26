/**
 * KodaX Provider Resilience Types (Feature 045)
 *
 * Defines the type system for failure taxonomy, recovery ladder,
 * and execution state tracking used by the resilience module.
 */

// ============== Error Classes ==============

/**
 * Fine-grained error classification beyond the basic ErrorCategory.
 * Each class maps to a distinct recovery strategy.
 */
export type ResilienceErrorClass =
  | 'rate_limit'
  | 'provider_overloaded'
  | 'request_timeout'
  | 'stream_idle_timeout'
  | 'chunk_timeout'
  | 'connection_failure'
  | 'incomplete_stream'
  | 'user_abort'
  | 'non_retryable_provider_error'
  // Server rejected the replay because thinking-mode contract requires
  // reasoning_content (deepseek V4) or a valid thinking signature
  // (Anthropic) to be present on every assistant turn that was thought
  // about in this conversation. Recoverable by stripping/normalising
  // thinking blocks from history and retrying once. v0.7.28.
  | 'reasoning_content_required';

// ============== Failure Stages ==============

/**
 * The stage of the provider request lifecycle when the failure occurred.
 * Determines the stable boundary and recovery strategy.
 */
export type FailureStage =
  | 'before_request_accepted'
  | 'before_first_delta'
  | 'mid_stream_text'
  | 'mid_stream_thinking'
  | 'mid_stream_tool_input'
  | 'post_tool_execution_pre_assistant_close';

// ============== Recovery Actions ==============

/**
 * The recovery action chosen by the recovery coordinator.
 * Maps to the 4-step recovery ladder.
 */
export type RecoveryAction =
  | 'fresh_connection_retry'
  | 'stable_boundary_retry'
  | 'non_streaming_fallback'
  | 'manual_continue'
  // Sanitize thinking blocks out of history (or blank their signatures)
  // and retry once. Triggered by `reasoning_content_required`. v0.7.28.
  | 'sanitize_thinking_and_retry';

// ============== Recovery Ladder Step ==============

/**
 * Step in the recovery ladder (1 = mildest, 4 = manual intervention).
 */
export type RecoveryLadderStep = 1 | 2 | 3 | 4;

// ============== Resilience Classification ==============

/**
 * Extended error classification that includes failure stage
 * and resilience-specific error class.
 */
export interface ResilienceClassification {
  errorClass: ResilienceErrorClass;
  failureStage: FailureStage;
  retryable: boolean;
  maxRetries: number;
  baseRetryDelay: number;
}

// ============== Provider Execution State ==============

/**
 * Runtime snapshot of the current provider execution.
 * Tracked by StableBoundaryTracker throughout the request lifecycle.
 */
export interface ProviderExecutionState {
  /** Unique identifier for this request attempt. */
  requestId: string;
  /** Provider name (e.g., 'anthropic', 'openai'). */
  provider: string;
  /** Model identifier. */
  model: string;
  /** Current attempt number (1-based). */
  attempt: number;
  /** The failure stage, if a failure has been detected. */
  failureStage?: FailureStage;
  /** The classified error class, if a failure has been detected. */
  errorClass?: ResilienceErrorClass;
  /**
   * Index into the messages array representing the last stable boundary.
   * A "stable boundary" is the index AFTER the last fully committed message.
   * Messages at index >= lastStableMessageIndex are considered unstable.
   */
  lastStableMessageIndex: number;
  /** Tool call IDs that have been fully executed (their results are committed). */
  executedToolCallIds: string[];
  /** Tool call IDs that are in progress or pending (streaming but not executed). */
  pendingToolCallIds: string[];
  /** Length of visible live text in the current streaming response. */
  visibleLiveTextLength: number;
  /** Length of visible thinking text in the current streaming response. */
  visibleThinkingLength: number;
  /** Whether non-streaming fallback has been used for this request chain. */
  fallbackUsed: boolean;
  /** Timestamp when this request started. */
  startedAt: number;
}

// ============== Recovery Decision ==============

/**
 * Decision made by the recovery coordinator for a given failure.
 */
export interface RecoveryDecision {
  action: RecoveryAction;
  ladderStep: RecoveryLadderStep;
  /** Calculated delay before next attempt (ms), including backoff + jitter. */
  delayMs: number;
  /** Maximum allowed delay (ms), used to cap server Retry-After. */
  maxDelayMs: number;
  /** Whether to use non-streaming mode for the next attempt. */
  shouldUseNonStreaming: boolean;
  /** The error class that triggered this recovery. */
  reasonCode: ResilienceErrorClass;
  /** The failure stage when the error occurred. */
  failureStage: FailureStage;
  /** Server-provided Retry-After header value (ms), if available. */
  serverRetryAfterMs?: number;
}

// ============== Recovery Result ==============

/**
 * Result of executing a recovery decision.
 * Contains the reconstructed messages and tracking metadata.
 */
export interface RecoveryResult {
  /** Reconstructed messages from the stable boundary forward. */
  messages: import('@kodax/ai').KodaXMessage[];
  /** Tool call IDs that were dropped (incomplete at failure time). */
  droppedToolCallIds: string[];
  /** Tool call IDs that were preserved (already executed). */
  executedToolCallIds: string[];
  /** Whether non-streaming fallback is being used. */
  fallbackUsed: boolean;
}

// ============== Provider Recovery Event ==============

/**
 * Structured event emitted during provider recovery.
 * This is the new structured channel replacing the simple onRetry callback.
 */
export interface ProviderRecoveryEvent {
  stage: FailureStage;
  errorClass: ResilienceErrorClass;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  recoveryAction: RecoveryAction;
  ladderStep: RecoveryLadderStep;
  fallbackUsed: boolean;
  serverRetryAfterMs?: number;
}

// ============== Resilience Config ==============

/**
 * Configuration for provider resilience behavior.
 * Can be set globally and overridden per-provider.
 */
export interface ProviderResilienceConfig {
  /** Hard timeout for the entire request (ms). Default: 600000 (10 min). */
  requestTimeoutMs?: number;
  /** Idle timeout between stream deltas (ms). Default: 60000 (60s). */
  streamIdleTimeoutMs?: number;
  /** Per-chunk timeout within a stream (ms). Default: 30000 (30s). */
  chunkTimeoutMs?: number;
  /** Maximum number of automatic retries. Default: 3. */
  maxRetries?: number;
  /** Maximum delay between retries (ms). Default: 60000 (60s). */
  maxRetryDelayMs?: number;
  /** Whether to allow non-streaming fallback. Default: true. */
  enableNonStreamingFallback?: boolean;
}

// ============== Per-provider Override ==============

/**
 * Per-provider policy override that takes precedence over global config.
 */
export interface ProviderResiliencePolicy extends ProviderResilienceConfig {
  /** Provider name to match (exact match). */
  provider: string;
}
