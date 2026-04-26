/**
 * Contract test for CAP-030: runtime model selection normalization
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-030-runtime-model-selection-normalization
 *
 * Test obligations:
 * - CAP-MODEL-SELECT-001: provider:model parsed correctly
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent.ts:274-286 (normalizeRuntimeModelSelection)
 *
 * Time-ordering constraint: in provider prepare hook (CAP-023) chain.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { normalizeRuntimeModelSelection } from '../provider-hook.js';

describe('CAP-030: runtime model selection normalization contract', () => {
  it.todo('CAP-MODEL-SELECT-001: provider-qualified model string "provider:model" parses to canonical { provider, model } tuple');
});
