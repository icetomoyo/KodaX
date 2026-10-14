/**
 * Tool resolution per turn — CAP-021 + CAP-022 + CAP-040
 *
 * Capability inventory:
 *   - docs/features/v0.7.29-capability-inventory.md#cap-021-tool-definition-resolution-per-turn
 *   - docs/features/v0.7.29-capability-inventory.md#cap-022-runtime-active-tool-name-set
 *   - docs/features/v0.7.29-capability-inventory.md#cap-040-tool-excludes-filter
 *
 * Class 1 (substrate middleware). Three pure functions that compose the
 * per-turn tool resolution chain:
 *
 *   1. **`filterExcludedTools`** (CAP-040) — given a candidate tool-name
 *      list and an `excludeTools` directive (commonly used by
 *      child-executor to exclude `exit_plan_mode`, etc.), return the
 *      list with excluded names stripped. Returns the input array
 *      reference unchanged when the exclude list is empty / undefined
 *      — callers MAY rely on this short-circuit for object identity.
 *
 *   2. **`getRuntimeActiveToolNames`** (CAP-022) — applies runtime
 *      filters in order:
 *        a) repo-intelligence: when `auto-repo` mode resolves to `'off'`,
 *           strip the working set of repo-intel tools (lookup, scan, etc.)
 *           so the model can't try to invoke them.
 *        b) MCP: when there's no capability runtime bound, strip MCP
 *           tool names (the dispatch fallback would just throw).
 *        c) construction: when `toolConstructionMode` is unset, strip
 *           tool/agent construction and self-modify tool names. These only
 *           surface after an explicit construction activation.
 *      Returns a flat `string[]` for permission / display logic.
 *
 *   3. **`getActiveToolDefinitions`** (CAP-021) — top-level resolver:
 *      computes the runtime name set via `getRuntimeActiveToolNames`,
 *      then materialises it against `listToolDefinitions()` and applies
 *      the managed-protocol gate. Empty `activeToolNames` short-circuits
 *      to `[]` (no tools available — e.g. forced text-only mode).
 *
 * The composition order is fixed: excludes filter on the way IN (caller
 * does this once when building `RuntimeSessionState.activeTools`),
 * runtime filters on the way OUT (every turn, because repo-intel mode /
 * capability runtime / construction mode can change between turns).
 *
 * Migration history: extracted from `agent.ts:155-163` (`filterExcludedTools`),
 * `agent.ts:452-477` (`getActiveToolDefinitions`), `agent.ts:478-493`
 * (`getRuntimeActiveToolNames`) — pre-FEATURE_100 baseline — during
 * FEATURE_100 P2. Line ranges match the inventory's `Current location`
 * fields (function body + trailing blank).
 */

import type { KodaXRepoIntelligenceMode, KodaXToolVisibilityPolicy } from '../types.js';
import type { RunScopedToolDefinition } from '../extensions/runtime-contract.js';
import { toModelToolDefinition } from './run-scoped-tools.js';
import {
  filterConstructionToolNames,
  filterAgentConstructionToolNames,
  filterMcpToolNames,
  filterRepoIntelligenceWorkingToolNames,
  getRegisteredToolDefinition,
  listToolDefinitions,
} from '../tools/index.js';
import { isManagedProtocolToolName } from '../managed-protocol.js';
import { resolveKodaXAutoRepoMode } from '../repo-intelligence/runtime.js';
import { DEFERRED_TOOL_HINTS, isDeferredTool } from '../tools/deferred-tools.js';
import { withManualToolBranding } from '../self-knowledge/tool-description.js';
import { projectModelToolDefinition } from '../tools/model-tool-definition.js';

/** FEATURE_067 v3: Filter tools excluded for child agents at API level. */
export function filterExcludedTools(
  tools: string[],
  excludeTools: readonly string[] | undefined,
): string[] {
  if (!excludeTools || excludeTools.length === 0) return tools;
  const excluded = new Set(excludeTools);
  return tools.filter((name) => !excluded.has(name));
}

/**
 * FEATURE_247 (R2) — apply an SDK-consumer tool-visibility policy to a candidate
 * name list. Each name's stable declarative metadata (`sideEffect`,
 * `planModeAllowed`) is resolved from the registry and passed to the predicate;
 * names the predicate rejects are dropped. A name with no resolvable
 * registration is dropped too (fail-closed) so unknown-metadata tools can be
 * default-denied. Returns the input reference unchanged when no policy is set —
 * callers may rely on the identity short-circuit (matches `filterExcludedTools`).
 */
export function applyToolVisibilityPolicy(
  tools: string[],
  policy: KodaXToolVisibilityPolicy | undefined,
  runScopedTools?: ReadonlyMap<string, RunScopedToolDefinition>,
): string[] {
  if (!policy) return tools;
  return tools.filter((name) => {
    const def = getRegisteredToolDefinition(name) ?? runScopedTools?.get(name);
    if (!def) return false;
    return policy({
      name: def.name,
      sideEffect: def.sideEffect,
      planModeAllowed: def.planModeAllowed === true,
    });
  });
}

export function getRuntimeActiveToolNames(
  activeToolNames: string[],
  repoIntelligenceMode?: KodaXRepoIntelligenceMode,
  hasCapabilityRuntime = false,
  toolConstructionMode?: boolean,
  hasAgentExecutorPlane = false,
): string[] {
  let result = resolveKodaXAutoRepoMode(repoIntelligenceMode) === 'off'
    ? filterRepoIntelligenceWorkingToolNames(activeToolNames)
    : activeToolNames;
  if (!hasCapabilityRuntime) {
    result = filterMcpToolNames(result);
  }
  result = filterConstructionToolNames(result, toolConstructionMode);
  result = filterAgentConstructionToolNames(result, toolConstructionMode);
  if (!hasAgentExecutorPlane) {
    result = result.filter((name) => name !== 'list_dispatchable_agents');
  }
  return result;
}

export function getActiveToolDefinitions(
  activeToolNames: string[],
  repoIntelligenceMode?: KodaXRepoIntelligenceMode,
  allowManagedProtocolTool = false,
  hasCapabilityRuntime = false,
  toolConstructionMode?: boolean,
  unlockedDeferredTools?: ReadonlySet<string>,
  // FEATURE_221: white-label — re-brand the kodax_manual description per product.
  selfManualProductName?: string,
  hasAgentExecutorPlane = false,
  runScopedTools?: readonly RunScopedToolDefinition[],
): ReturnType<typeof listToolDefinitions> {
  const registryTools = listToolDefinitions();
  const registeredNames = new Set(registryTools.map((tool) => tool.name));
  const allTools = [
    ...registryTools,
    ...(runScopedTools ?? [])
      .filter((definition) => !registeredNames.has(definition.name))
      .map(toModelToolDefinition),
  ];
  if (activeToolNames.length === 0) {
    return [];
  }

  const allowed = new Set(
    getRuntimeActiveToolNames(
      activeToolNames,
      repoIntelligenceMode,
      hasCapabilityRuntime,
      toolConstructionMode,
      hasAgentExecutorPlane,
    ),
  );
  return allTools
    .filter((tool) => (
      allowed.has(tool.name)
      && (allowManagedProtocolTool || !isManagedProtocolToolName(tool.name))
    ))
    .map((tool) => {
      // FEATURE_221: white-label the kodax_manual description (no-op unless a
      // non-default productName is set, so the default surface is unchanged).
      const branded = withManualToolBranding(projectModelToolDefinition(tool), selfManualProductName);
      // FEATURE_189 Batch 3 B.2 — progressive disclosure: deferred tools
      // emit a one-line searchHint instead of the full description until
      // the per-context unlock set marks them. The schema parameters are
      // unchanged so the tool stays callable with just the hint, but the
      // model only sees the rich teaching content after `tool_search`.
      if (!isDeferredTool(branded.name)) return branded;
      if (unlockedDeferredTools && unlockedDeferredTools.has(branded.name)) return branded;
      const hint = DEFERRED_TOOL_HINTS[branded.name];
      if (!hint) return branded;
      return { ...branded, description: hint };
    });
}
