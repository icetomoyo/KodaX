/**
 * Contract test for CAP-063: pre-stream validateAndFixToolHistory + onCompactedMessages emission
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-063-pre-stream-validateandfixToolhistory--oncompactedmessages-emission
 *
 * Test obligations:
 * - CAP-COMPACT-COMMIT-001: messages committed after validation; shared tests with CAP-002
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent.ts:1876-1886
 *
 * Time-ordering constraint: AFTER compaction lifecycle (CAP-060) AND graceful degradation (CAP-062);
 * BEFORE provider stream.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { commitCompactedMessages } from '../middleware/compaction-orchestration.js';

describe('CAP-063: pre-stream validate + onCompactedMessages emission contract', () => {
  it.todo('CAP-COMPACT-COMMIT-001: compacted messages are validated via validateAndFixToolHistory then committed to messages; onCompactedMessages emitted when compaction happened this turn');
});
