/**
 * Contract test for CAP-075: managed protocol auto-continue fallback
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-075-managed-protocol-auto-continue-fallback
 *
 * Test obligations:
 * - CAP-MANAGED-PROTO-AUTO-001: fires once when end_turn but no protocol emitted
 * - CAP-MANAGED-PROTO-AUTO-002: skipped when protocol is optional
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent.ts:2366-2395
 *
 * Time-ordering constraint: AFTER L5 continuation gate (CAP-074); BEFORE tool-blocks-empty branch.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { handleManagedProtocolAutoContinue } from '../managed-protocol-payload.js';

describe('CAP-075: managed protocol auto-continue fallback contract', () => {
  it.todo('CAP-MANAGED-PROTO-AUTO-001: when end_turn and no protocol block emitted and protocol is required, fires once per session (managedProtocolContinueAttempted single-shot gate)');
  it.todo('CAP-MANAGED-PROTO-AUTO-002: branch is skipped when managedProtocolEmission config marks protocol as optional');
});
