/**
 * Contract test for CAP-003: onSessionStart event
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-003-onsessionstart-event
 *
 * Test obligations:
 * - CAP-EVENTS-SESSION-START-001: fires exactly once per Runner frame
 *
 * Risk: HIGH_RISK_PARITY — `runner-driven.ts:3707-3713` parity-restore evidence:
 * "Legacy agent.ts:1677 fires this once per `runKodaX` entry"
 *
 * Verified call site: agent.ts:1677 (matches legacy citation)
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { setupSessionStartHook } from '../event-emitter.js';

describe('CAP-003: onSessionStart event contract', () => {
  it.todo('CAP-EVENTS-SESSION-START-001: fires exactly once per Runner frame entry, before any provider call or tool execution');
});
