import { staticText } from './static-text.js';
/**
 * Tool Construction prompt section (FEATURE_087+088, v0.7.28).
 *
 * Conditional Phase C-style section that orients the LLM to the
 * runtime-tool-construction staircase. Injected only when
 * `KodaXContextOptions.toolConstructionMode === true` AND the active
 * tool set actually exposes the construction handlers.
 *
 * Kept short on purpose: the per-tool descriptions in the registry already
 * carry the operational details. This section names the workflow,
 * sequencing, and the load-bearing safety rails so the model walks the
 * staircase deterministically instead of inventing JSON shapes from scratch.
 */

export const TOOL_CONSTRUCTION_PROMPT = staticText("t12.prompts/tool-construction.0");

/**
 * Decide whether the tool-construction section should be injected.
 * Single condition: the caller opted in via `toolConstructionMode`.
 * The active-tool-set gate is enforced separately by
 * `filterConstructionToolNames` at the agent layer, so the two
 * conditions are equivalent at the call site and do not need a
 * second redundant check here.
 */
export function shouldIncludeToolConstructionSection(
  toolConstructionMode: boolean | undefined,
): boolean {
  return Boolean(toolConstructionMode);
}
