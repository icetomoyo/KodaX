/**
 * Passive capability learning — reasoning-effort rejection classifier.
 *
 * Detects the narrow case where a provider HARD-rejects a reasoning-effort
 * parameter (e.g. GLM 400s on `reasoning_effort: max`). Ground truth for
 * narrowing the ladder: a rejection proves non-support, whereas a success
 * proves nothing (a provider may silently alias/clamp). So this classifier is
 * deliberately CONSERVATIVE — it only fires when the error clearly names the
 * reasoning-effort parameter, never on generic 400s, auth, rate-limit, or
 * content errors. A false positive would wrongly disable a working rung, so
 * "uncertain → not a rejection".
 */

function getStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  const direct = record.status ?? record.statusCode ?? record.code;
  if (typeof direct === 'number' && Number.isInteger(direct)) {
    return direct;
  }
  if (typeof direct === 'string' && /^\d{3}$/.test(direct)) {
    return Number(direct);
  }
  return getStatus(record.cause);
}

function getMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.toLowerCase();
  }
  if (typeof error === 'string') {
    return error.toLowerCase();
  }
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const parts = [record.message, record.error, record.detail, record.body]
      .filter((p): p is string => typeof p === 'string');
    return parts.join(' ').toLowerCase();
  }
  return '';
}

// The parameter must be named for this to count as a reasoning-effort rejection.
const EFFORT_PARAM_MARKERS = [
  'reasoning_effort',
  'reasoning effort',
  'reasoninglevel',
  'reasoning_level',
  'reasoning.effort',
  'thinking.effort',
  'thinking.type',
];

// Plus a signal that the value/param was rejected (not merely mentioned).
const REJECTION_MARKERS = [
  'unsupported',
  'not supported',
  'invalid',
  'does not support',
  'is not one of',
  'not allowed',
  'unknown',
  'unexpected',
  'unrecognized',
];

const EFFORT_VALUES = ['minimal', 'none', 'low', 'medium', 'high', 'xhigh', 'max'];

function namesRejectedEffort(message: string): boolean {
  const parameter = `(?:${EFFORT_PARAM_MARKERS.map(marker => marker.replaceAll('.', '\\.')).join('|')})`;
  const rejected = `(?:${REJECTION_MARKERS.join('|')})`;
  const quote = '[\'"`][^\'"`\\n]{0,80}[\'"`]';
  const punctuation = "[\\s'\"`:]";
  const before = `(?:${punctuation}|\\b(?:value|parameter|field|for|of|the)\\b|${quote})*`;
  const after = `(?:${punctuation}|\\b(?:value|parameter|is)\\b|${quote})*`;
  return new RegExp(`${rejected}${before}${parameter}\\b|${parameter}${after}${rejected}`).test(message);
}

/**
 * Try to recover WHICH effort the provider rejected from the error text, so the
 * narrowing is precise. Returns the sent effort when the message doesn't name a
 * value (the most reliable fallback), or undefined when neither is available.
 */
function extractRejectedEffort(message: string, sentEffort: string | undefined): string | undefined {
  if (sentEffort !== undefined) return sentEffort;
  for (const value of EFFORT_VALUES) {
    // Quote-or-boundary match so "high" doesn't trip on "xhigh".
    if (new RegExp(`['"\`]${value}['"\`]`).test(message)) {
      return value;
    }
  }
  return sentEffort;
}

export interface ReasoningEffortRejection {
  readonly rejectedEffort: string;
  readonly parameterRejected?: true;
  readonly parameter?: string;
}

/**
 * Classify an error as a reasoning-effort rejection. `sentEffort` is the effort
 * that was on the wire (used when the error doesn't echo a value). Returns the
 * rejected effort, or null when this is not (clearly) an effort rejection.
 */
export function classifyReasoningEffortRejection(
  error: unknown,
  sentEffort: string | undefined,
): ReasoningEffortRejection | null {
  const status = getStatus(error);
  // Require a real wire parameter-rejection status (400/422). A missing status
  // means a LOCAL pre-flight throw (e.g. `validateExplicitReasoningEffort`
  // rejecting an explicitly-requested unsupported effort) — that must surface
  // as-is, never trigger a passive-learning retry. 401/403/429/5xx are not it.
  if (status !== 400 && status !== 422) {
    return null;
  }
  const message = getMessage(error);
  if (!message) {
    return null;
  }
  const parameter = /(?:unknown|unrecognized|unexpected|unsupported|not supported)\s+(?:parameter|field|argument)s?\s*:?\s*['"`]*(reasoning_effort|reasoning\b|thinking\b|enable_thinking|thinking_budget|budget_tokens)/.exec(message)?.[1]
    ?? /\b(enable_thinking|thinking_budget|budget_tokens)\b['"`]*\s+(?:is\s+)?(?:unsupported|not supported)/.exec(message)?.[1]
    ?? /does not support\s+(?:the\s+)?['"`]*(reasoning_effort|reasoning|thinking)['"`]*\s+(?:parameter|field)/.exec(message)?.[1];
  if (parameter) {
    return { rejectedEffort: sentEffort ?? '*', parameterRejected: true, parameter };
  }
  if (!namesRejectedEffort(message)) {
    return null;
  }
  const rejectedEffort = extractRejectedEffort(message, sentEffort);
  if (!rejectedEffort) {
    return null;
  }
  return { rejectedEffort };
}
