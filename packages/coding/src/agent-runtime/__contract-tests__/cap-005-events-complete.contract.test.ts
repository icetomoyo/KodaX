/**
 * Contract test for CAP-005: onComplete event
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-005-oncomplete-event
 *
 * Test obligations:
 * - CAP-EVENTS-COMPLETE-001: fires on success / block / error all 3 terminal paths
 *
 * Risk: HIGH_RISK_PARITY — `runner-driven.ts:3755-3759` parity-restore evidence:
 * "Legacy agent.ts fires this at 3 sites (:2249 / :2450 / :2666)"
 *
 * Verified call sites: agent.ts:2288 / :2480 / :2698 (legacy citation drifted)
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { setupCompleteHook } from '../event-emitter.js';

describe('CAP-005: onComplete event contract', () => {
  it.todo('CAP-EVENTS-COMPLETE-001a: fires on success terminal');
  it.todo('CAP-EVENTS-COMPLETE-001b: fires on block / interrupt terminal');
  it.todo('CAP-EVENTS-COMPLETE-001c: fires on error terminal AFTER onError');
});
