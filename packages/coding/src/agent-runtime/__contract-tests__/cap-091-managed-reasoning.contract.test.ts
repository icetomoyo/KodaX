/**
 * Contract test for CAP-091: AMA-only managed reasoning plan builder
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-091-ama-only-managed-reasoning-plan-builder
 *
 * Test obligations:
 * - CAP-MANAGED-REASONING-001: provider-failure fallback produces non-empty decision
 * - CAP-MANAGED-REASONING-002: recent messages capped at 10
 *
 * Risk: MEDIUM (FEATURE_086 parity restore)
 *
 * Class: 1
 *
 * Verified location: task-engine.ts:130-190 (buildManagedReasoningPlan)
 *
 * Time-ordering constraint: AFTER mode dispatch (CAP-089) decided AMA; BEFORE runManagedTaskViaRunner.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { buildManagedReasoningPlan } from '../managed-reasoning-plan.js';

describe('CAP-091: AMA-only managed reasoning plan builder contract', () => {
  it.todo('CAP-MANAGED-REASONING-001: when provider resolution fails, buildManagedReasoningPlan returns a fallback ReasoningPlan from buildFallbackRoutingDecision + buildAmaControllerDecision (non-empty decision, not SCOUT_INSTRUCTIONS_FALLBACK minimal prompt)');
  it.todo('CAP-MANAGED-REASONING-002: only the last 10 messages from options.session.initialMessages are passed to createReasoningPlan as recentMessages');
});
