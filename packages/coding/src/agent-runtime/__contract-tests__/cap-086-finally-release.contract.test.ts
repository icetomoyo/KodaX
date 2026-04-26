/**
 * Contract test for CAP-086: finally cleanup (extension runtime release)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-086-finally-cleanup-extension-runtime-release
 *
 * Test obligations:
 * - CAP-FINALLY-RELEASE-001: release fires on success
 * - CAP-FINALLY-RELEASE-002: release fires on error
 * - CAP-FINALLY-RELEASE-003: release fires on AbortError
 *
 * Risk: HIGH (must run even on error to prevent runtime leak across runKodaX calls)
 *
 * Class: 1
 *
 * Verified location: agent.ts:2926-2931
 *
 * Time-ordering constraint: LAST — outer finally; runs after every terminal path (success / cancellation / error / iteration limit).
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { releaseFinallyRuntime } from '../extension-runtime-lifecycle.js';

describe('CAP-086: finally cleanup (extension runtime release) contract', () => {
  it.todo('CAP-FINALLY-RELEASE-001: releaseRuntimeBinding is invoked and previousActiveRuntime is restored when runKodaX exits normally (success path)');
  it.todo('CAP-FINALLY-RELEASE-002: releaseRuntimeBinding is invoked and previousActiveRuntime is restored when runKodaX exits via an unhandled error (catch path)');
  it.todo('CAP-FINALLY-RELEASE-003: releaseRuntimeBinding is invoked and previousActiveRuntime is restored when runKodaX exits via AbortError (interrupt path)');
});
