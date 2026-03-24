import { describe, expect, it, vi } from 'vitest';
import { KodaXNetworkError } from '@kodax/ai';
import { withRetry } from './retry-handler.js';
import { ErrorCategory, type ErrorClassification } from './error-classification.js';

const transientTimeoutClassification: ErrorClassification = {
  category: ErrorCategory.TRANSIENT,
  retryable: true,
  maxRetries: 3,
  retryDelay: 1,
  shouldCleanup: true,
};

describe('withRetry', () => {
  it('resets retry attempt numbering for each independent invocation', async () => {
    const retryEvents: Array<{ attempt: number; maxRetries: number }> = [];
    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback: Parameters<typeof setTimeout>[0]) => {
        if (typeof callback === 'function') {
          callback();
        }
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

    let firstCallAttempts = 0;
    const firstResult = await withRetry(
      async () => {
        firstCallAttempts += 1;
        if (firstCallAttempts === 1) {
          throw new KodaXNetworkError('timeout during first call', true);
        }
        return 'first-ok';
      },
      transientTimeoutClassification,
      (attempt, maxRetries) => {
        retryEvents.push({ attempt, maxRetries });
      },
    );

    let secondCallAttempts = 0;
    const secondResult = await withRetry(
      async () => {
        secondCallAttempts += 1;
        if (secondCallAttempts === 1) {
          throw new KodaXNetworkError('timeout during second call', true);
        }
        return 'second-ok';
      },
      transientTimeoutClassification,
      (attempt, maxRetries) => {
        retryEvents.push({ attempt, maxRetries });
      },
    );

    expect(firstResult).toBe('first-ok');
    expect(secondResult).toBe('second-ok');
    expect(retryEvents).toEqual([
      { attempt: 1, maxRetries: 3 },
      { attempt: 1, maxRetries: 3 },
    ]);

    timeoutSpy.mockRestore();
  });
});
