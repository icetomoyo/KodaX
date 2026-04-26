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
 * Verified location: agent.ts:1658-1675 (helper definition); 8 call sites at
 * :2280, :2415, :2472, :2672, :2690, :2710, :2760, :2832
 *
 * Time-ordering constraint: AFTER turn settles; BEFORE next iteration starts (or terminal).
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { emitIterationEnd } from '../event-emitter.js';

describe('CAP-053: emitIterationEnd helper contract', () => {
  it.todo('CAP-EVENTS-ITERATION-END-001: events.onIterationEnd fires exactly once per turn carrying rebased contextTokenSnapshot with iter and tokenCount');
});
