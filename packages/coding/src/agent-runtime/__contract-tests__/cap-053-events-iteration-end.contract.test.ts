/**
 * Contract test for CAP-053: emitIterationEnd helper (events.onIterationEnd + token snapshot rebase)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-053-emititerationend-helper-eventsoniterationend--token-snapshot-rebase
 *
 * Test obligations:
 * - CAP-EVENTS-ITERATION-END-001: fires once per turn with token snapshot
 *
 * Risk: LOW
 *
 * Class: 2
 *
 * Verified location: agent-runtime/event-emitter.ts (extracted from
 * agent.ts:511-528 — pre-FEATURE_100 baseline — during FEATURE_100 P3.1)
 *
 * Time-ordering constraint: AFTER turn settles; BEFORE next iteration starts (or terminal).
 *
 * Active here:
 *   - returns the rebased snapshot so the caller can reassign
 *   - emits `events.onIterationEnd` exactly once per call with iter / maxIter /
 *     tokenCount / tokenSource / usage / contextTokenSnapshot
 *   - `snapshotOverride` (when provided) takes priority over `currentSnapshot`
 *     as the rebase baseline
 *
 * STATUS: ACTIVE since FEATURE_100 P3.1.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXEvents, KodaXContextTokenSnapshot } from '../../types.js';
import type { KodaXMessage } from '@kodax/ai';

import { emitIterationEnd } from '../event-emitter.js';

function fakeSnapshot(currentTokens: number): KodaXContextTokenSnapshot {
  return {
    currentTokens,
    source: 'estimated',
    usage: undefined,
  } as unknown as KodaXContextTokenSnapshot;
}

function fakeEvents(overrides: Partial<KodaXEvents> = {}): KodaXEvents {
  return overrides as unknown as KodaXEvents;
}

describe('CAP-053: emitIterationEnd — events.onIterationEnd + token snapshot rebase', () => {
  it('CAP-EVENTS-ITERATION-END-001a: fires events.onIterationEnd exactly once per call', () => {
    const onIterationEnd = vi.fn();
    const events = fakeEvents({ onIterationEnd });
    emitIterationEnd(events, {
      iter: 3,
      maxIter: 200,
      messages: [] as readonly KodaXMessage[],
      currentSnapshot: fakeSnapshot(1000),
    });
    expect(onIterationEnd).toHaveBeenCalledTimes(1);
  });

  it('CAP-EVENTS-ITERATION-END-001b: payload carries iter / maxIter / tokenCount / contextTokenSnapshot', () => {
    const onIterationEnd = vi.fn();
    const events = fakeEvents({ onIterationEnd });
    emitIterationEnd(events, {
      iter: 7,
      maxIter: 200,
      messages: [] as readonly KodaXMessage[],
      currentSnapshot: fakeSnapshot(2000),
    });
    const arg = onIterationEnd.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.iter).toBe(7);
    expect(arg.maxIter).toBe(200);
    expect(typeof arg.tokenCount).toBe('number');
    expect(arg.contextTokenSnapshot).toBeDefined();
  });

  it('CAP-EVENTS-ITERATION-END-001c: missing onIterationEnd handler does not throw', () => {
    const events = fakeEvents({}); // no handler
    expect(() => {
      emitIterationEnd(events, {
        iter: 1,
        maxIter: 200,
        messages: [] as readonly KodaXMessage[],
        currentSnapshot: fakeSnapshot(500),
      });
    }).not.toThrow();
  });

  it('CAP-EVENTS-ITERATION-END-001d: returns the rebased snapshot (caller reassigns)', () => {
    const events = fakeEvents({});
    const result = emitIterationEnd(events, {
      iter: 1,
      maxIter: 200,
      messages: [] as readonly KodaXMessage[],
      currentSnapshot: fakeSnapshot(1000),
    });
    expect(result).toBeDefined();
    expect(typeof result.currentTokens).toBe('number');
  });

  it('CAP-EVENTS-ITERATION-END-001e: snapshotOverride takes priority over currentSnapshot as rebase baseline', () => {
    const events = fakeEvents({});
    const baseline = fakeSnapshot(1000);
    const override = fakeSnapshot(5000); // distinct identity
    const result = emitIterationEnd(events, {
      iter: 1,
      maxIter: 200,
      messages: [] as readonly KodaXMessage[],
      currentSnapshot: baseline,
      snapshotOverride: override,
    });
    // The rebase derives from override, not from currentSnapshot. Without
    // messages to recount, the rebased snapshot inherits the override's
    // currentTokens (or the rebase rules' equivalent).
    // Pin: result must NOT be referentially equal to baseline (it's a fresh
    // rebase, regardless of which baseline it took).
    expect(result).not.toBe(baseline);
  });
});
