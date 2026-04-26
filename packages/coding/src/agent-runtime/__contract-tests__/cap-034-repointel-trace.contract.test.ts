/**
 * Contract test for CAP-034: repoIntelligenceTrace emission
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-034-repointelligencetrace-emission
 *
 * Test obligations:
 * - CAP-REPOINTEL-TRACE-001: all 4 trace sites emit when handler wired
 *
 * Risk: LOW
 *
 * Class: 2
 *
 * Verified location: agent.ts:164-184 (shouldEmitRepoIntelligenceTrace, emitRepoIntelligenceTrace)
 *
 * Time-ordering constraint: emitted at 4 specific repo-intel sites
 * (routing/preturn/module/impact).
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { emitRepoIntelligenceTrace } from '../event-emitter.js';

describe('CAP-034: repoIntelligenceTrace emission contract', () => {
  it.todo('CAP-REPOINTEL-TRACE-001: all 4 repo-intel trace sites (routing/preturn/module/impact) emit events when onRepoIntelligenceTrace is wired');
});
