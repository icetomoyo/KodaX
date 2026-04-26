/**
 * Contract test for CAP-065: resilience config + recovery coordinator + boundary tracker per-turn setup
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-065-resilience-config--recovery-coordinator--boundary-tracker-per-turn-setup
 *
 * Test obligations:
 * - CAP-RESILIENCE-SETUP-001: config resolves per provider
 * - CAP-RESILIENCE-SETUP-002: sanitize latch persists across attempts within turn but resets across turns
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent.ts:1946-1957
 *
 * Time-ordering constraint: BEFORE stream call; PER-turn (state does not persist across turns).
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { buildResilienceSetup } from '../provider-retry-policy.js';

describe('CAP-065: resilience config + recovery coordinator per-turn setup contract', () => {
  it.todo('CAP-RESILIENCE-SETUP-001: resilienceCfg (timeouts, maxRetries, fallback enable) resolves correctly per provider');
  it.todo('CAP-RESILIENCE-SETUP-002: sanitize-thinking-and-retry latch persists across retry attempts within a turn but is reset fresh each turn');
});
