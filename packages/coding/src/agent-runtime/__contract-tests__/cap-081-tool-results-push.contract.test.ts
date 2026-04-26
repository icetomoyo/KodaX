/**
 * Contract test for CAP-081: tool result accumulation + editRecoveryMessages append + settle
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-081-tool-result-accumulation--editrecoverymessages-append--settle
 *
 * Test obligations:
 * - CAP-TOOL-RESULTS-PUSH-001: recovery messages flagged synthetic
 * - CAP-TOOL-RESULTS-PUSH-002: settle fires before queued-message drain
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent.ts:2732-2756
 *
 * Time-ordering constraint: AFTER hasCancellation non-cancel branch; BEFORE post-tool judge gate (CAP-018).
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { pushToolResultsAndSettle } from '../middleware/extension-queue.js';

describe('CAP-081: tool result accumulation + editRecoveryMessages append + settle contract', () => {
  it.todo('CAP-TOOL-RESULTS-PUSH-001: when editRecoveryMessages is non-empty, the synthesized recovery user message is pushed with _synthetic: true flag');
  it.todo('CAP-TOOL-RESULTS-PUSH-002: settleExtensionTurn is called before appendQueuedRuntimeMessages drain (settle always precedes queue drain in post-tool path)');
});
