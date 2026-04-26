/**
 * Contract test for CAP-006: onError event
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-006-onerror-event
 *
 * Test obligations:
 * - CAP-EVENTS-ERROR-001: fires before rethrow when error escapes
 *
 * Risk: HIGH_RISK_PARITY — `runner-driven.ts:3717-3721` parity-restore evidence:
 * "Legacy agent.ts:2854 fires this before rethrowing"
 *
 * Verified call site: agent.ts:2886 (legacy citation drifted)
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { setupErrorHook } from '../event-emitter.js';

describe('CAP-006: onError event contract', () => {
  it.todo('CAP-EVENTS-ERROR-001: fires before error rethrows from substrate executor; payload carries the caught error instance');
});
