/**
 * Contract test for CAP-039: promise-signal split for thinking-mode replay
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-039-promise-signal-split-for-thinking-mode-replay
 *
 * Test obligations:
 * - CAP-PROMISE-SIGNAL-001: signal extracted, residual text preserved
 *
 * Risk: MEDIUM — interacts with provider thinking-mode hardening
 * (recent v0.7.27/v0.7.28 commits). Pattern grammar lives in
 * `@kodax/agent` constants; tests pin both the recogniser and the
 * uppercase / residual-capture conventions.
 *
 * Class: 1
 *
 * Verified location: agent-runtime/thinking-mode-replay.ts (extracted from
 * agent.ts:763-767 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Time-ordering constraint: AFTER provider stream produces text; BEFORE
 * history append.
 *
 * STATUS: ACTIVE since FEATURE_100 P2.
 */

import { describe, expect, it } from 'vitest';

import { checkPromiseSignal } from '../thinking-mode-replay.js';

describe('CAP-039: promise-signal split for thinking-mode replay contract', () => {
  it('CAP-PROMISE-SIGNAL-001a: <promise>COMPLETE</promise> → ["COMPLETE", ""] (uppercase + empty residual)', () => {
    const [signal, residual] = checkPromiseSignal('Done. <promise>COMPLETE</promise>');
    expect(signal).toBe('COMPLETE');
    expect(residual).toBe('');
  });

  it('CAP-PROMISE-SIGNAL-001b: <promise>BLOCKED:reason text</promise> → ["BLOCKED", "reason text"]', () => {
    const [signal, residual] = checkPromiseSignal('<promise>BLOCKED:waiting on user clarification</promise>');
    expect(signal).toBe('BLOCKED');
    expect(residual).toBe('waiting on user clarification');
  });

  it('CAP-PROMISE-SIGNAL-001c: lowercase tag normalised to uppercase (signal name is case-insensitive on input)', () => {
    const [signal, residual] = checkPromiseSignal('<promise>decide:should we ship?</promise>');
    expect(signal).toBe('DECIDE');
    expect(residual).toBe('should we ship?');
  });

  it('CAP-PROMISE-SIGNAL-001d: no signal in text → ["", ""] (empty-empty sentinel, NOT throw)', () => {
    const [signal, residual] = checkPromiseSignal('Just normal assistant text with no harness tag.');
    expect(signal).toBe('');
    expect(residual).toBe('');
  });

  it('CAP-PROMISE-SIGNAL-001e: unknown tag (e.g. <promise>UNKNOWN</promise>) → no match, returns ["", ""]', () => {
    // Pattern only allows COMPLETE | BLOCKED | DECIDE; arbitrary tags must not
    // match — otherwise harness lifecycle could be tricked into advancing on
    // model hallucination.
    const [signal, residual] = checkPromiseSignal('<promise>SHIPIT</promise>');
    expect(signal).toBe('');
    expect(residual).toBe('');
  });

  it('CAP-PROMISE-SIGNAL-001f: dot-all flag — payload may contain newlines and is captured intact', () => {
    const [signal, residual] = checkPromiseSignal('<promise>BLOCKED:line one\nline two</promise>');
    expect(signal).toBe('BLOCKED');
    expect(residual).toBe('line one\nline two');
  });
});
