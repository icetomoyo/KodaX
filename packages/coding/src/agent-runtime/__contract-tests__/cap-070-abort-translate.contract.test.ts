/**
 * Contract test for CAP-070: AbortError → KodaXNetworkError translation
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-070-aborterror--kodaxnetworkerror-translation
 *
 * Test obligations:
 * - CAP-ABORT-TRANSLATE-001: internal timeout abort → KodaXNetworkError; user abort passes through unchanged
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/provider-retry-policy.ts (extracted
 * from agent.ts:880-884 — pre-FEATURE_100 baseline — during FEATURE_100 P3.2e)
 *
 * Time-ordering constraint: BEFORE classifyResilienceError; immediately after catch.
 *
 * Active here:
 *   - retry-timer abort + no caller abort → translate to KodaXNetworkError(transient=true)
 *   - caller-driven abort (user Ctrl+C) → passes through unchanged (so the
 *     downstream catch path can distinguish user-cancel from timer-stall)
 *   - non-AbortError → passes through unchanged
 *
 * STATUS: ACTIVE since FEATURE_100 P3.2e.
 */

import { describe, expect, it } from 'vitest';

import { translateAbortError } from '../provider-retry-policy.js';

function makeAbortError(message = 'aborted'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

describe('CAP-070: translateAbortError', () => {
  it('CAP-ABORT-TRANSLATE-001a: AbortError + retry-timer aborted + no caller abort → KodaXNetworkError(transient=true)', async () => {
    const retryCtrl = new AbortController();
    retryCtrl.abort(new Error('Stream stalled (60000ms idle)'));

    const result = await translateAbortError(makeAbortError(), retryCtrl, undefined);

    expect(result.constructor.name).toBe('KodaXNetworkError');
    expect(result.message).toMatch(/Stream stalled/);
    // KodaXNetworkError carries `transient: true` when caused by stall;
    // we don't tightly couple to the field name (it's @kodax/ai's
    // contract), only that the resulting class is the network-error one.
  });

  it('CAP-ABORT-TRANSLATE-001b: AbortError + caller signal also aborted → passes through (user cancel)', async () => {
    const retryCtrl = new AbortController();
    retryCtrl.abort(new Error('Stream stalled'));
    const callerCtrl = new AbortController();
    callerCtrl.abort(new Error('user Ctrl+C'));

    const original = makeAbortError('user-cancel');
    const result = await translateAbortError(original, retryCtrl, callerCtrl.signal);

    expect(result).toBe(original); // reference-equal pass-through
  });

  it('CAP-ABORT-TRANSLATE-001c: non-AbortError passes through unchanged', async () => {
    const retryCtrl = new AbortController();
    retryCtrl.abort(new Error('Stream stalled'));

    const original = new Error('boom');
    const result = await translateAbortError(original, retryCtrl, undefined);

    expect(result).toBe(original);
  });

  it('CAP-ABORT-TRANSLATE-001d: AbortError but retry timer NOT aborted (e.g., synthetic from elsewhere) → passes through', async () => {
    const retryCtrl = new AbortController(); // never aborted

    const original = makeAbortError();
    const result = await translateAbortError(original, retryCtrl, undefined);

    expect(result).toBe(original);
  });

  it('CAP-ABORT-TRANSLATE-001e: retry-timer aborted with no explicit reason → still translates to KodaXNetworkError (using synthesized message)', async () => {
    const retryCtrl = new AbortController();
    retryCtrl.abort(); // abort with no explicit reason — Node synthesizes DOMException

    const result = await translateAbortError(makeAbortError(), retryCtrl, undefined);

    // Translation still happens (the gate is "AbortError + retry timer aborted",
    // not "reason has a specific message"). The carried message comes from
    // signal.reason if available, else falls back to "Stream stalled".
    expect(result.constructor.name).toBe('KodaXNetworkError');
  });
});
