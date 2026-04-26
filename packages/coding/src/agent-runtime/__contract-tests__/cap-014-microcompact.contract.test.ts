/**
 * Contract test for CAP-014: microcompact per-turn cleanup
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-014-microcompact-per-turn-cleanup
 *
 * Test obligations:
 * - CAP-MICROCOMPACT-001: stale thinking block stripped from history
 *
 * Risk: MEDIUM (no parity-restore precedent; behaviour is timing-sensitive)
 *
 * Verified location: agent.ts:1731 (per-turn epilogue call site within `runKodaX` body)
 *
 * Time-ordering constraint: AFTER tool result settle, BEFORE next prompt build,
 * MUST run before validateAndFixToolHistory (CAP-002) on next turn.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { microcompact } from '../middleware/microcompact.js';

describe('CAP-014: microcompact per-turn cleanup contract', () => {
  it.todo('CAP-MICROCOMPACT-001: stale thinking blocks from prior turn are stripped before next prompt build');
  it.todo('CAP-MICROCOMPACT-002: microcompact runs in per-turn epilogue, not pre-stream (ordering)');
  it.todo('CAP-MICROCOMPACT-003: redundant tool-result echoes pruned across 5+ turn sessions');
});
