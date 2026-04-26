/**
 * Contract test for CAP-090: SA-path task-family prompt overlay (direct path rules)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-090-sa-path-task-family-prompt-overlay-direct-path-rules
 *
 * Test obligations:
 * - CAP-DIRECT-PATH-RULE-001: review task family produces correct overlay
 * - CAP-DIRECT-PATH-RULE-002: lookup task family produces correct overlay
 * - CAP-DIRECT-PATH-RULE-003: planning task family produces correct overlay
 * - CAP-DIRECT-PATH-RULE-004: investigation task family produces correct overlay
 * - CAP-DIRECT-PATH-RULE-005: undefined family appends nothing
 * - CAP-DIRECT-PATH-RULE-006: AMA agents do not invoke
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: task-engine.ts:57-72 (buildDirectPathTaskFamilyPromptOverlay); :97 (inferIntentGate call)
 *
 * Time-ordering constraint: BEFORE runDirectKodaX invocation; merged with caller's promptOverlay via \\n\\n join.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { buildDirectPathTaskFamilyPromptOverlay } from '../direct-path-rules.js';

describe('CAP-090: SA-path task-family prompt overlay (direct path rules) contract', () => {
  it.todo('CAP-DIRECT-PATH-RULE-001: review task family produces "[Direct Path Rule]" overlay with "Return a review report, not a plan. Findings first..." instruction');
  it.todo('CAP-DIRECT-PATH-RULE-002: lookup task family produces "[Direct Path Rule]" overlay with "Return a concise factual answer with the relevant file path(s)..." instruction');
  it.todo('CAP-DIRECT-PATH-RULE-003: planning task family produces "[Direct Path Rule]" overlay with "Return a concrete plan, not an implementation report." instruction');
  it.todo('CAP-DIRECT-PATH-RULE-004: investigation task family produces "[Direct Path Rule]" overlay with "Return diagnosis, evidence, and next steps." instruction');
  it.todo('CAP-DIRECT-PATH-RULE-005: undefined task family (inferIntentGate returns no family) results in no rule being appended to the overlay');
  it.todo('CAP-DIRECT-PATH-RULE-006: AMA path (agentMode !== "sa") does not call buildDirectPathTaskFamilyPromptOverlay — role prompts of AMA agents supersede');
});
