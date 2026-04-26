/**
 * Contract test for CAP-084: generic error terminal path
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
 * Verified location: agent.ts:2885-2895
 *
 * Time-ordering constraint: AFTER AbortError check (CAP-083).
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { handleErrorTerminal } from '../event-emitter.js';

describe('CAP-084: generic error terminal path contract', () => {
  it.todo('CAP-ERROR-TERMINAL-001: non-AbortError returns { success: false } with cleanedMessages (history validated by CAP-082 cleanup chain before terminal)');
  it.todo('CAP-ERROR-TERMINAL-002: updatedErrorMetadata is propagated into the error terminal result (caller can read consecutiveErrors from result.errorMetadata)');
});
