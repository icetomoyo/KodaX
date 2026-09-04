/**
 * FEATURE_216 v0.7.45 — Provider credential verification orchestrator.
 *
 * Shared never-throws envelope + 3-primitive dispatch used by the
 * `verifyCredential()` overrides on the two compat base classes
 * (`KodaXAnthropicCompatProvider`, `KodaXOpenAICompatProvider`).
 *
 * Mirrors the abortCause-tracking pattern from `side-query.ts` so the
 * resulting `error` label is deterministic even when timeout and parent
 * abort fire near-simultaneously.
 *
 * The base class supplies a list of `VerifyPrimitiveRunner` closures —
 * one per primitive it can run with its specific SDK client. The
 * orchestrator dispatches by `strategy` (sourced from the config /
 * provider-capabilities.json), then catches and classifies any failure.
 *
 * "Strategy declared but no matching runner" returns `unsupported` with
 * a clear message — the config-time mismatch is surfaced loud instead
 * of silently downgrading to a different primitive.
 */

import type {
  KodaXVerifyCredentialResult,
  KodaXVerifyStrategy,
} from '../types.js';
import { redactScopedProviderCredential } from '../provider-credential-context.js';

export interface VerifyPrimitiveRunner {
  /** Strategy this runner implements. Orchestrator dispatches by name match. */
  readonly strategy: Exclude<KodaXVerifyStrategy, 'unsupported'>;
  /**
   * Run the verify primitive. Resolves on a 2xx response; throws on any
   * non-2xx, network error, timeout, or abort. The orchestrator catches
   * + classifies via `classifyVerifyError`.
   */
  run(signal: AbortSignal): Promise<void>;
  /**
   * Approx token spend reported in the result when the call succeeds.
   * `count-tokens` and `models-list` are true zero-token paths; only
   * `minimal-message` actually invokes the model (~6-7 tokens / call).
   */
  readonly approxTokensSpent: number;
}

export interface RunVerifyCredentialOpts {
  readonly strategy: KodaXVerifyStrategy;
  readonly runners: readonly VerifyPrimitiveRunner[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Optional provider identity used by `classifyVerifyError` for
   * provider-specific empirical workarounds (currently: kimi-code's
   * count_tokens-with-bad-key returns 400 instead of 401). Threading
   * the name keeps the workaround scoped — generic 400 responses on
   * other providers correctly stay as `unknown`.
   */
  readonly providerName?: string;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export async function runVerifyCredential(
  opts: RunVerifyCredentialOpts,
): Promise<KodaXVerifyCredentialResult> {
  if (opts.strategy === 'unsupported') {
    return {
      ok: false,
      error: 'unsupported',
      strategy: 'unsupported',
      durationMs: 0,
      approxTokensSpent: 0,
      message: 'Provider does not support credential verification',
    };
  }

  const runner = opts.runners.find((r) => r.strategy === opts.strategy);
  if (!runner) {
    return {
      ok: false,
      error: 'unsupported',
      strategy: opts.strategy,
      durationMs: 0,
      approxTokensSpent: 0,
      message: `verifyStrategy="${opts.strategy}" is not implemented for this provider's base class`,
    };
  }

  // Short-circuit when parent signal is already aborted at entry — no
  // point spinning up the runner just to immediately tear it down.
  if (opts.signal?.aborted) {
    return {
      ok: false,
      error: 'unknown',
      strategy: opts.strategy,
      durationMs: 0,
      approxTokensSpent: 0,
      message: 'caller aborted before verifyCredential started',
    };
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let abortCause: 'timeout' | 'parent' | undefined;
  const recordAbort = (cause: 'timeout' | 'parent'): void => {
    if (!abortCause) abortCause = cause;
    controller.abort();
  };
  const timeoutHandle = setTimeout(() => recordAbort('timeout'), timeoutMs);
  const onParentAbort = (): void => recordAbort('parent');
  if (opts.signal) {
    opts.signal.addEventListener('abort', onParentAbort, { once: true });
  }

  const t0 = Date.now();
  try {
    await runner.run(controller.signal);
    return {
      ok: true,
      strategy: opts.strategy,
      durationMs: Date.now() - t0,
      approxTokensSpent: runner.approxTokensSpent,
    };
  } catch (err) {
    return classifyVerifyError(err, {
      strategy: opts.strategy,
      durationMs: Date.now() - t0,
      approxTokensSpent: 0,
      abortCause,
      providerName: opts.providerName,
    });
  } finally {
    clearTimeout(timeoutHandle);
    if (opts.signal) {
      opts.signal.removeEventListener('abort', onParentAbort);
    }
  }
}

interface ClassifyContext {
  readonly strategy: KodaXVerifyStrategy;
  readonly durationMs: number;
  readonly approxTokensSpent: number;
  readonly abortCause?: 'timeout' | 'parent';
  /** Provider name for empirical-workaround scoping (see kimi-code 400 branch). */
  readonly providerName?: string;
}

/**
 * Redact common API-key prefixes (`sk-...`) from upstream error bodies
 * before they're surfaced in `result.message`. Some providers echo the
 * submitted key in their 401 body (e.g. DeepSeek: "your api key:
 * ****oute is invalid"). KodaX is a single-user CLI so the key already
 * belongs to the user reading the message, but SDK consumers may log
 * or display `message` in contexts where leaking the key fragment is
 * undesirable. The redaction is intentionally narrow — only matches
 * the `sk-` prefix family used by Anthropic / OpenAI / most compats.
 */
function redactKeyMaterial(raw: string): string {
  return raw.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***');
}

/**
 * Categorize a thrown error from a verify primitive into the stable
 * `KodaXVerifyCredentialResult.error` enum. Classification order:
 *
 *   1. Abort cause (timeout vs parent) wins over everything — the
 *      controller fired before any HTTP error class was assigned.
 *   2. SDK error class name (`AuthenticationError` / `PermissionDeniedError`)
 *      maps directly to `unauthorized` — both Anthropic and OpenAI
 *      SDKs use these consistently regardless of underlying HTTP code
 *      (kimi-code returns 400 but class is still AuthenticationError).
 *   3. HTTP status fallbacks (401/403/5xx).
 *   4. Network error codes from the underlying socket layer.
 *   5. Everything else → `unknown` with the upstream message preserved
 *      (truncated to 240 chars) so the caller can surface diagnostics.
 */
export function classifyVerifyError(
  err: unknown,
  ctx: ClassifyContext,
): KodaXVerifyCredentialResult {
  const safeError = redactScopedProviderCredential(err);
  const errObj = safeError as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
    message?: string;
    cause?: { code?: string };
    code?: string;
    constructor?: { name?: string };
  };
  const status =
    errObj.status ??
    errObj.statusCode ??
    errObj.response?.status;
  const message = redactKeyMaterial(String(errObj.message ?? safeError)).slice(0, 240);
  const errCode = errObj.cause?.code ?? errObj.code;
  const className = errObj.constructor?.name ?? '';

  let error: NonNullable<KodaXVerifyCredentialResult['error']>;

  if (ctx.abortCause === 'timeout') {
    error = 'timeout';
  } else if (ctx.abortCause === 'parent') {
    error = 'unknown';
  } else if (
    className === 'AuthenticationError' ||
    className === 'PermissionDeniedError'
  ) {
    error = 'unauthorized';
  } else if (status === 401 || status === 403) {
    error = 'unauthorized';
  } else if (status === 429) {
    // FEATURE_216 v0.7.45 — provider rate-limited the verify probe.
    // Distinct from `unauthorized` (key valid but currently throttled)
    // so UI consumers can surface "try again in a moment" instead of
    // misleading "invalid key". The verify primitives shouldn't trip
    // rate limits at UI button frequency, but upstream may already be
    // throttling the account from concurrent stream() traffic.
    error = 'rate_limited';
  } else if (
    status === 400 &&
    ctx.strategy === 'count-tokens' &&
    ctx.providerName === 'kimi-code'
  ) {
    // kimi-code-specific empirical behavior: bad credential on the
    // `messages.count_tokens` endpoint returns 400 (not 401) with a
    // generic `invalid_request_error` class — NOT an `AuthenticationError`
    // class (which is why the className check above doesn't catch it).
    // Confirmed by the 2026-05-28 probe matrix (probe-alt-endpoints.mjs)
    // AND by integration test `kimi-code fake key → ok:false, error="unauthorized"`.
    // Scoping by providerName prevents false-positive `unauthorized` if
    // any other count-tokens provider returns 400 for a legitimate
    // reason (bad model id, schema mismatch, etc.).
    error = 'unauthorized';
  } else if (status !== undefined && status >= 500 && status < 600) {
    error = 'server_error';
  } else if (
    errCode !== undefined &&
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|EPIPE|ETIMEDOUT|ENETUNREACH|ENETDOWN|EHOSTUNREACH/i.test(errCode)
  ) {
    error = 'network';
  } else if (/timeout/i.test(message)) {
    error = 'timeout';
  } else {
    error = 'unknown';
  }

  return {
    ok: false,
    error,
    status,
    message,
    durationMs: ctx.durationMs,
    approxTokensSpent: ctx.approxTokensSpent,
    strategy: ctx.strategy,
  };
}
