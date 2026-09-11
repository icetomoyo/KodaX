import { redactScopedProviderCredential } from '@kodax-ai/llm';
import type { KodaXExecutionFailure, KodaXResult } from './types.js';

/** Local exceptions have no Provider request facts; retain their bounded diagnostic. */
export function buildLocalExecutionFailure(cause: unknown): KodaXExecutionFailure {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const errorName = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name) ? error.name : 'Error';
  const rawCode = 'code' in error ? error.code : undefined;
  const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(rawCode)
    ? rawCode : 'KODAX_LOCAL_EXECUTION_ERROR';
  const detail = redactScopedProviderCredential(error.message).slice(0, 1000);
  const safeMessage = 'Local SDK execution failed.';
  return {
    source: 'local', errorClass: 'local_execution_error', requestPhase: 'local_execution',
    errorName, code, safeMessage,
    message: `${safeMessage} ${errorName}: ${detail}`,
  };
}

/** Older/custom executors may only populate session error metadata. */
export function childExecutionFailure(result: KodaXResult): KodaXExecutionFailure | undefined {
  return result.failure ?? (!result.success && result.errorMetadata?.lastError
    ? buildLocalExecutionFailure(new Error(result.errorMetadata.lastError))
    : undefined);
}
