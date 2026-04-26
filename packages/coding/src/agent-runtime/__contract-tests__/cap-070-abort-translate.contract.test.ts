/**
 * Contract test for CAP-070: AbortError → KodaXNetworkError translation
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-070-aborterror--kodaxnetworkerror-translation
 *
 * Test obligations:
 * - CAP-ABORT-TRANSLATE-001: internal timeout abort → KodaXNetworkError; user abort passes through unchanged
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent.ts:2095-2099
 *
 * Time-ordering constraint: BEFORE classifyResilienceError; immediately after catch.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { translateAbortError } from '../provider-retry-policy.js';

describe('CAP-070: AbortError → KodaXNetworkError translation contract', () => {
  it.todo('CAP-ABORT-TRANSLATE-001: AbortError from internal retryTimeoutController translates to KodaXNetworkError(transient=true); AbortError from user options.abortSignal passes through unchanged');
});
