/**
 * Contract test for CAP-092: round-boundary message shape reshape (FEATURE_076)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-092-round-boundary-message-shape-reshape-feature_076
 *
 * Test obligations:
 * - CAP-ROUND-BOUNDARY-001: AMA worker-trace → user conversation
 * - CAP-ROUND-BOUNDARY-002: SA result passes through unchanged
 *
 * Risk: HIGH (FEATURE_076 — downstream session-snapshot, /resume, /continue, multi-turn REPL all depend on clean {user, assistant} pairs)
 *
 * Class: 1
 *
 * Verified location: task-engine.ts:83-89 (runManagedTask outer wrapper); reshapeToUserConversation in task-engine/_internal/round-boundary.ts
 *
 * Time-ordering constraint: LAST step before returning from runManagedTask; after all internal terminal handling.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { reshapeToUserConversation } from '../../task-engine/_internal/round-boundary.js';

describe('CAP-092: round-boundary message shape reshape contract', () => {
  it.todo('CAP-ROUND-BOUNDARY-001: AMA result.messages containing worker-execution-trace shape (scout role-prompt wrapping, evaluator independent-session shape) are reshaped to clean {user, assistant} pairs by reshapeToUserConversation');
  it.todo('CAP-ROUND-BOUNDARY-002: SA result.messages are returned unchanged through reshapeToUserConversation (SA direct path already returns clean shape; reshape is a no-op)');
});
