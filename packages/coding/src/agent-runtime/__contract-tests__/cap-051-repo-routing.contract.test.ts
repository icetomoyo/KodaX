/**
 * Contract test for CAP-051: repo routing signals computation
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-051-repo-routing-signals-computation
 *
 * Test obligations:
 * - CAP-REPO-ROUTING-001: signals propagate to reasoning plan creation
 * - CAP-REPO-ROUTING-002: best-effort — failure does not throw
 *
 * Risk: MEDIUM (best-effort — failure must not block the run)
 *
 * Class: 1
 *
 * Verified location: agent.ts:1600-1611
 *
 * Time-ordering constraint: AFTER runtimeSessionState construction; BEFORE reasoning plan creation.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { computeRepoRoutingSignals } from '../middleware/repo-intelligence.js';

describe('CAP-051: repo routing signals computation contract', () => {
  it.todo('CAP-REPO-ROUTING-001: computed repoRoutingSignals are passed into createReasoningPlan and emitRepoIntelligenceTrace');
  it.todo('CAP-REPO-ROUTING-002: signals computation failure (rejection) is swallowed via .catch(() => null) and does not throw');
});
