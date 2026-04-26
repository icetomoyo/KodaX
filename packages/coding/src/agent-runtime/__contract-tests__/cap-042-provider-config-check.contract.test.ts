/**
 * Contract test for CAP-042: provider configuration check (entry + per-turn re-validation)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-042-provider-configuration-check-entry--per-turn-re-validation
 *
 * Test obligations:
 * - CAP-PROVIDER-CONFIG-001: unconfigured provider throws with env-var hint
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent.ts:1457-1462 (entry), :1695-1699 (per-turn), :1932-1936 (post-prepare-hook)
 *
 * Time-ordering constraint: BEFORE first provider call; re-validation BEFORE each provider.stream.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { checkProviderConfiguration } from '../provider-config-check.js';

describe('CAP-042: provider configuration check contract', () => {
  it.todo('CAP-PROVIDER-CONFIG-001: unconfigured provider (isConfigured() false) throws error including the API key env-var name hint');
});
