import { describe, expect, it } from 'vitest';
import { runWithProviderCredential } from '@kodax-ai/llm';
import { buildLocalExecutionFailure, childExecutionFailure } from './execution-failure.js';

describe('local execution failure diagnostics', () => {
  it('preserves Node error codes while bounding and redacting the message', () => {
    const error = new TypeError(`invalid value secret-test-key ${'x'.repeat(2000)}`);
    Object.assign(error, { code: 'ERR_INVALID_ARG_TYPE' });
    const failure = runWithProviderCredential('test', 'secret-test-key', () => buildLocalExecutionFailure(error));
    expect(failure).toMatchObject({ source: 'local', errorName: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' });
    expect(failure.message).not.toContain('secret-test-key');
    expect(failure.message.length).toBeLessThan(1100);
    expect(failure).not.toHaveProperty('stack');
  });
  it('handles non-Error throws without inventing Provider facts', () => {
    expect(buildLocalExecutionFailure('local boom')).toMatchObject({
      source: 'local', errorClass: 'local_execution_error', errorName: 'Error',
      code: 'KODAX_LOCAL_EXECUTION_ERROR', message: expect.stringContaining('local boom'),
    });
  });
  it('does not infer failure from stale error metadata on successful runs', () => {
    expect(childExecutionFailure({ success: true, lastText: 'done', messages: [], sessionId: 's',
      errorMetadata: { lastError: 'old error', consecutiveErrors: 1 } })).toBeUndefined();
  });
});
