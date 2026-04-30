/**
 * FEATURE_101 invariant: `toolPermission`.
 *
 * Admit-time check: every tool the manifest declares must resolve to a
 * `ToolCapability` tier that systemCap.allowedToolCapabilities permits.
 * Tools whose tier is not allowed get clamped via `removeTools`.
 *
 * Tier mapping mirrors FEATURE_092's auto-mode classifier (v0.7.33) and
 * FEATURE_094's anti-escape policy (v0.7.36): the same coarse categories
 * the runtime guardrails reason about. Unknown tools (custom MCP tools,
 * extensions) default to 'subagent' — the most restrictive bucket — so
 * deployments that haven't allow-listed `subagent` capability will see
 * unknown tools clamped, which is the safe default.
 *
 * Pure function. The mapping is intentionally a flat switch instead of
 * a registry lookup: keeps the invariant pure and self-contained, and
 * the canonical tools list barely changes between releases.
 */

import type {
  AdmissionCtx,
  AgentManifest,
  InvariantResult,
  QualityInvariant,
  ToolCapability,
} from '@kodax/core';

/**
 * Resolve a tool name to its capability tier. The mapping reflects the
 * canonical KodaX tool surface (see `coding/src/tools/registry.ts`).
 * Unknown names fall through to `'subagent'` — the strictest tier — so
 * the default behaviour for unaudited tools is to require explicit
 * allow-list approval.
 */
export function resolveToolCapability(toolName: string): ToolCapability {
  switch (toolName) {
    // Read-only file inspection.
    case 'read':
    case 'glob':
    case 'grep':
    case 'code_search':
    case 'semantic_lookup':
    // Read-only repo intelligence (no FS mutation; pure analysis).
    // Promoted out of the strictest 'subagent' default in 1A.5 review:
    // restrictive deployments that cap at 'read' would otherwise see
    // the entire repo-intelligence surface clamped silently.
    case 'repo_overview':
    case 'changed_scope':
    case 'changed_diff':
    case 'changed_diff_bundle':
    case 'module_context':
    case 'symbol_context':
    case 'process_context':
    case 'impact_estimate':
    // Interaction-only tools (no FS / shell side effect — they just
    // surface state to the user or the planner).
    case 'ask_user_question':
    case 'exit_plan_mode':
      return 'read';
    // File mutation.
    case 'write':
    case 'edit':
    case 'multi_edit':
    case 'insert_after_anchor':
    // `undo` reverses a prior edit — semantically still a file mutation.
    case 'undo':
      return 'edit';
    // Bash is policy-governed at runtime; classify generically as
    // bash:mutating because admission can't safely assume read-only
    // intent without context. Deployments that allow bash:mutating
    // should also allow bash:test and bash:read-only by convention.
    case 'bash':
      return 'bash:mutating';
    // Network egress / external lookups.
    case 'web_search':
    case 'web_fetch':
    case 'mcp_search':
    case 'mcp_describe':
    case 'mcp_call':
    case 'mcp_read_resource':
    case 'mcp_get_prompt':
      return 'bash:network';
    // Subagent dispatch + construction-staircase tools that gate
    // tool-registry mutations through ConstructionRuntime — strictest
    // tier so deployments must explicitly allow-list them.
    case 'dispatch_child_task':
    // AMA managed-protocol emitters (FEATURE_080+, canonical names since
    // v0.7.23). These are tier-`subagent` because emitting a verdict /
    // contract / handoff / final-verdict structurally drives the
    // multi-agent topology — equivalent capability surface to
    // `dispatch_child_task` at the role-routing layer.
    case 'emit_scout_verdict':
    case 'emit_contract':
    case 'emit_handoff':
    case 'emit_verdict':
    case 'emit_managed_protocol':         // v0.7.22 deprecated alias — keep until removed
    case 'scaffold_tool':
    case 'validate_tool':
    case 'stage_construction':
    case 'test_tool':
    case 'activate_tool':
    // FEATURE_089 (v0.7.31) agent self-construction staircase — same
    // tier as the tool staircase: each gate point can promote an LLM-
    // authored manifest into the resolver registry. Strictest.
    case 'scaffold_agent':
    case 'validate_agent':
    case 'stage_agent_construction':
    case 'test_agent':
    case 'activate_agent':
    // Worktree tools mutate git state (branch creation / removal).
    // 'subagent' rather than 'edit' because they affect repo
    // topology, not file content — the closest existing tier.
    case 'worktree_create':
    case 'worktree_remove':
      return 'subagent';
    default:
      return 'subagent';
  }
}

function getToolName(tool: unknown): string | undefined {
  if (typeof tool === 'object' && tool !== null && 'name' in tool) {
    const name = (tool as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return undefined;
}

function admit(manifest: AgentManifest, ctx: AdmissionCtx): InvariantResult {
  if (!manifest.tools || manifest.tools.length === 0) return { ok: true };
  const allowed = new Set<ToolCapability>(ctx.systemCap.allowedToolCapabilities);
  const disallowed: { readonly name: string; readonly capability: ToolCapability }[] = [];
  for (const tool of manifest.tools) {
    const name = getToolName(tool);
    if (!name) continue;
    const capability = resolveToolCapability(name);
    if (!allowed.has(capability)) {
      disallowed.push({ name, capability });
    }
  }
  if (disallowed.length === 0) return { ok: true };
  const removeTools = disallowed.map((d) => d.name);
  const summary = disallowed
    .map((d) => `${d.name}=${d.capability}`)
    .join(', ');
  return {
    ok: false,
    severity: 'clamp',
    reason: `toolPermission: tools requiring disallowed capabilities — ${summary}`,
    patch: { removeTools },
  };
}

export const toolPermission: QualityInvariant = {
  id: 'toolPermission',
  description:
    'Every tool in manifest.tools must resolve to a capability tier that systemCap.allowedToolCapabilities permits; offending tools are clamped via removeTools.',
  admit,
};
