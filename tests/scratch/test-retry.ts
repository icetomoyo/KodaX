import { withRetry } from '../../packages/coding/src/retry-handler.js';
import { ErrorCategory, classifyError } from '../../packages/coding/src/error-classification.js';

async function main() {
  let calls = 0;
  try {
    const result = await withRetry(
      async () => {
        calls++;
        console.log('fn() called, attempt: ' + calls);
        if (calls < 3) {
          const e = new Error('Stream incomplete: network timeout');
          e.name = 'StreamIncompleteError';
          throw e;
        }
        return 'success';
      },
      { category: ErrorCategory.TRANSIENT, retryable: true, maxRetries: 2, retryDelay: 1000, shouldCleanup: true },
      (attempt, maxRetries, delay) => {
        console.log(onRetry called: attempt /, delay: ms);
      }
    );
    console.log('Result:', result);
  } catch (e) {
    console.error('Final Error:', e.message);
  }
}

main();
