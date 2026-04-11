/**
 * KodaX Resilience Error Classifier (Feature 045)
 *
 * Upgrades the basic error-classification.ts with fine-grained
 * error classes and failure stage detection for the recovery ladder.
 *
 * The original classifyError() is preserved for backward compatibility.
 * This module provides classifyResilienceError() with richer semantics.
 */

import {
  KodaXRateLimitError,
  KodaXProviderError,
  KodaXNetworkError,
} from '@kodax/ai';
import type {
  ResilienceErrorClass,
  FailureStage,
  ResilienceClassification,
} from './types.js';

// ============== Transient Message Patterns ==============

const RATE_LIMIT_PATTERNS = [
  /\brate.?limit\b/i,
  /\btoo many requests\b/i,
  /\b429\b/,
  /\bquota exceeded\b/i,
  /\bapi credits?\b/i,
  // Chinese (中文)
  /请求过多/,
  /频率限制/,
  /限流/,
  /配额/,
];

const OVERLOADED_PATTERNS = [
  /\boverloaded\b/i,
  /\bcapacity\b/i,
  /\bserver (error|busy)\b/i,
  /\b503\b/,
  /\b502\b/,
  /\binternal server error\b/i,
  /\bservice unavailable\b/i,
  // Chinese (中文)
  /服务繁忙/,
  /服务不可用/,
  /服务器错误/,
  /服务器内部错误/,
  /过载/,
  /容量不足/,
];

const CONNECTION_PATTERNS = [
  /\bconnection (error|reset|closed|refused)\b/i,
  /\bsocket hang up\b/i,
  /\bfetch failed\b/i,
  /\beconnrefused\b/i,
  /\beconnreset\b/i,
  /\benotfound\b/i,
  /\beai_again\b/i,
  /\bother side closed\b/i,
  /\bnetwork\b/i,
  // Chinese (中文)
  /网络错误/,
  /网络异常/,
  /连接错误/,
  /连接失败/,
  /连接被拒绝/,
  /连接被重置/,
];

const TIMEOUT_PATTERNS = [
  /\btimed? ?out\b/i,
  /\betimedout\b/i,
  // Chinese (中文)
  /连接超时/,
  /请求超时/,
  /响应超时/,
];

const STREAM_INCOMPLETE_PATTERNS = [
  /\bstream incomplete\b/i,
  /\bstream interrupted\b/i,
];

const IDLE_TIMEOUT_PATTERNS = [
  /\bstream stalled or delayed\b/i,
  /\b60s idle\b/i,
  /\bidle timeout\b/i,
];

const HARD_TIMEOUT_PATTERNS = [
  /\bhard timeout\b/i,
  /\b10 minutes?\b/i,
  /\bapi hard timeout\b/i,
];

// ============== Classification ==============

/**
 * Classifies an error for the resilience system.
 *
 * Returns a ResilienceClassification with:
 * - errorClass: Fine-grained error category
 * - failureStage: When in the request lifecycle the error occurred
 * - retryable: Whether automatic retry is appropriate
 * - maxRetries: Maximum retry attempts
 * - baseRetryDelay: Base delay between retries (ms)
 *
 * @param error - The error to classify
 * @param currentStage - The current failure stage context (if known)
 */
export function classifyResilienceError(
  error: Error,
  currentStage?: FailureStage,
): ResilienceClassification {
  const message = error.message.toLowerCase();

  // 1. User abort — never retry
  if (error.name === 'AbortError') {
    return {
      errorClass: 'user_abort',
      failureStage: currentStage ?? 'before_first_delta',
      retryable: false,
      maxRetries: 0,
      baseRetryDelay: 0,
    };
  }

  // 2. Rate limit — retry with server hint
  if (
    error instanceof KodaXRateLimitError ||
    matchesAny(message, RATE_LIMIT_PATTERNS)
  ) {
    const retryAfter = error instanceof KodaXRateLimitError
      ? (error as { retryAfter?: number }).retryAfter
      : undefined;

    return {
      errorClass: 'rate_limit',
      failureStage: currentStage ?? 'before_first_delta',
      retryable: true,
      maxRetries: 3,
      baseRetryDelay: retryAfter ?? 60_000,
    };
  }

  // 3. Provider overloaded (502/503/503)
  if (
    error instanceof KodaXProviderError &&
    matchesAny(message, OVERLOADED_PATTERNS)
  ) {
    return {
      errorClass: 'provider_overloaded',
      failureStage: currentStage ?? 'before_first_delta',
      retryable: true,
      maxRetries: 3,
      baseRetryDelay: 5_000,
    };
  }

  // 4. Stream incomplete — mid-stream failure
  if (
    error.name === 'StreamIncompleteError' ||
    matchesAny(message, STREAM_INCOMPLETE_PATTERNS)
  ) {
    return {
      errorClass: 'incomplete_stream',
      failureStage: inferStageForStreamError(message, currentStage),
      retryable: true,
      maxRetries: 3,
      baseRetryDelay: 2_000,
    };
  }

  // 5. Idle timeout — stream stalled
  if (matchesAny(message, IDLE_TIMEOUT_PATTERNS)) {
    return {
      errorClass: 'stream_idle_timeout',
      failureStage: currentStage ?? 'mid_stream_text',
      retryable: true,
      maxRetries: 3,
      baseRetryDelay: 3_000,
    };
  }

  // 6. Hard timeout — request timeout
  if (matchesAny(message, HARD_TIMEOUT_PATTERNS)) {
    return {
      errorClass: 'request_timeout',
      failureStage: currentStage ?? 'before_first_delta',
      retryable: true,
      maxRetries: 2,
      baseRetryDelay: 5_000,
    };
  }

  // 7. Generic timeout
  if (
    (error instanceof KodaXNetworkError && (error as { isTimeout?: boolean }).isTimeout) ||
    matchesAny(message, TIMEOUT_PATTERNS)
  ) {
    return {
      errorClass: 'request_timeout',
      failureStage: currentStage ?? 'before_first_delta',
      retryable: true,
      maxRetries: 3,
      baseRetryDelay: 5_000,
    };
  }

  // 8. Connection failure
  if (
    error instanceof KodaXNetworkError ||
    matchesAny(message, CONNECTION_PATTERNS)
  ) {
    return {
      errorClass: 'connection_failure',
      failureStage: currentStage ?? 'before_first_delta',
      retryable: true,
      maxRetries: 3,
      baseRetryDelay: 2_000,
    };
  }

  // 9. Provider error — check if transient message pattern
  if (error instanceof KodaXProviderError) {
    if (matchesAny(message, [...CONNECTION_PATTERNS, ...TIMEOUT_PATTERNS])) {
      return {
        errorClass: 'connection_failure',
        failureStage: currentStage ?? 'before_first_delta',
        retryable: true,
        maxRetries: 3,
        baseRetryDelay: 2_000,
      };
    }

    // Permanent provider error
    return {
      errorClass: 'non_retryable_provider_error',
      failureStage: currentStage ?? 'before_first_delta',
      retryable: false,
      maxRetries: 0,
      baseRetryDelay: 0,
    };
  }

  // 10. Generic error — check for transient patterns
  if (matchesAny(message, [...CONNECTION_PATTERNS, ...TIMEOUT_PATTERNS, ...STREAM_INCOMPLETE_PATTERNS])) {
    return {
      errorClass: 'connection_failure',
      failureStage: currentStage ?? 'before_first_delta',
      retryable: true,
      maxRetries: 2,
      baseRetryDelay: 2_000,
    };
  }

  // Default: non-retryable
  return {
    errorClass: 'non_retryable_provider_error',
    failureStage: currentStage ?? 'before_first_delta',
    retryable: false,
    maxRetries: 0,
    baseRetryDelay: 0,
  };
}

// ============== Helpers ==============

function matchesAny(message: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(message));
}

/**
 * Infers the failure stage for stream-related errors based on error message
 * and current stage context.
 */
function inferStageForStreamError(
  message: string,
  currentStage?: FailureStage,
): FailureStage {
  if (currentStage) {
    return currentStage;
  }

  // If the message mentions tool input, likely mid_stream_tool_input
  if (/\btool.?input\b/i.test(message) || /\btool.?call\b/i.test(message)) {
    return 'mid_stream_tool_input';
  }

  // If the message mentions thinking, likely mid_stream_thinking
  if (/\bthinking\b/i.test(message)) {
    return 'mid_stream_thinking';
  }

  // Default to mid_stream_text for stream incomplete errors
  return 'mid_stream_text';
}
