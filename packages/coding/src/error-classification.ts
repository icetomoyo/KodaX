/**
 * KodaX Error Classification
 *
 * 错误分类系统 - 决定适当的恢复策略
 */

import { KodaXRateLimitError, KodaXProviderError, KodaXNetworkError, KodaXToolCallIdError } from '@kodax/ai';

export enum ErrorCategory {
  TRANSIENT,      // 临时错误，可重试（速率限制、超时、网络错误）
  PERMANENT,      // 永久错误，不可重试（认证失败、无效请求）
  TOOL_CALL_ID,   // 特定的 tool_call_id 不匹配错误
  USER_ABORT,     // 用户取消
}

export interface ErrorClassification {
  category: ErrorCategory;
  retryable: boolean;
  maxRetries: number;
  retryDelay: number;  // 毫秒
  shouldCleanup: boolean;
}

const TRANSIENT_MESSAGE_PATTERNS = [
  /\bstream incomplete\b/i,
  /\bstream interrupted\b/i,
  /\bstream stalled\b/i,
  /\bdelayed response\b/i,
  /\btimed out\b/i,
  /\btimeout\b/i,
  /\bnetwork\b/i,
  /\bconnection error\b/i,
  /\bconnection reset\b/i,
  /\bconnection closed\b/i,
  /\bsocket hang up\b/i,
  /\bfetch failed\b/i,
  /\beconnrefused\b/i,
  /\beconnreset\b/i,
  /\betimedout\b/i,
  /\benotfound\b/i,
  /\beai_again\b/i,
  /\bother side closed\b/i,
  /\baborted\b/i,
  // Chinese transient patterns (中文 provider 错误消息)
  /网络错误/,
  /网络异常/,
  /连接超时/,
  /连接错误/,
  /连接失败/,
  /连接被拒绝/,
  /请求超时/,
  /服务繁忙/,
  /服务不可用/,
  /服务器错误/,
  /服务器内部错误/,
  /请求过多/,
  /频率限制/,
  /限流/,
  /过载/,
  /容量不足/,
];

function matchesTransientMessage(message: string): boolean {
  return TRANSIENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * 分类错误以确定适当的恢复策略
 */
export function classifyError(error: Error): ErrorClassification {
  // Issue 084: Stream incomplete error - network disconnection during streaming
  if (error.name === 'StreamIncompleteError' || error.message.includes('Stream incomplete')) {
    return {
      category: ErrorCategory.TRANSIENT,
      retryable: true,
      maxRetries: 3,
      retryDelay: 2000,
      shouldCleanup: true,
    };
  }

  // 用户中断
  if (error.name === 'AbortError') {
    return {
      category: ErrorCategory.USER_ABORT,
      retryable: false,
      maxRetries: 0,
      retryDelay: 0,
      shouldCleanup: true,
    };
  }

  // Tool call ID 不匹配错误
  if (error instanceof KodaXToolCallIdError ||
      error.message.includes('tool_call_id') ||
      error.message.includes('tool result')) {
    return {
      category: ErrorCategory.TOOL_CALL_ID,
      retryable: true,  // 清理后重试
      maxRetries: 1,
      retryDelay: 1000,
      shouldCleanup: true,
    };
  }

  // 速率限制错误
  if (error instanceof KodaXRateLimitError) {
    return {
      category: ErrorCategory.TRANSIENT,
      retryable: true,
      maxRetries: 3,
      retryDelay: error.retryAfter ?? 60000,
      shouldCleanup: true,
    };
  }

  // 网络错误
  if (error instanceof KodaXNetworkError) {
    return {
      category: ErrorCategory.TRANSIENT,
      retryable: true,
      maxRetries: 3,
      retryDelay: error.isTimeout ? 5000 : 2000,
      shouldCleanup: true,
    };
  }

  // Provider 错误 (API 错误)
  if (error instanceof KodaXProviderError) {
    // 检查是否为可重试的 API 错误
    const msg = error.message.toLowerCase();
    if (matchesTransientMessage(msg)) {
      return {
        category: ErrorCategory.TRANSIENT,
        retryable: true,
        maxRetries: 3,
        retryDelay: 2000,
        shouldCleanup: true,
      };
    }

    // 永久 API 错误（400 Bad Request, 401 Unauthorized, 等）
    return {
      category: ErrorCategory.PERMANENT,
      retryable: false,
      maxRetries: 0,
      retryDelay: 0,
      shouldCleanup: true,
    };
  }

  // 检查通用网络错误模式
  const msg = error.message.toLowerCase();
  if (matchesTransientMessage(msg)) {
    return {
      category: ErrorCategory.TRANSIENT,
      retryable: true,
      maxRetries: 2,
      retryDelay: 2000,
      shouldCleanup: true,
    };
  }

  // 默认：视为永久错误，总是清理
  return {
    category: ErrorCategory.PERMANENT,
    retryable: false,
    maxRetries: 0,
    retryDelay: 0,
    shouldCleanup: true,
  };
}
