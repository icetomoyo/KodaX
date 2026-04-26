/**
 * Contract test for CAP-041: extension runtime activation lifecycle
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-041-extension-runtime-activation-lifecycle
 *
 * Test obligations:
 * - CAP-EXT-RUNTIME-001: entry binds + hydrates extension runtime
 * - CAP-EXT-RUNTIME-002: release fires on success
 * - CAP-EXT-RUNTIME-003: release fires on error
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent.ts:1437-1446 (binding on entry), :1594-1596 (controller bind),
 * :1598 (hydrateSession); release via releaseRuntimeBinding in finally
 *
 * Time-ordering constraint: bind BEFORE first tool dispatch; hydrate BEFORE first prompt build;
 * release in finally even on error.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { bindExtensionRuntime, releaseRuntimeBinding } from '../extension-runtime-lifecycle.js';

describe('CAP-041: extension runtime activation lifecycle contract', () => {
  it.todo('CAP-EXT-RUNTIME-001: frame entry calls setActiveExtensionRuntime + bindController + hydrateSession before first tool dispatch');
  it.todo('CAP-EXT-RUNTIME-002: releaseRuntimeBinding fires and restores previous active runtime on success path');
  it.todo('CAP-EXT-RUNTIME-003: releaseRuntimeBinding fires and restores previous active runtime on error path');
});
