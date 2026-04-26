/**
 * Contract test for CAP-048: tool execution context construction with FEATURE_074 callback policy
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-048-tool-execution-context-construction-with-feature_074-callback-policy
 *
 * Test obligations:
 * - CAP-TOOL-CTX-001: FEATURE_074 — set_permission_mode NOT forwarded to tool ctx
 * - CAP-TOOL-CTX-002: FEATURE_067 — onChildProgress is undefined in tool ctx
 * - CAP-TOOL-CTX-003: parentAgentConfig propagates to tool ctx
 *
 * Risk: HIGH (security-sensitive: FEATURE_074 explicitly prevents permission widening)
 *
 * Class: 1
 *
 * Verified location: agent.ts:1519-1561 (KodaXToolExecutionContext literal)
 *
 * Time-ordering constraint: constructed once at frame entry; passed to every tool dispatch.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { buildToolExecutionContext } from '../tool-execution-context.js';

describe('CAP-048: tool execution context construction contract', () => {
  it.todo('CAP-TOOL-CTX-001: FEATURE_074 — events.set_permission_mode is NOT forwarded (absent from KodaXToolExecutionContext)');
  it.todo('CAP-TOOL-CTX-002: FEATURE_067 — onChildProgress is undefined in KodaXToolExecutionContext');
  it.todo('CAP-TOOL-CTX-003: parentAgentConfig (provider/model/reasoningMode) propagates correctly to tool ctx');
});
