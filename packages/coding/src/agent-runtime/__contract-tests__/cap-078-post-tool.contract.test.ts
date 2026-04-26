/**
 * Contract test for CAP-078: per-result post-processing chain (mutation reflection, outcome tracking, edit recovery, visibility events)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-078-per-result-post-processing-chain-mutation-reflection-outcome-tracking-edit-recovery-visibility-events
 *
 * Test obligations:
 * - CAP-POST-TOOL-001: mutation reflection injected once when threshold crossed
 * - CAP-POST-TOOL-002: edit failure produces recovery message
 * - CAP-POST-TOOL-003: only visible tools emit events
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent.ts:2617-2646
 *
 * Time-ordering constraint: AFTER tool execution + applyToolResultGuardrail; BEFORE history push and hasCancellation check.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { processToolResult } from '../tool-dispatch.js';

describe('CAP-078: per-result post-processing chain contract', () => {
  it.todo('CAP-POST-TOOL-001: mutation scope reflection message is injected into history exactly once when mutation tracker crosses the threshold (CAP-016 calling site)');
  it.todo('CAP-POST-TOOL-002: when edit tool returns error content, buildEditRecoveryUserMessage produces a recovery message pushed into editRecoveryMessages[] (CAP-015 calling site)');
  it.todo('CAP-POST-TOOL-003: tool:result extension event and events.onToolResult are emitted only for visible tool blocks; invisible tools (e.g. emit_managed_protocol) produce no events');
});
