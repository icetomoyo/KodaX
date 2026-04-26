/**
 * Contract test for CAP-072: incomplete tool call retry chain
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-072-incomplete-tool-call-retry-chain
 *
 * Test obligations:
 * - CAP-INCOMPLETE-TOOL-001: first retry has gentle "be concise" prompt
 * - CAP-INCOMPLETE-TOOL-002: subsequent retries escalate to critical warning
 * - CAP-INCOMPLETE-TOOL-003: max-retries skip-execute fills error tool_results for incomplete ids
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent.ts:2486-2538 (checkIncompleteToolCalls + retry loop + max-retries fallback)
 *
 * Time-ordering constraint: AFTER stream return; BEFORE tool dispatch; counter resets on
 * successful turn (no incomplete blocks).
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { handleIncompleteToolCalls } from '../incomplete-tool-retry.js';

describe('CAP-072: incomplete tool call retry chain contract', () => {
  it.todo('CAP-INCOMPLETE-TOOL-001: first incomplete-tool retry synthetic message uses gentle "be concise" tone (_synthetic: true flag set)');
  it.todo('CAP-INCOMPLETE-TOOL-002: second+ incomplete-tool retry synthetic messages escalate to "⚠️ CRITICAL" tone');
  it.todo('CAP-INCOMPLETE-TOOL-003: when max retries exhausted, incomplete tool_use ids receive synthetic error tool_results without execution; counter resets to 0');
});
