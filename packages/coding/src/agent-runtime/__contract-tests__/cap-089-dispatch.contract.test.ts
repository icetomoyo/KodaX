/**
 * Contract test for CAP-089: task-engine.ts mode dispatcher
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-089-task-enginets-mode-dispatcher
 *
 * Test obligations:
 * - CAP-DISPATCH-001: SA mode → defaultCodingAgent
 * - CAP-DISPATCH-002: AMA mode → scoutAgent
 * - CAP-DISPATCH-003: default agentMode = 'ama'
 *
 * Risk: HIGH (the load-bearing fork point for FEATURE_100 — post-refactor this becomes a thin Agent-declaration selector instead of a body fork)
 *
 * Class: 1
 *
 * Verified location: task-engine.ts:53-55 (resolveManagedAgentMode); :91-128 (executeRunManagedTask)
 *
 * Time-ordering constraint: at top of runManagedTask; the result is wrapped by reshapeToUserConversation (CAP-092).
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { executeRunManagedTask } from '../../task-engine.js';

describe('CAP-089: task-engine.ts mode dispatcher contract', () => {
  it.todo('CAP-DISPATCH-001: when agentMode is "sa", executeRunManagedTask routes to runKodaX (defaultCodingAgent path with intent-gate-derived prompt overlay)');
  it.todo('CAP-DISPATCH-002: when agentMode is "ama", executeRunManagedTask routes to runManagedTaskViaRunner (scoutAgent AMA path with full reasoning plan)');
  it.todo('CAP-DISPATCH-003: when options.agentMode is not provided, resolveManagedAgentMode defaults to "ama"');
});
