import { afterEach, describe, expect, it, vi } from 'vitest';

describe('resilience telemetry redaction', () => {
  const originalDebug = process.env.KODAX_DEBUG_RESILIENCE;

  afterEach(() => {
    if (originalDebug === undefined) {
      delete process.env.KODAX_DEBUG_RESILIENCE;
    } else {
      process.env.KODAX_DEBUG_RESILIENCE = originalDebug;
    }
    vi.resetModules();
  });

  it('never emits the upstream Provider message in debug diagnostics', async () => {
    process.env.KODAX_DEBUG_RESILIENCE = '1';
    vi.resetModules();
    const { setKodaXDiagnosticSink } = await import('@kodax-ai/agent');
    const { telemetryClassify } = await import('./telemetry.js');
    const diagnostics: unknown[] = [];
    const restore = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
    const secret = 'opaque-provider-secret';
    const error = new Error(`Provider body echoed ${secret}`);
    error.name = 'APIError';

    try {
      telemetryClassify(error, {
        errorClass: 'non_retryable_provider_error',
        failureStage: 'before_first_delta',
        retryable: false,
        maxRetries: 0,
        baseRetryDelay: 0,
      });
    } finally {
      restore();
    }

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      detail: { errorName: 'APIError' },
    });
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    expect(JSON.stringify(diagnostics)).not.toContain('rawError');
  });

  it('does not emit a provider-controlled invalid error name', async () => {
    process.env.KODAX_DEBUG_RESILIENCE = '1';
    vi.resetModules();
    const { setKodaXDiagnosticSink } = await import('@kodax-ai/agent');
    const { telemetryClassify } = await import('./telemetry.js');
    const diagnostics: unknown[] = [];
    const restore = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
    const error = new Error('safe');
    error.name = 'APIError token=provider-secret';

    try {
      telemetryClassify(error, {
        errorClass: 'non_retryable_provider_error',
        failureStage: 'before_first_delta',
        retryable: false,
        maxRetries: 0,
        baseRetryDelay: 0,
      });
    } finally {
      restore();
    }

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ detail: { errorName: 'Error' } });
    expect(JSON.stringify(diagnostics)).not.toContain('provider-secret');
  });
});
