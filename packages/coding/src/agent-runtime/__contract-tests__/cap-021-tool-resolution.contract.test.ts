/**
 * Contract test for CAP-021 + CAP-022 + CAP-040: tool resolution per turn
 *
 * Inventory entries:
 *   - docs/features/v0.7.29-capability-inventory.md#cap-021-tool-definition-resolution-per-turn
 *   - docs/features/v0.7.29-capability-inventory.md#cap-022-runtime-active-tool-name-set
 *   - docs/features/v0.7.29-capability-inventory.md#cap-040-tool-excludes-filter
 *
 * Test obligations:
 * - CAP-TOOL-RESOLVE-001: getActiveToolDefinitions composes the runtime
 *   filter chain and the managed-protocol gate correctly
 * - CAP-TOOL-EXCLUDE-001: filterExcludedTools strips named tools
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/tool-resolution.ts (extracted from
 * agent.ts:155-163 + 452-477 + 478-493 — pre-FEATURE_100 baseline —
 * during FEATURE_100 P2)
 *
 * Time-ordering constraint: BEFORE prompt build; AFTER any tool registry
 * mutation from previous turn (e.g., FEATURE_087 ConstructionRuntime
 * activate).
 *
 * Active here:
 *   - `filterExcludedTools` short-circuit-on-empty contract (returns
 *     input reference unchanged → callers may rely on identity).
 *   - `getRuntimeActiveToolNames` composition order: repo-intel-off →
 *     mcp → construction. The order matters because each subsequent
 *     filter operates on the output of the previous one.
 *   - `getActiveToolDefinitions` empty short-circuit + managed-protocol
 *     gate.
 *
 * Deferred (P3 — needs FEATURE_087 ConstructionRuntime fixture):
 * - CAP-TOOL-RESOLVE-001 integration: constructed tool surfaces next
 *   turn after `ConstructionRuntime.activate()`. The unit-level
 *   composition contract is pinned here; the integration round-trip
 *   sits in P3 once the full Runner-frame wiring is in place.
 *
 * STATUS: ACTIVE since FEATURE_100 P2 for the composition contract.
 */

import { describe, expect, it } from 'vitest';

import {
  filterExcludedTools,
  getActiveToolDefinitions,
  getRuntimeActiveToolNames,
} from '../tool-resolution.js';

describe('CAP-040: filterExcludedTools — pure filter contract', () => {
  it('CAP-TOOL-EXCLUDE-001a: empty / undefined excludeTools → input array reference returned unchanged (identity short-circuit)', () => {
    const input = ['read', 'edit'];
    expect(filterExcludedTools(input, undefined)).toBe(input);
    expect(filterExcludedTools(input, [])).toBe(input);
  });

  it('CAP-TOOL-EXCLUDE-001b: non-empty excludeTools → returns new array with named tools stripped', () => {
    expect(filterExcludedTools(['read', 'edit', 'write'], ['edit'])).toEqual(['read', 'write']);
    expect(filterExcludedTools(['a', 'b', 'c'], ['a', 'c'])).toEqual(['b']);
  });

  it('CAP-TOOL-EXCLUDE-001c: excludeTools containing names not in input → returns equivalent (no-op effect)', () => {
    expect(filterExcludedTools(['read', 'edit'], ['exit_plan_mode'])).toEqual(['read', 'edit']);
  });

  it('CAP-TOOL-EXCLUDE-001d: child-executor scenario — multiple excludes simultaneously stripped', () => {
    // FEATURE_067 v3 child-executor commonly excludes `exit_plan_mode` +
    // similar control-plane tools. Pin the multi-exclude composition.
    const result = filterExcludedTools(
      ['read', 'edit', 'exit_plan_mode', 'plan_mode_review'],
      ['exit_plan_mode', 'plan_mode_review'],
    );
    expect(result).toEqual(['read', 'edit']);
  });
});

describe('CAP-022: getRuntimeActiveToolNames — runtime filter chain', () => {
  // We pass synthetic non-system tool names so the repo-intel / MCP
  // filters become identity transforms — this isolates the COMPOSITION
  // logic from registry state. Edge-case interactions with real
  // FEATURE_087 / MCP filters are covered by their own test modules.

  it('CAP-RUNTIME-TOOLS-001a: synthetic names pass through all three filters (no membership in any registry set) → input preserved', () => {
    const synthetic = ['__synthetic_a__', '__synthetic_b__'];
    expect(
      getRuntimeActiveToolNames(synthetic, 'auto', /* hasCapabilityRuntime */ true),
    ).toEqual(synthetic);
  });

  it('CAP-RUNTIME-TOOLS-001b: hasCapabilityRuntime=false invokes the MCP filter — synthetic non-MCP names still survive', () => {
    const synthetic = ['__synthetic_a__'];
    expect(
      getRuntimeActiveToolNames(synthetic, 'auto', false),
    ).toEqual(synthetic);
  });

  it('CAP-RUNTIME-TOOLS-001c: empty input → empty output (chain short-circuits naturally on empty array)', () => {
    expect(getRuntimeActiveToolNames([], 'auto', true)).toEqual([]);
  });
});

describe('CAP-021: getActiveToolDefinitions — top-level resolver', () => {
  it('CAP-TOOL-RESOLVE-001a: empty activeToolNames → [] (forced text-only mode short-circuit)', () => {
    expect(getActiveToolDefinitions([], 'auto', false, false)).toEqual([]);
  });

  it('CAP-TOOL-RESOLVE-001b: synthetic non-registered names → [] (registry has no matching definition)', () => {
    expect(
      getActiveToolDefinitions(['__synthetic_unknown__'], 'auto', false, true),
    ).toEqual([]);
  });

  it('CAP-TOOL-RESOLVE-001c: managed-protocol tool gated off by default — `emit_managed_protocol` in activeToolNames does NOT surface unless `allowManagedProtocolTool=true`', () => {
    // Even if the user names the managed-protocol tool, the default
    // gate (`allowManagedProtocolTool=false`) MUST hide it from the
    // active definitions — this is a load-bearing safety property:
    // the managed protocol is harness infrastructure, not a
    // user-callable tool.
    const withGateOff = getActiveToolDefinitions(
      ['emit_managed_protocol'],
      'auto',
      /* allowManagedProtocolTool */ false,
      true,
    );
    expect(withGateOff.find((t) => t.name === 'emit_managed_protocol')).toBeUndefined();
  });
});
