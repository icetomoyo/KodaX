/**
 * Resilience debug telemetry — CAP-036
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-036-resilience-debug-telemetry
 *
 * Env-gated stderr emitter used at retry / fallback / overflow decision
 * points so that flaky provider behaviour can be reconstructed after the
 * fact without leaving telemetry on by default. Two env vars enable the
 * channel — `KODAX_DEBUG_STREAM=1` (broader streaming debug) or
 * `KODAX_DEBUG_RESILIENCE=1` (narrow) — either suffices.
 *
 * Output format is intentionally `console.error(label, payload)` so the
 * structured payload is preserved for log scrapers; do NOT swap to
 * `JSON.stringify` here — the call sites pass shape-matched objects that
 * a downstream pipeline parses field-by-field.
 *
 * Migration history: extracted from `agent.ts:886-895` (pre-FEATURE_100 baseline)
 * during FEATURE_100 P2.
 */

export function shouldDebugResilience(): boolean {
  return process.env.KODAX_DEBUG_STREAM === '1' || process.env.KODAX_DEBUG_RESILIENCE === '1';
}

export function emitResilienceDebug(label: string, payload: Record<string, unknown>): void {
  if (!shouldDebugResilience()) {
    return;
  }
  console.error(label, payload);
}
