/**
 * Contract test for CAP-062: graceful compact degradation gating
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-062-graceful-compact-degradation-gating
 *
 * Test obligations:
 * - CAP-COMPACT-DEGRADE-002: gap ratio gate prevents needless degradation
 * - CAP-COMPACT-DEGRADE-003: gates on partial-success-still-high case
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent.ts:1858-1873 (gating + invocation)
 *
 * Time-ordering constraint: AFTER LLM compact (CAP-060); BEFORE validateAndFixToolHistory pre-stream.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { maybeGracefulCompactDegrade } from '../middleware/compaction-orchestration.js';

describe('CAP-062: graceful compact degradation gating contract', () => {
  it.todo('CAP-COMPACT-DEGRADE-002: gap ratio gate (gapRatio=0.8) prevents needless degradation when tokens are already sufficiently below trigger');
  it.todo('CAP-COMPACT-DEGRADE-003: gates fire on partial-success-still-high case (LLM compact returned but tokens still above gapRatio × triggerTokens)');
});
