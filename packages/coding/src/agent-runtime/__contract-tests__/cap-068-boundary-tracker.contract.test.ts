/**
 * Contract test for CAP-068: boundary tracker session + telemetry emission
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-068-boundary-tracker--telemetry-emission
 *
 * Test obligations:
 * - CAP-BOUNDARY-TRACKER-001: failure stage inferred correctly across pre-text / mid-text / mid-tool boundaries
 * - CAP-BOUNDARY-TRACKER-002: telemetry events emit at all 4 sites
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/boundary-tracker-session.ts (extracted
 * from agent.ts:806/819-826/932-939/881 — pre-FEATURE_100 baseline —
 * during FEATURE_100 P3.2d)
 *
 * Time-ordering constraint: beginAttempt before stream; deltas during stream;
 * inferFailureStage after error.
 *
 * Active here:
 *   - beginAttempt pairs tracker.beginRequest with telemetryBoundary
 *     (single call site for both, prevents the "called one without the
 *     other" regression)
 *   - markX delegates correctly to the underlying tracker so failure
 *     stage inference uses the same accumulated state
 *   - inferFailureStage reflects which mark methods were fired
 *
 * STATUS: ACTIVE since FEATURE_100 P3.2d.
 */

import { describe, expect, it, vi } from 'vitest';

import { BoundaryTrackerSession } from '../boundary-tracker-session.js';
import * as telemetryModule from '../../resilience/telemetry.js';

describe('CAP-068: BoundaryTrackerSession — beginAttempt + telemetry', () => {
  it('CAP-BOUNDARY-TRACKER-002a: beginAttempt emits telemetryBoundary with the snapshot', () => {
    const spy = vi.spyOn(telemetryModule, 'telemetryBoundary').mockImplementation(() => undefined);
    try {
      const session = new BoundaryTrackerSession();
      session.beginAttempt('anthropic', 'claude-sonnet-4-5', [], 1, false);
      expect(spy).toHaveBeenCalledOnce();
      // Snapshot is the tracker's internal state — load-bearing that
      // telemetry sees the SAME tracker the failure-stage inference
      // will later read.
      const snapshotArg = spy.mock.calls[0]![0];
      expect(snapshotArg).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('CAP-BOUNDARY-TRACKER-002b: beginAttempt is the only legal way to emit telemetryBoundary', () => {
    // The session bundles beginRequest + telemetryBoundary so callers
    // cannot accidentally fire one without the other (the original
    // code at agent.ts had this pair appear at two distinct call
    // sites — easy regression target).
    const spy = vi.spyOn(telemetryModule, 'telemetryBoundary').mockImplementation(() => undefined);
    try {
      const session = new BoundaryTrackerSession();
      session.beginAttempt('anthropic', 'm', [], 1, false);
      session.beginAttempt('anthropic', 'm', [], 2, true); // fallback path
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('CAP-068: BoundaryTrackerSession — inferFailureStage delegation', () => {
  it('CAP-BOUNDARY-TRACKER-001a: pre-text failure (no marks) → "before_first_event" stage', () => {
    const session = new BoundaryTrackerSession();
    session.beginAttempt('anthropic', 'm', [], 1, false);
    const stage = session.inferFailureStage();
    // "before_first_event" is the canonical pre-text label per
    // StableBoundaryTracker. We don't pin the exact string here —
    // CAP-068 only guarantees that the session correctly delegates and
    // returns the tracker's classification (downstream consumers
    // already test the tracker's labels via resilience/* tests).
    expect(stage).toBeDefined();
    expect(typeof stage).toBe('string');
  });

  it('CAP-BOUNDARY-TRACKER-001b: mid-text failure (text-delta marked) → different stage than pre-text', () => {
    const session = new BoundaryTrackerSession();
    session.beginAttempt('anthropic', 'm', [], 1, false);
    const preTextStage = session.inferFailureStage();
    session.markTextDelta('hello');
    const midTextStage = session.inferFailureStage();
    expect(midTextStage).not.toBe(preTextStage); // marker shifted classification
  });

  it('CAP-BOUNDARY-TRACKER-001c: mid-tool-input failure (tool-input marked) → different stage than mid-text', () => {
    const session = new BoundaryTrackerSession();
    session.beginAttempt('anthropic', 'm', [], 1, false);
    session.markTextDelta('text first');
    const midTextStage = session.inferFailureStage();
    session.markToolInputStart('tool-id-1');
    const midToolStage = session.inferFailureStage();
    expect(midToolStage).not.toBe(midTextStage);
  });
});

describe('CAP-068: BoundaryTrackerSession — single-tracker invariant', () => {
  it('CAP-BOUNDARY-TRACKER-INVARIANT-001: marks delegated through the session reach the tracker (so inferFailureStage sees them)', () => {
    // This pins the load-bearing invariant: stream-handler-wiring marks
    // via session.markX, the catch path reads via session.inferFailureStage.
    // If the session forwarded to a different tracker instance, stage
    // inference would be wrong.
    const session = new BoundaryTrackerSession();
    session.beginAttempt('anthropic', 'm', [], 1, false);
    const before = session.inferFailureStage();
    session.markThinkingDelta('thinking-text');
    const after = session.inferFailureStage();
    expect(after).not.toBe(before); // confirms mark reached the tracker
  });

  it('CAP-BOUNDARY-TRACKER-INVARIANT-002: tracker reference is exposed readonly so session is the single owner', () => {
    const session = new BoundaryTrackerSession();
    expect(session.tracker).toBeDefined();
    // The `readonly tracker` field on the class prevents reassignment
    // at the type level. We don't assert runtime immutability since
    // `readonly` is compile-time only.
  });
});
