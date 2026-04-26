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
 *   2. **`getRuntimeActiveToolNames`** (CAP-022) — applies three runtime
 *      filters in order:
 *        a) repo-intelligence: when `auto-repo` mode resolves to `'off'`,
 *           strip the working set of repo-intel tools (lookup, scan, etc.)
 *           so the model can't try to invoke them.
 *        b) MCP: when there's no capability runtime bound, strip MCP
 *           tool names (the dispatch fallback would just throw).
 *        c) construction: when `toolConstructionMode` is set, strip the
 *           dynamically-constructed tool names (FEATURE_087 — they only
 *           surface AFTER `ConstructionRuntime.activate()`).
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

import type { KodaXRepoIntelligenceMode } from '../types.js';
import {
  filterConstructionToolNames,
  filterMcpToolNames,
  filterRepoIntelligenceWorkingToolNames,
  listToolDefinitions,
} from '../tools/index.js';
import { isManagedProtocolToolName } from '../managed-protocol.js';
import { resolveKodaXAutoRepoMode } from '../repo-intelligence/runtime.js';

/** FEATURE_067 v3: Filter tools excluded for child agents at API level. */
export function filterExcludedTools(
  tools: string[],
  excludeTools: readonly string[] | undefined,
): string[] {
  if (!excludeTools || excludeTools.length === 0) return tools;
  const excluded = new Set(excludeTools);
  return tools.filter((name) => !excluded.has(name));
}

export function getRuntimeActiveToolNames(
  activeToolNames: string[],
  repoIntelligenceMode?: KodaXRepoIntelligenceMode,
  hasCapabilityRuntime = false,
  toolConstructionMode?: boolean,
): string[] {
  let result = resolveKodaXAutoRepoMode(repoIntelligenceMode) === 'off'
    ? filterRepoIntelligenceWorkingToolNames(activeToolNames)
    : activeToolNames;
  if (!hasCapabilityRuntime) {
    result = filterMcpToolNames(result);
  }
  result = filterConstructionToolNames(result, toolConstructionMode);
  return result;
}

export function getActiveToolDefinitions(
  activeToolNames: string[],
  repoIntelligenceMode?: KodaXRepoIntelligenceMode,
  allowManagedProtocolTool = false,
  hasCapabilityRuntime = false,
  toolConstructionMode?: boolean,
): ReturnType<typeof listToolDefinitions> {
  const allTools = listToolDefinitions();
  if (activeToolNames.length === 0) {
    return [];
  }

  const allowed = new Set(
    getRuntimeActiveToolNames(
      activeToolNames,
      repoIntelligenceMode,
      hasCapabilityRuntime,
      toolConstructionMode,
    ),
  );
  return allTools.filter((tool) => (
    allowed.has(tool.name)
    && (allowManagedProtocolTool || !isManagedProtocolToolName(tool.name))
  ));
}
