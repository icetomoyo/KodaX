import { getProviderCredentialEnvironmentNames, redactScopedProviderCredential } from '@kodax-ai/llm';
import type { KodaXExecutionFailure, KodaXResult } from './types.js';

const FAILURE_DETAIL_LIMIT = 1000;
const SENSITIVE_ENV_NAME = /(?:api[_-]?key|authorization|credential|password|secret|token)/i;
const SECRET_TEXT_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [/\b(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{12,}/g, '[REDACTED]'],
  [/\b(api[_-]?key|access[_-]?token|secret|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]{6,}/gi, '$1$2[REDACTED]'],
  [/(https?:\/\/)[^\s/@"']+@/g, '$1[REDACTED]@'],
  [/(https?:\/\/[^\s?#"']+)\?[^\s#"']+/g, '$1?[REDACTED]'],
];

function environmentSecrets(): readonly string[] {
  const names = new Set(getProviderCredentialEnvironmentNames());
  return Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1].length >= 8
      && (names.has(entry[0]) || SENSITIVE_ENV_NAME.test(entry[0])))
    .map(([, value]) => value);
}

/** Replace known credential values and common secret shapes; the surrounding text stays readable. */
export function redactFailureText(text: string, secrets: readonly string[] = []): string {
  let redacted = redactScopedProviderCredential(text);
  const known = [...secrets, ...environmentSecrets()]
    .filter(secret => secret.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const secret of known) redacted = redacted.split(secret).join('[REDACTED]');
  for (const [pattern, replacement] of SECRET_TEXT_PATTERNS) redacted = redacted.replace(pattern, replacement);
  return redacted;
}

function readableFailureText(text: string): string {
  const withoutMarkup = /<\s*(?:!doctype|html|body)\b/i.test(text) ? text.replace(/<[^>]*>/g, ' ') : text;
  return withoutMarkup
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The underlying reason a Run failed (Provider response text or local exception
 * message, including its `cause` chain). Credentials are redacted and the text
 * is bounded, but the reason itself is kept: a failure that hides its cause
 * cannot be diagnosed by the user or by support.
 */
export function describeFailureCause(cause: unknown, secrets: readonly string[] = []): string | undefined {
  const parts: string[] = [];
  let current: unknown = cause;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    const text = current instanceof Error ? current.message : typeof current === 'string' ? current : undefined;
    if (text && !parts.some(part => part.includes(text))) parts.push(text);
    current = current instanceof Error ? current.cause : undefined;
  }
  const readable = readableFailureText(redactFailureText(parts.join(' <- '), secrets));
  if (readable.length === 0) return undefined;
  return readable.length > FAILURE_DETAIL_LIMIT ? `${readable.slice(0, FAILURE_DETAIL_LIMIT - 3)}...` : readable;
}

function withFailureDetail(summary: string, detail: string | undefined): string {
  return detail === undefined ? summary : `${summary}: ${detail}`;
}

/** Local exceptions have no Provider request facts; keep the summary and the real cause. */
export function buildLocalExecutionFailure(cause: unknown): KodaXExecutionFailure {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const errorName = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name) ? error.name : 'Error';
  const rawCode = 'code' in error ? error.code : undefined;
  const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(rawCode)
    ? rawCode : 'KODAX_LOCAL_EXECUTION_ERROR';
  const detail = describeFailureCause(error);
  const safeMessage = 'Local SDK execution failed.';
  return {
    source: 'local', errorClass: 'local_execution_error', requestPhase: 'local_execution',
    errorName, code, safeMessage,
    message: withFailureDetail(`${safeMessage} ${errorName}`, detail),
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Older/custom executors may only populate session error metadata. */
export function childExecutionFailure(result: KodaXResult): KodaXExecutionFailure | undefined {
  return result.failure ?? (!result.success && result.errorMetadata?.lastError
    ? buildLocalExecutionFailure(new Error(result.errorMetadata.lastError))
    : undefined);
}

interface FailureResultCarrier {
  readonly __kodaxFailureResult?: KodaXResult;
  readonly __kodaxProviderFailure?: KodaXExecutionFailure;
}

/** Marks an error as the final Provider request failure, after retries and recovery. */
export function attachProviderFailure(error: Error, failure: KodaXExecutionFailure): void {
  if (!Object.isExtensible(error)) return;
  Object.defineProperty(error, '__kodaxProviderFailure', { value: failure, enumerable: false, configurable: true });
}

export function readProviderFailure(error: unknown): KodaXExecutionFailure | undefined {
  if (!error || typeof error !== 'object') return undefined;
  return (error as FailureResultCarrier).__kodaxProviderFailure;
}

/**
 * Root Runs settle expected outcomes (final Provider failure, user stop) as a
 * result. The managed engine still throws so Hosts can classify the error; the
 * error carries the settled result for the public entries to return instead.
 */
export function attachFailureResult(error: Error, result: KodaXResult): void {
  if (!Object.isExtensible(error)) return;
  Object.defineProperty(error, '__kodaxFailureResult', { value: result, enumerable: false, configurable: true });
}

export function readFailureResult(error: unknown): KodaXResult | undefined {
  if (!error || typeof error !== 'object') return undefined;
  return (error as FailureResultCarrier).__kodaxFailureResult;
}

function safeFailureIdentifier(value: string | undefined): string | undefined {
  if (value === undefined || value.includes('://') || /^[A-Za-z]:\//.test(value)) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value) ? value : undefined;
}

function safeFailureErrorName(value: string): string | undefined {
  return value === 'Error' || /^[A-Za-z][A-Za-z0-9_.-]{0,63}Error$/.test(value)
    ? value
    : undefined;
}

function providerFailureMetadata(error: Error): Readonly<Record<string, unknown>> | undefined {
  const metadata = (error as Error & { readonly metadata?: unknown }).metadata;
  return typeof metadata === 'object' && metadata !== null
    ? metadata as Readonly<Record<string, unknown>>
    : undefined;
}

function boundedFailureMs(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000
    ? value
    : undefined;
}

function terminalProviderFailureMessage(
  errorClass: KodaXExecutionFailure['errorClass'],
  failureCode: KodaXExecutionFailure['failureCode'],
  httpStatus: number | undefined,
): string {
  if (failureCode === 'provider_not_registered') return 'Provider is not registered.';
  if (failureCode === 'request_build_failed') return 'Provider request could not be built.';
  if (failureCode === 'protocol_mismatch' || errorClass === 'reasoning_content_required') {
    return 'Provider protocol is incompatible.';
  }
  if (failureCode === 'response_stream_error' || errorClass === 'incomplete_stream') {
    return 'Provider returned an invalid response stream.';
  }
  if (httpStatus === 401 || httpStatus === 403) return 'Provider authentication failed.';
  if (httpStatus === 404) return 'Configured Provider resource was not found.';
  if (httpStatus !== undefined && httpStatus >= 500) {
    return 'Provider service failed to process the request.';
  }
  if (httpStatus !== undefined && httpStatus >= 400) return 'Provider rejected the request.';
  if (errorClass === 'rate_limit') return 'Provider rate limit exceeded.';
  if (errorClass === 'provider_overloaded') return 'Provider service is temporarily unavailable.';
  if (errorClass === 'request_timeout'
    || errorClass === 'stream_idle_timeout'
    || errorClass === 'chunk_timeout') return 'Provider request timed out.';
  if (errorClass === 'connection_failure') return 'Provider network request failed.';
  if (errorClass === 'user_abort') return 'Provider request was aborted.';
  return 'Provider request failed.';
}

type TerminalProviderMetadata = Pick<
  KodaXExecutionFailure,
  | 'failureCode'
  | 'providerStage'
  | 'httpStatus'
  | 'retryable'
  | 'upstreamCode'
  | 'requestId'
  | 'retryAfterMs'
>;

function readTerminalProviderMetadata(error: Error): TerminalProviderMetadata {
  const metadata = providerFailureMetadata(error);
  const failureCode = metadata?.failureCode === 'provider_not_registered'
    || metadata?.failureCode === 'request_build_failed'
    || metadata?.failureCode === 'protocol_mismatch'
    || metadata?.failureCode === 'response_stream_error'
    ? metadata.failureCode
    : undefined;
  const providerStage = metadata?.stage === 'catalog'
    || metadata?.stage === 'request_build'
    || metadata?.stage === 'transport'
    || metadata?.stage === 'response_stream'
    ? metadata.stage
    : undefined;
  const httpStatus = typeof metadata?.httpStatus === 'number'
    && Number.isInteger(metadata.httpStatus)
    && metadata.httpStatus >= 100
    && metadata.httpStatus <= 599
    ? metadata.httpStatus
    : undefined;
  const retryAfterMs = typeof metadata?.retryAfterMs === 'number'
    ? boundedFailureMs(metadata.retryAfterMs)
    : undefined;
  return {
    failureCode,
    providerStage,
    httpStatus,
    retryable: typeof metadata?.retryable === 'boolean' ? metadata.retryable : undefined,
    upstreamCode: typeof metadata?.upstreamCode === 'string'
      ? safeFailureIdentifier(metadata.upstreamCode)
      : undefined,
    requestId: typeof metadata?.requestId === 'string'
      ? safeFailureIdentifier(metadata.requestId)
      : undefined,
    retryAfterMs,
  };
}

function formatTerminalProviderFailureMessage(
  baseMessage: string,
  facts: readonly (string | undefined)[],
): string {
  const present = facts.filter((fact): fact is string => fact !== undefined);
  return present.length === 0 ? baseMessage : `${baseMessage} (${present.join('; ')})`;
}

/** Provider request failure after the executor's retry and recovery budget is spent. */
export function buildProviderExecutionFailure(input: {
  readonly error: Error;
  readonly errorClass: KodaXExecutionFailure['errorClass'];
  readonly requestPhase: KodaXExecutionFailure['requestPhase'];
  readonly provider: string;
  readonly model: string;
  readonly startedAt: number;
  readonly serverRetryAfterMs?: number;
}): KodaXExecutionFailure {
  const metadata = readTerminalProviderMetadata(input.error);
  const provider = safeFailureIdentifier(input.provider);
  const model = safeFailureIdentifier(input.model);
  const errorName = safeFailureErrorName(input.error.name);
  const code = metadata.upstreamCode ?? metadata.failureCode;
  const retryAfterMs = boundedFailureMs(input.serverRetryAfterMs) ?? metadata.retryAfterMs;
  const elapsedMs = boundedFailureMs(Math.max(0, Date.now() - input.startedAt));
  const safeMessage = terminalProviderFailureMessage(
    input.errorClass,
    metadata.failureCode,
    metadata.httpStatus,
  );
  const detail = describeFailureCause(input.error);
  const message = withFailureDetail(formatTerminalProviderFailureMessage(safeMessage, [
    errorName,
    metadata.httpStatus === undefined ? undefined : `HTTP ${metadata.httpStatus}`,
    metadata.upstreamCode,
    metadata.failureCode,
  ]), detail);
  return {
    source: 'provider',
    message,
    safeMessage,
    ...(detail === undefined ? {} : { detail }),
    ...(errorName === undefined ? {} : { errorName }),
    errorClass: input.errorClass,
    ...(code === undefined ? {} : { code }),
    requestPhase: input.requestPhase,
    ...(metadata.failureCode === undefined ? {} : { failureCode: metadata.failureCode }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(metadata.providerStage === undefined ? {} : { providerStage: metadata.providerStage }),
    ...(metadata.httpStatus === undefined ? {} : { httpStatus: metadata.httpStatus }),
    ...(metadata.retryable === undefined ? {} : { retryable: metadata.retryable }),
    ...(metadata.upstreamCode === undefined ? {} : { upstreamCode: metadata.upstreamCode }),
    ...(metadata.requestId === undefined ? {} : { requestId: metadata.requestId }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
  };
}

