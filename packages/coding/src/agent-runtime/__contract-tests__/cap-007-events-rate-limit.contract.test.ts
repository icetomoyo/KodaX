/**
 * Contract test for CAP-007: onProviderRateLimit event (429 banner)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-007-onproviderratelimit-event-429-banner
 *
 * Test obligations:
 * - CAP-EVENTS-RATE-LIMIT-001: fires on 429 only, not generic retry
 *
 * Risk: HIGH_RISK_PARITY — `runner-driven.ts:2581-2588` parity-restore evidence:
 * "Legacy agent.ts:2064 fires this on the same branch"
 *
 * Verified call site: agent.ts:2073 (slight drift from legacy)
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { setupRateLimitHook } from '../event-emitter.js';

describe('CAP-007: onProviderRateLimit event contract', () => {
  it.todo('CAP-EVENTS-RATE-LIMIT-001a: fires when classifier returns reasonCode==="rate_limit"');
  it.todo('CAP-EVENTS-RATE-LIMIT-001b: does NOT fire on generic transient retry (network / 5xx)');
});
