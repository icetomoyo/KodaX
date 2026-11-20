import { describe, expect, it, vi } from 'vitest';
import { KodaXProviderError, runWithProviderCredential } from '@kodax-ai/llm';
import {
  buildLocalExecutionFailure, buildProviderExecutionFailure, childExecutionFailure, describeFailureCause,
} from './execution-failure.js';

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

describe('failure cause', () => {
  it('keeps the reason and the cause chain', () => {
    const error = new Error('Provider request failed', { cause: new Error('getaddrinfo ENOTFOUND api.example.test') });
    expect(describeFailureCause(error)).toBe('Provider request failed <- getaddrinfo ENOTFOUND api.example.test');
  });
  it('redacts credentials without dropping the surrounding text', () => {
    const text = 'denied: Authorization: Bearer abcdefghijklmnop key=sk-1234567890abcdefgh '
      + 'url https://api.example.test/v1?api_key=leaked-value extra-secret-value';
    const detail = describeFailureCause(new Error(text), ['extra-secret-value']);
    expect(detail).toContain('denied:');
    expect(detail).toContain('https://api.example.test/v1?[REDACTED]');
    for (const secret of ['abcdefghijklmnop', 'sk-1234567890abcdefgh', 'leaked-value', 'extra-secret-value']) {
      expect(detail).not.toContain(secret);
    }
  });
  it('redacts URL userinfo and short explicit credentials', () => {
    const detail = describeFailureCause(new Error('GET https://user:pw@proxy.example.test/x failed, code Z9'), ['Z9']);
    expect(detail).toBe('GET https://[REDACTED]@proxy.example.test/x failed, code [REDACTED]');
  });
  it('redacts the active Provider credential and sensitive environment values', () => {
    vi.stubEnv('KODAX_TEST_FAILURE_API_KEY', 'env-credential-value');
    try {
      const detail = runWithProviderCredential('test', 'scoped-credential',
        () => describeFailureCause(new Error('scoped-credential env-credential-value rejected')));
      expect(detail).toBe('[REDACTED_CREDENTIAL] [REDACTED] rejected');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('reduces markup and control characters to readable bounded text', () => {
    const detail = describeFailureCause(new Error(
      `<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>\u001b[31m\u0000${'x'.repeat(3000)}`));
    expect(detail?.startsWith('502 Bad Gateway')).toBe(true);
    expect(detail?.length).toBe(1000);
    expect(detail).not.toMatch(/[\u0000-\u001f]/);
  });
  it('provider failures carry the cause in detail and message, the summary stays fixed', () => {
    const error = new KodaXProviderError('404 model "x" does not exist', 'p', { httpStatus: 404 });
    const failure = buildProviderExecutionFailure({ error, errorClass: 'non_retryable_provider_error',
      requestPhase: 'before_first_delta', provider: 'p', model: 'm', startedAt: Date.now() });
    expect(failure).toMatchObject({ source: 'provider', safeMessage: 'Configured Provider resource was not found.',
      detail: '404 model "x" does not exist', httpStatus: 404 });
    expect(failure.message).toBe('Configured Provider resource was not found. (KodaXProviderError; HTTP 404): 404 model "x" does not exist');
  });
});
