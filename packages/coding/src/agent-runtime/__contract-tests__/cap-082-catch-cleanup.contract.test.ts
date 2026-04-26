/**
 * Contract test for CAP-082: catch block — error metadata + cleanup chain
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-082-catch-block--error-metadata--cleanup-chain
 *
 * Test obligations:
 * - CAP-CATCH-CLEANUP-001: history validated before persistence
 * - CAP-CATCH-CLEANUP-002: consecutive errors counter increments across runs
 *
 * Risk: HIGH (must not mask the original error; cleaned messages must not lose user history)
 *
 * Class: 1
 *
 * Verified location: agent.ts:2840-2862
 *
 * Time-ordering constraint: FIRST step in catch; BEFORE branching to AbortError vs general-error.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { runCatchCleanup } from '../middleware/session-snapshot.js';

describe('CAP-082: catch block error metadata + cleanup chain contract', () => {
  it.todo('CAP-CATCH-CLEANUP-001: on unhandled error, cleanupIncompleteToolCalls + validateAndFixToolHistory are run on messages before saveSessionSnapshot persists (history is clean before persistence)');
  it.todo('CAP-CATCH-CLEANUP-002: updatedErrorMetadata.consecutiveErrors is incremented from errorMetadata.consecutiveErrors on each catch; accumulated value propagates to terminal result');
});
