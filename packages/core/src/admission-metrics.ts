/**
 * FEATURE_101 v0.7.31.1 — admission metrics counters.
 *
 * Closes the "admission decoration" risk called out in
 * docs/features/v0.7.31.md §dispatch eval 新增指标. v0.7.31 declared
 * three metrics in the design (`admission_reject_after_retry_rate`,
 * `admission_clamp_rate`, `invariant_violation_rate`) but never emitted
 * them at runtime — leaving operators with no signal on whether
 * admission was actually catching things or had become a no-op.
 *
 * The module exports an in-process counter table plus pure helpers to
 * read / reset / compute rates. Counters increment from:
 *
 *   - `runAdmissionAudit` on every verdict (ok / ok+clamp / reject /
 *     reject-final).
 *   - `InvariantSession.recordX` and `assertTerminal` on every
 *     observed violation.
 *
 * Reading the rates:
 *
 *   - `admission_clamp_rate`              = admitOkClamped / admitTotal
 *   - `admission_reject_after_retry_rate` = admitRejectFinal / admitTotal
 *   - `invariant_violation_rate`          = invariantViolations / admitTotal
 *
 * Counters are process-local — exporters (Prometheus, OpenTelemetry,
 * etc.) are expected to scrape `getAdmissionMetricsSnapshot()` on a
 * cadence. `_resetAdmissionMetrics` is for tests; production never
 * calls it.
 */

/**
 * Mutable counter table. Single shared instance — admission emits
 * deterministically synchronous, so racing increments aren't a
 * concern in the Node runtime.
 */
interface MutableAdmissionMetrics {
  admitTotal: number;
  admitOk: number;
  admitOkClamped: number;
  admitReject: number;
  admitRejectFinal: number;
  invariantViolationsObserved: number;
  invariantViolationsTerminal: number;
}

const _counters: MutableAdmissionMetrics = {
  admitTotal: 0,
  admitOk: 0,
  admitOkClamped: 0,
  admitReject: 0,
  admitRejectFinal: 0,
  invariantViolationsObserved: 0,
  invariantViolationsTerminal: 0,
};

export interface AdmissionMetricsSnapshot {
  readonly admitTotal: number;
  readonly admitOk: number;
  readonly admitOkClamped: number;
  readonly admitReject: number;
  readonly admitRejectFinal: number;
  readonly invariantViolationsObserved: number;
  readonly invariantViolationsTerminal: number;
  readonly admissionClampRate: number;
  readonly admissionRejectAfterRetryRate: number;
  readonly invariantViolationRate: number;
}

function safeRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

/**
 * Snapshot of current counters + computed rates. Returned object is a
 * fresh copy — mutating it does NOT affect the live counters.
 */
export function getAdmissionMetricsSnapshot(): AdmissionMetricsSnapshot {
  const total = _counters.admitTotal;
  return {
    admitTotal: _counters.admitTotal,
    admitOk: _counters.admitOk,
    admitOkClamped: _counters.admitOkClamped,
    admitReject: _counters.admitReject,
    admitRejectFinal: _counters.admitRejectFinal,
    invariantViolationsObserved: _counters.invariantViolationsObserved,
    invariantViolationsTerminal: _counters.invariantViolationsTerminal,
    admissionClampRate: safeRate(_counters.admitOkClamped, total),
    admissionRejectAfterRetryRate: safeRate(_counters.admitRejectFinal, total),
    invariantViolationRate: safeRate(
      _counters.invariantViolationsObserved + _counters.invariantViolationsTerminal,
      total,
    ),
  };
}

/**
 * Test-only reset. Production code MUST NOT call this — the counters
 * are designed to accumulate across the process lifetime.
 */
export function _resetAdmissionMetrics(): void {
  _counters.admitTotal = 0;
  _counters.admitOk = 0;
  _counters.admitOkClamped = 0;
  _counters.admitReject = 0;
  _counters.admitRejectFinal = 0;
  _counters.invariantViolationsObserved = 0;
  _counters.invariantViolationsTerminal = 0;
}

// ---------------------------------------------------------------------------
// Internal increment helpers — called from admission-audit and
// admission-session. Not exported in @kodax/core's public surface.
// ---------------------------------------------------------------------------

/** @internal */
export function _incAdmitTotal(): void {
  _counters.admitTotal += 1;
}
/** @internal */
export function _incAdmitOk(clamped: boolean): void {
  _counters.admitOk += 1;
  if (clamped) _counters.admitOkClamped += 1;
}
/** @internal */
export function _incAdmitReject(retryable: boolean): void {
  _counters.admitReject += 1;
  if (!retryable) _counters.admitRejectFinal += 1;
}
/** @internal */
export function _incInvariantViolation(stage: 'observe' | 'terminal'): void {
  if (stage === 'observe') _counters.invariantViolationsObserved += 1;
  else _counters.invariantViolationsTerminal += 1;
}

// ---------------------------------------------------------------------------
// KODAX_DEBUG_ADMISSION — verbose verdict log helper.
// ---------------------------------------------------------------------------

/**
 * Returns true when the admission debug flag is set in the environment.
 * Recognises `'1'`, `'true'`, `'yes'`, `'on'` (case-insensitive).
 * Falls through to false on unset / empty / any other value, so the
 * default is silent.
 */
export function isAdmissionDebugEnabled(): boolean {
  const raw = process.env.KODAX_DEBUG_ADMISSION;
  if (!raw) return false;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}
