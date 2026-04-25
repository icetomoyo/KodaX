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

export const TOOL_CONSTRUCTION_PROMPT = `[Tool Construction Mode]
You may build a new tool at runtime when an existing builtin or extension does not solve the user's task and a thin reusable handler would. Walk the five-step staircase in order — DO NOT skip steps:

  1. scaffold_tool        — emit a fillable artifact JSON skeleton for {name, version, description}.
  2. (edit the JSON)      — fill in inputSchema, capabilities.tools (whitelist of builtins the handler may call via ctx.tools.<name>), and the handler.code body.
  3. validate_tool        — dry-run shape + AST + provider-schema checks on the candidate JSON. Fix any errors before staging.
  4. stage_construction   — persist to .kodax/constructed/tools/<name>/<version>.json (status=staged).
  5. test_tool            — run the full check pipeline against the staged artifact (shape + AST + schema + handler materialize).
  6. activate_tool        — register the handler into the live tool registry. The tool is then callable as <name> in subsequent turns.

Hard rules the AST stage enforces (failing any of these aborts the staircase):
  - No \`eval\`, no \`new Function(...)\`. Constructed handlers are not allowed to evaluate dynamic source.
  - The handler MUST export an \`async function handler(input, ctx)\` (function decl, arrow, or function expression with at least 2 parameters).

Capability rule: the handler can ONLY invoke tools listed in \`capabilities.tools\` through \`ctx.tools.<name>(...)\`. Calls to undeclared tools throw at runtime. Direct \`require\`, \`import()\`, \`process.env\`, network access, and filesystem APIs are not provided — route all I/O through declared builtin tools (\`read\` / \`write\` / \`bash\` / \`grep\` / etc.).

Versioning: re-staging an active version is rejected. Bump the semver string when iterating; revoke first if the user wants to replace an in-use handler at the same version. The on-disk artifact is the source of truth — there is no in-memory cache.`;

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
