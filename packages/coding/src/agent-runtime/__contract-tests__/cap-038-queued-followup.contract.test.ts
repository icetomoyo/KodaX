/**
 * Contract test for CAP-038: queued follow-up detection
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-038-queued-follow-up-detection
 *
 * Test obligations:
 * - CAP-QUEUED-FOLLOWUP-001: returns true when events has a queued follow-up pending
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/event-emitter.ts (extracted from
 * agent.ts:769-771 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Time-ordering constraint: consulted at end-of-turn terminal decision
 * (4 call sites in agent.ts: success exit, COMPLETE signal, BLOCKED
 * signal, error path) to keep the loop running when the host has a
 * queued user input ready.
 *
 * Active here: the `events.hasPendingInputs?.() === true` predicate.
 * The strict `=== true` comparison is load-bearing — a host that returns
 * a truthy non-boolean (e.g. `1`, `"yes"`) must NOT trigger the loop
 * continuation, because the harness contract pins the return type to
 * `boolean | undefined`.
 *
 * STATUS: ACTIVE since FEATURE_100 P2.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXEvents } from '../../types.js';
import { hasQueuedFollowUp } from '../event-emitter.js';

describe('CAP-038: hasQueuedFollowUp contract', () => {
  it('CAP-QUEUED-FOLLOWUP-001a: events.hasPendingInputs returns true → true', () => {
    const events: KodaXEvents = { hasPendingInputs: () => true };
    expect(hasQueuedFollowUp(events)).toBe(true);
  });

  it('CAP-QUEUED-FOLLOWUP-001b: events.hasPendingInputs returns false → false', () => {
    const events: KodaXEvents = { hasPendingInputs: () => false };
    expect(hasQueuedFollowUp(events)).toBe(false);
  });

  it('CAP-QUEUED-FOLLOWUP-001c: hasPendingInputs hook absent → false (optional-chained, default-off behavior preserved for non-REPL embedders)', () => {
    expect(hasQueuedFollowUp({})).toBe(false);
  });

  it('CAP-QUEUED-FOLLOWUP-001d: strict `=== true` comparison rejects truthy non-boolean returns (host contract pins boolean)', () => {
    const events = {
      hasPendingInputs: () => 1 as unknown as boolean,
    } as unknown as KodaXEvents;
    expect(hasQueuedFollowUp(events)).toBe(false);
  });
});
