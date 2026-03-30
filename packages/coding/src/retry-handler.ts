/**
 * KodaX Retry Handler
 *
 * 带抖动的指数退避重试逻辑
 */

import type { ErrorClassification } from './error-classification.js';
import { classifyError } from './error-classification.js';

/**
 * 使用重试逻辑和抖动指数退避执行函数
 *
 * @param fn - 要执行的函数
 * @param defaultClassification - 默认错误分类（当无法分类时使用）
 * @param onRetry - 重试回调（可选）
 * @returns 函数执行结果
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  defaultClassification: ErrorClassification,
  onRetry?: (
    attempt: number,
    maxRetries: number,
    delay: number,
    error: Error,
    classification: ErrorClassification,
  ) => void,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: Error | undefined;
  let currentClassification = defaultClassification;

  for (let attempt = 0; attempt <= currentClassification.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // 动态分类错误
      const classified = classifyError(lastError);

      // 如果是 TOOL_CALL_ID 或 USER_ABORT 错误，不重试
      if (classified.category === 2 || classified.category === 3) { // ErrorCategory.TOOL_CALL_ID or USER_ABORT
        throw lastError;
      }

      // 使用分类后的重试策略
      currentClassification = classified;

      // 如果不可重试或已达到最大重试次数，抛出错误
      if (!currentClassification.retryable || attempt === currentClassification.maxRetries) {
        throw lastError;
      }

      // 计算带指数退避 + 抖动的延迟
      const baseDelay = currentClassification.retryDelay * Math.pow(2, attempt);
      const jitter = Math.random() * 1000;  // 添加最多 1 秒的抖动
      const delay = baseDelay + jitter;

      // 通知重试
      if (onRetry) {
        onRetry(attempt + 1, currentClassification.maxRetries, delay, lastError, currentClassification);
      }

      // 等待后重试
      await waitForRetryDelay(delay, signal);
    }
  }

  // 理论上不会到达这里，但 TypeScript 需要它
  throw lastError ?? new Error('Unexpected end of retry loop');
}

function waitForRetryDelay(delay: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Request aborted', 'AbortError'));
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout>;

    const onAbort = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Request aborted', 'AbortError'));
    };

    timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
