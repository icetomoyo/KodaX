/**
 * Contract test for CAP-080: cancellation-routed terminal (hasCancellation branch + interrupted flag)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-080-cancellation-routed-terminal-hascancellation-branch--interrupted-flag
 *
 * Test obligations:
 * - CAP-CANCEL-TERMINAL-001: cancellation returns success:true with interrupted flag
 * - CAP-CANCEL-TERMINAL-002: queued follow-up suppresses interrupted flag
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent.ts:2650-2652 (hasCancellation check); :2703-2730 (terminal branch)
 *
 * Time-ordering constraint: AFTER per-result post-processing (CAP-078); terminates the run.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { handleCancellationTerminal } from '../tool-cancellation.js';

describe('CAP-080: cancellation-routed terminal contract', () => {
  it.todo('CAP-CANCEL-TERMINAL-001: when toolResults contains CANCELLED_TOOL_RESULT_MESSAGE, returns { success: true, lastText: "Operation cancelled by user", interrupted: true }');
  it.todo('CAP-CANCEL-TERMINAL-002: when hasQueuedFollowUp(events) is true at cancellation terminal, interrupted flag is set to false (queued follow-up absorbs the cancellation)');
});
