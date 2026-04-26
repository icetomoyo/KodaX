/**
 * Contract test for CAP-033: tool target path resolution
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-033-tool-target-path-resolution
 *
 * Test obligations:
 * - CAP-PATH-RESOLVE-001: relative + absolute forms canonicalize identically
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent.ts:902-912 (resolveToolTargetPath)
 *
 * Time-ordering constraint: used by edit recovery (CAP-015) write-block lookup and mutation tracker.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { resolveToolTargetPath } from '../tool-dispatch.js';

describe('CAP-033: tool target path resolution contract', () => {
  it.todo('CAP-PATH-RESOLVE-001: relative and absolute path forms of the same file canonicalize to the same repo-relative string');
});
