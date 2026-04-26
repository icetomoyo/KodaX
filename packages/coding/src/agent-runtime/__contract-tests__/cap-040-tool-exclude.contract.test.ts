/**
 * Contract test for CAP-040: tool excludes filter
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-040-tool-excludes-filter
 *
 * Test obligations:
 * - CAP-TOOL-EXCLUDE-001: excluded tool names are filtered from active tool definitions
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/tool-resolution.ts (extracted from
 * agent.ts:155-163 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Time-ordering constraint: in tool resolution chain (CAP-021).
 *
 * **Test obligations live in `cap-021-tool-resolution.contract.test.ts`**
 * — `filterExcludedTools` shares its module with `getActiveToolDefinitions`
 * + `getRuntimeActiveToolNames` (per inventory: "shared with CAP-021"), so
 * the four CAP-TOOL-EXCLUDE-001a/b/c/d test cases are pinned in the same
 * file as the rest of the tool-resolution composition contract. This file
 * is intentionally a thin pointer so a future grep for "CAP-040" in the
 * test directory still surfaces the active obligation.
 *
 * STATUS: ACTIVE since FEATURE_100 P2 (covered by CAP-021 contract test).
 */

import { describe, expect, it } from 'vitest';

import { filterExcludedTools } from '../tool-resolution.js';

describe('CAP-040: filterExcludedTools — pointer to CAP-021 test file', () => {
  it('CAP-TOOL-EXCLUDE-POINTER: confirms `filterExcludedTools` is exported from `agent-runtime/tool-resolution.ts` (full obligations in cap-021-tool-resolution.contract.test.ts)', () => {
    expect(filterExcludedTools).toBeTypeOf('function');
    // Smoke: empty exclude list is identity (the load-bearing
    // short-circuit pinned in the full CAP-021 file).
    const input = ['x'];
    expect(filterExcludedTools(input, undefined)).toBe(input);
  });
});
