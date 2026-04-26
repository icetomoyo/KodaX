/**
 * Contract test for CAP-085: iteration limit terminal
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-085-iteration-limit-terminal
 *
 * Test obligations:
 * - CAP-ITER-LIMIT-001: limitReached flag set when maxIter consumed
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent.ts:2899-2925
 *
 * Time-ordering constraint: ONLY reached when natural for-loop exit (all maxIter iterations consumed).
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { handleIterationLimitTerminal } from '../iteration-limit-terminal.js';

describe('CAP-085: iteration limit terminal contract', () => {
  it.todo('CAP-ITER-LIMIT-001: when all maxIter iterations complete without an early break, returns { success: true, limitReached: true } with final signal from checkPromiseSignal(lastText)');
});
