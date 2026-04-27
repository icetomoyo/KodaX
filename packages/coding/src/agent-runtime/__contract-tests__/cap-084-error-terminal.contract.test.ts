/**
 * Contract test for CAP-084: generic error terminal path.
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-084-generic-error-terminal-path
 *
 * Test obligations:
 * - CAP-ERROR-TERMINAL-001: success:false + cleaned messages
 * - CAP-ERROR-TERMINAL-002: error metadata propagates to result
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/catch-terminals.ts:applyGenericErrorTerminal
 * (extracted from agent.ts:1411-1421 — pre-FEATURE_100 baseline —
 * during FEATURE_100 P3.5d).
 *
 * Time-ordering constraint: AFTER AbortError check (CAP-083).
 *
 * Active here:
 *   - emits `error` extension event
 *   - emits `events.onError(error)` (CAP-006 calling site)
 *   - the {success:false, ...} KodaXResult shape is the CALLER's
 *     responsibility; CAP-001 message-cleanliness invariant is
 *     pinned by CAP-082's contract and the P3.5 integration test
 *
 * STATUS: ACTIVE since FEATURE_100 P3.5d.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXEvents } from '../../types.js';

import { applyGenericErrorTerminal } from '../catch-terminals.js';
import type { ExtensionEventEmitter } from '../stream-handler-wiring.js';

function fakeEmitter(): ExtensionEventEmitter {
  return vi.fn().mockResolvedValue(undefined) as unknown as ExtensionEventEmitter;
}

describe('CAP-084: applyGenericErrorTerminal — events fire', () => {
  it('CAP-ERROR-TERMINAL-001: emits `error` extension event with the error payload AND events.onError(error)', async () => {
    const onError = vi.fn();
    const emit = fakeEmitter();
    const error = new Error('something broke');

    await applyGenericErrorTerminal({
      error,
      events: { onError } as unknown as KodaXEvents,
      emitActiveExtensionEvent: emit,
    });

    expect(emit).toHaveBeenCalledExactlyOnceWith('error', { error });
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it('CAP-ERROR-TERMINAL-002: when events.onError is undefined, only the extension event fires (REPL-side observer is optional)', async () => {
    const emit = fakeEmitter();
    const error = new Error('boom');
    await applyGenericErrorTerminal({
      error,
      events: {} as KodaXEvents,
      emitActiveExtensionEvent: emit,
    });
    expect(emit).toHaveBeenCalledExactlyOnceWith('error', { error });
  });
});
