/**
 * Contract test for CAP-098: child-executor plan-mode block-check propagation (FEATURE_074)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-098-child-executor-plan-mode-block-check-propagation-feature_074
 *
 * Test obligations:
 * - CAP-CHILD-PLAN-MODE-001: predicate consulted at each child tool call
 * - CAP-CHILD-PLAN-MODE-002: mid-run mode toggle blocks subsequent calls
 * - CAP-CHILD-PLAN-MODE-003: block reason string surfaces correctly
 *
 * Risk: HIGH (security-sensitive — without this, plan-mode toggling mid-run wouldn't propagate to in-flight child tools)
 *
 * Class: 1
 *
 * Verified location: child-executor.ts:81-84 (PlanModeBlockCheck predicate type); :96-101 (ChildExecutorOptions.planModeBlockCheck); buildChildEvents integration in executeReadChild
 *
 * Time-ordering constraint: per child tool call, BEFORE child's executeToolCall.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { buildChildEvents } from '../../child-executor.js';

describe('CAP-098: child-executor plan-mode block-check propagation contract', () => {
  it.todo('CAP-CHILD-PLAN-MODE-001: PlanModeBlockCheck predicate from ChildExecutorOptions.planModeBlockCheck is consulted at every child tool call BEFORE executeToolCall — tool is blocked when predicate returns a non-null string');
  it.todo('CAP-CHILD-PLAN-MODE-002: when parent plan-mode is toggled mid-run, subsequent child tool calls reflect the new mode (predicate closes over parent REPL ref, picks up live state changes)');
  it.todo('CAP-CHILD-PLAN-MODE-003: when predicate returns a block-reason string, that exact string surfaces in the child\'s blocked-tool error result (caller can read the reason for auditing)');
});
