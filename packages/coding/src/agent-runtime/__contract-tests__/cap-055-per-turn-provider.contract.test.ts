/**
 * Contract test for CAP-055: per-turn provider/model/thinkingLevel re-resolution
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-055-per-turn-providermodelthinkinglevel-re-resolution
 *
 * Test obligations:
 * - CAP-PER-TURN-PROVIDER-001: extension override propagates to next turn
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent.ts:1691-1702
 *
 * Time-ordering constraint: at iteration start; BEFORE provider config check (CAP-042)
 * per-turn re-validation.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { resolvePerTurnProvider } from '../per-turn-provider-resolution.js';

describe('CAP-055: per-turn provider/model/thinkingLevel re-resolution contract', () => {
  it.todo('CAP-PER-TURN-PROVIDER-001: extension-set modelSelection override from runtimeSessionState propagates to currentProviderName/model/thinkingLevel on the next turn');
});
