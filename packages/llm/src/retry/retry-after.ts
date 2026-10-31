/**
 * Retry-After header parsing — FEATURE_130 (v0.7.36).
 *
 * Handles the four forms KodaX's built-in provider adapters encounter when a
 * model returns 429 (rate limit) or 503/529 (overloaded):
 *
 *   1. `Retry-After: 120`               — integer seconds (HTTP 7231 standard)
 *   2. `Retry-After: <HTTP-date>`       — RFC 7231 IMF-fixdate
 *      e.g. "Wed, 21 Oct 2026 07:28:00 GMT"
 *   3. `retry-after-ms: 45000`          — Anthropic millisecond extension
 *   4. (no Retry-After header present)  — falls back to exponential backoff
 *      capped at `maxBackoffMs`, with optional jitter for the
 *      "thundering herd" protection.
 *
 * All return values are normalized to whole milliseconds and clamped to
 * a sensible upper bound — never block the user for more than 120s, and
 * never honor a header advertising a wait longer than `maxHeaderWaitMs`
 * (default 120s). Beyond that limit we still extract the header but cap
 * it; the calling provider can check `cappedFromHeader` to decide
 * whether to surface a "rate limit exceeded — please wait" error to the
 * user instead of silently sleeping for two minutes.
 *
 * Pattern-B (FEATURE_119) interaction: the helper is referentially
 * transparent and stateless — it can be invoked concurrently by N
 * parallel children without coordination. The retry loop in each
 * provider holds its own attempt counter; this helper only translates
 * headers/attempts into wait durations.
 *
 * Reference: opencode session/retry.ts:14-123 (4-form coverage).
 */

export type RetryAfterSource =
  | 'retry-after-seconds'
  | 'retry-after-date'
  | 'retry-after-ms'
  | 'exponential-backoff';

export type RetryAfterResult =
  | {
      readonly type: 'header';
      readonly waitMs: number;
      readonly source: 'retry-after-seconds' | 'retry-after-date' | 'retry-after-ms';
      /** True when the header value exceeded `maxHeaderWaitMs` and was clamped. */
      readonly cappedFromHeader: boolean;
    }
  | {
      readonly type: 'backoff';
      readonly waitMs: number;
      readonly source: 'exponential-backoff';
      readonly attempt: number;
    };

export interface ParseRetryAfterOptions {
  /** Zero-based attempt index used by the backoff branch (0 = first retry). */
  readonly attempt: number;
  /** Base delay for exponential backoff. Default 1000ms. */
  readonly baseBackoffMs?: number;
  /** Maximum exponential backoff cap. Default 30000ms. */
  readonly maxBackoffMs?: number;
  /** Maximum wait honored from a header. Default 120000ms. */
  readonly maxHeaderWaitMs?: number;
  /**
   * Override the "now" reference used by the HTTP-date branch.
   * Test-only escape hatch — production code should leave this undefined.
   */
  readonly now?: () => number;
  /**
   * Whether the backoff branch adds 0-25% jitter on top of the base
   * exponential. Default true (matches the legacy `withRateLimit`
   * jitter contract). Tests can pass `false` for deterministic output.
   */
  readonly withJitter?: boolean;
}

const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_MAX_HEADER_WAIT_MS = 120_000;

type HeadersLike = Headers | Record<string, string | string[] | undefined> | undefined;

export function readHeader(headers: HeadersLike, name: string): string | undefined {
  if (!headers) return undefined;
  // Web `Headers` object — case-insensitive lookup.
  if (typeof (headers as Headers).get === 'function') {
    const value = (headers as Headers).get(name);
    return value ?? undefined;
  }
  // Plain object — try exact-case + lowercase + Title-Case.
  const obj = headers as Record<string, string | string[] | undefined>;
  const lower = name.toLowerCase();
  const candidate =
    obj[name]
    ?? obj[lower]
    ?? obj[lower.replace(/\b\w/g, (c) => c.toUpperCase())];
  if (candidate === undefined) return undefined;
  if (Array.isArray(candidate)) return candidate[0];
  return candidate;
}

function parsePositiveNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function parseHttpDate(raw: string | undefined, now: number): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const ts = Date.parse(trimmed);
  if (!Number.isFinite(ts)) return undefined;
  const delta = ts - now;
  return delta > 0 ? delta : undefined;
}

/**
 * Parse rate-limit/overload retry-after headers (4 forms) and decide
 * how long the caller should sleep before retrying. Returns either:
 *
 *  - `{type: 'header', ...}` when one of the supported headers was found
 *    and converted into a wait duration; OR
 *  - `{type: 'backoff', ...}` falling back to exponential backoff for
 *    the given `attempt` index when no header is present.
 */
export function parseRetryAfter(
  headers: HeadersLike,
  options: ParseRetryAfterOptions,
): RetryAfterResult {
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const maxHeaderWaitMs = options.maxHeaderWaitMs ?? DEFAULT_MAX_HEADER_WAIT_MS;
  const now = options.now ? options.now() : Date.now();

  // Anthropic millisecond extension takes precedence: it's the most
  // precise and only present when the provider explicitly emits it.
  const retryAfterMs = parsePositiveNumber(readHeader(headers, 'retry-after-ms'));
  if (retryAfterMs !== undefined) {
    const clamped = Math.min(retryAfterMs, maxHeaderWaitMs);
    return {
      type: 'header',
      waitMs: Math.round(clamped),
      source: 'retry-after-ms',
      cappedFromHeader: clamped !== retryAfterMs,
    };
  }

  // Standard `Retry-After` header may be either integer seconds or an
  // HTTP-date. Parse as a number first; fall back to date.
  const retryAfterRaw = readHeader(headers, 'retry-after');
  if (retryAfterRaw !== undefined && retryAfterRaw.trim().length > 0) {
    const seconds = parsePositiveNumber(retryAfterRaw);
    if (seconds !== undefined) {
      const ms = seconds * 1000;
      const clamped = Math.min(ms, maxHeaderWaitMs);
      return {
        type: 'header',
        waitMs: Math.round(clamped),
        source: 'retry-after-seconds',
        cappedFromHeader: clamped !== ms,
      };
    }
    const dateDelta = parseHttpDate(retryAfterRaw, now);
    if (dateDelta !== undefined) {
      const clamped = Math.min(dateDelta, maxHeaderWaitMs);
      return {
        type: 'header',
        waitMs: Math.round(clamped),
        source: 'retry-after-date',
        cappedFromHeader: clamped !== dateDelta,
      };
    }
  }

  // No usable header — exponential backoff with optional jitter.
  const exp = baseBackoffMs * Math.pow(2, Math.max(0, options.attempt));
  const baseDelay = Math.min(exp, maxBackoffMs);
  const withJitter = options.withJitter !== false;
  const jitter = withJitter ? Math.random() * 0.25 * baseDelay : 0;
  return {
    type: 'backoff',
    waitMs: Math.round(baseDelay + jitter),
    source: 'exponential-backoff',
    attempt: options.attempt,
  };
}

/**
 * Pull headers off a thrown error in the various shapes produced across
 * provider SDKs (Anthropic, OpenAI, fetch-based custom providers).
 * Returns `undefined` when no headers can be located — the helper then
 * falls through to exponential backoff.
 */
export function extractHeadersFromError(error: unknown): HeadersLike {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as {
    headers?: HeadersLike;
    response?: { headers?: HeadersLike };
    cause?: { headers?: HeadersLike; response?: { headers?: HeadersLike } };
  };
  return (
    e.headers
    ?? e.response?.headers
    ?? e.cause?.headers
    ?? e.cause?.response?.headers
  );
}
