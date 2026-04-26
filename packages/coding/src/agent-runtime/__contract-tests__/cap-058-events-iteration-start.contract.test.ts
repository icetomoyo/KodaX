/**
 * Contract test for CAP-058: events.onIterationStart event
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-058-eventsoniterationstart-event
 *
 * Test obligations:
 * - CAP-EVENTS-ITERATION-START-001: fires at start of each turn with correct iter/maxIter values
 *
 * Risk: LOW
 *
 * Class: 2
 *
 * Verified location: agent-runtime/event-emitter.ts (extracted from
 * agent.ts:577 — pre-FEATURE_100 baseline — during FEATURE_100 P3.1)
 *
 * Time-ordering constraint: AFTER turn:start extension event; BEFORE microcompact (CAP-014).
 *
 * Active here:
 *   - 0-based `iter` at the call site translates to 1-based at the event
 *     (i.e. user-facing "iteration 1 of 200" not "iteration 0 of 200")
 *   - missing handler must not throw
 *
 * STATUS: ACTIVE since FEATURE_100 P3.1.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXEvents } from '../../types.js';

import { emitIterationStart } from '../event-emitter.js';

function fakeEvents(overrides: Partial<KodaXEvents> = {}): KodaXEvents {
  return overrides as unknown as KodaXEvents;
}

describe('CAP-058: emitIterationStart — events.onIterationStart', () => {
  it('CAP-EVENTS-ITERATION-START-001a: fires events.onIterationStart with iter+1 (1-based) and maxIter', () => {
    const onIterationStart = vi.fn();
    const events = fakeEvents({ onIterationStart });
    emitIterationStart(events, 0, 200);
    expect(onIterationStart).toHaveBeenCalledExactlyOnceWith(1, 200);
  });

  it('CAP-EVENTS-ITERATION-START-001b: 0-based iter at call site is translated to 1-based event', () => {
    const onIterationStart = vi.fn();
    const events = fakeEvents({ onIterationStart });
    emitIterationStart(events, 5, 200);
    expect(onIterationStart).toHaveBeenCalledExactlyOnceWith(6, 200);
  });

  it('CAP-EVENTS-ITERATION-START-001c: missing onIterationStart handler does not throw', () => {
    const events = fakeEvents({}); // no handler
    expect(() => emitIterationStart(events, 0, 200)).not.toThrow();
  });
});
