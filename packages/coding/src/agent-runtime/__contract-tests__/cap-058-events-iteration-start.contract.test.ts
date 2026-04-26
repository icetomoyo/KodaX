/**
 * Contract test for CAP-058: events.onIterationStart event
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-058-eventsoniterationstart-event
 *
 * Test obligations:
 * - CAP-EVENTS-ITERATION-START-001: fires at start of each turn with correct iter/maxIter values
 *
 * Risk: LOW
 *
 * Class: 2
 *
 * Verified location: agent.ts:1727
 *
 * Time-ordering constraint: AFTER turn:start extension event; BEFORE microcompact (CAP-014).
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { emitIterationStart } from '../event-emitter.js';

describe('CAP-058: events.onIterationStart event contract', () => {
  it.todo('CAP-EVENTS-ITERATION-START-001: events.onIterationStart fires at the start of each turn with iter+1 and maxIter, after turn:start extension event');
});
