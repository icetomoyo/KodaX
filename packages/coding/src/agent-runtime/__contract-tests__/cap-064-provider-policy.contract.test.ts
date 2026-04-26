/**
 * Contract test for CAP-064: provider policy evaluation + system prompt issue injection
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-064-provider-policy-evaluation--system-prompt-issue-injection
 *
 * Test obligations:
 * - CAP-PROVIDER-POLICY-001: block status throws with summary
 * - CAP-PROVIDER-POLICY-002: issues appear in system prompt as notes
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent.ts:1912-1931
 *
 * Time-ordering constraint: AFTER prepare hook; BEFORE stream call.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { evaluateProviderPolicy } from '../provider-policy.js';

describe('CAP-064: provider policy evaluation contract', () => {
  it.todo('CAP-PROVIDER-POLICY-001: provider policy status "block" throws with policy summary message');
  it.todo('CAP-PROVIDER-POLICY-002: provider policy issues are appended as notes to effectiveSystemPrompt via buildProviderPolicyPromptNotes');
});
