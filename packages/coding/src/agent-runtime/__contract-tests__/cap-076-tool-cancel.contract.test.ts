/**
 * Contract test for CAP-076: pre-tool abort check + graceful tool cancellation (Issue 088)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-076-pre-tool-abort-check--graceful-tool-cancellation-issue-088
 *
 * Test obligations:
 * - CAP-TOOL-CANCEL-001: Ctrl+C before dispatch yields cancelled tool_results
 * - CAP-TOOL-CANCEL-002: no tools execute after abort
 *
 * Risk: HIGH (cancellation correctness)
 *
 * Class: 1
 *
 * Verified location: agent.ts:2548-2562
 *
 * Time-ordering constraint: BEFORE tool execution (loop entry); also re-checked per-bash-tool inside sequential loop (CAP-077).
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { handlePreToolAbortCheck } from '../tool-cancellation.js';

describe('CAP-076: pre-tool abort check + graceful tool cancellation contract', () => {
  it.todo('CAP-TOOL-CANCEL-001: when options.abortSignal is aborted at tool-dispatch entry, all tool_use blocks receive CANCELLED_TOOL_RESULT_MESSAGE content without executing');
  it.todo('CAP-TOOL-CANCEL-002: no tool execution occurs after abort — executeToolCall is never invoked for any block in the batch');
});
