/**
 * Contract test for CAP-004: onStreamEnd event
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-004-onstreamend-event
 *
 * Test obligations:
 * - CAP-EVENTS-STREAM-END-001: fires once per turn including final turn
 *
 * Risk: HIGH_RISK_PARITY — `runner-driven.ts:2842-2846` parity-restore evidence:
 * "Legacy agent.ts:2201 / :2687 / :2835 fires this at three terminal points"
 *
 * Verified call sites: agent.ts:2240 / :2719 / :2867 (legacy citation drifted)
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { setupStreamEndHook } from '../event-emitter.js';

describe('CAP-004: onStreamEnd event contract', () => {
  it.todo('CAP-EVENTS-STREAM-END-001: fires once per turn after provider stream finalizes, including the final turn before terminal');
});
