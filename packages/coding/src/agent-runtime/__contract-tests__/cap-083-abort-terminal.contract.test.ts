/**
 * Contract test for CAP-083: AbortError silent terminal branch
 * (Gemini CLI parity — interrupt as success).
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-083-aborterror-silent-terminal-branch-gemini-cli-parity--interrupt-as-success
 *
 * Test obligations:
 * - CAP-ABORT-TERMINAL-001: Ctrl+C returns success:true with interrupted flag
 * - CAP-ABORT-TERMINAL-002: onStreamEnd fires before return
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/catch-terminals.ts:applyAbortErrorTerminal
 * (extracted from agent.ts:1392-1408 — pre-FEATURE_100 baseline —
 * during FEATURE_100 P3.5d).
 *
 * Time-ordering constraint: AFTER catch cleanup chain (CAP-082);
 * BEFORE generic error path (CAP-084).
 *
 * Active here:
 *   - emits `events.onStreamEnd` (REPL-side observer)
 *   - emits `stream:end` extension event
 *   - the success/interrupted=true KodaXResult shape is the CALLER's
 *     responsibility (helper returns void); the CAP-001 invariant is
 *     pinned at the call site in agent.ts and via the P3.5 integration
 *     contract
 *
 * STATUS: ACTIVE since FEATURE_100 P3.5d.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXEvents } from '../../types.js';

import { applyAbortErrorTerminal } from '../catch-terminals.js';
import type { ExtensionEventEmitter } from '../stream-handler-wiring.js';

function fakeEmitter(): ExtensionEventEmitter {
  return vi.fn().mockResolvedValue(undefined) as unknown as ExtensionEventEmitter;
}

describe('CAP-083: applyAbortErrorTerminal — events fire', () => {
  it('CAP-ABORT-TERMINAL-002: emits events.onStreamEnd AND stream:end extension event', async () => {
    const onStreamEnd = vi.fn();
    const emit = fakeEmitter();
    await applyAbortErrorTerminal({
      events: { onStreamEnd } as unknown as KodaXEvents,
      emitActiveExtensionEvent: emit,
    });
    expect(onStreamEnd).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledExactlyOnceWith('stream:end', undefined);
  });

  it('CAP-ABORT-TERMINAL-002b: when onStreamEnd is undefined, only the extension event fires (REPL-side observer is optional)', async () => {
    const emit = fakeEmitter();
    await applyAbortErrorTerminal({
      events: {} as KodaXEvents,
      emitActiveExtensionEvent: emit,
    });
    expect(emit).toHaveBeenCalledExactlyOnceWith('stream:end', undefined);
  });
});
