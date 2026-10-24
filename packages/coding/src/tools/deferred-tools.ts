/**
 * Deferred tool registry — FEATURE_189 Batch 3 B.2 progressive disclosure.
 *
 * Tools listed here have rich descriptions (claudecode-grade, ~500-1000 bytes)
 * whose teaching content the model only needs to consume when it plans to
 * call the tool. To save turn-1 context, the LLM-visible tool schema swaps
 * the full description for a one-line `searchHint` until the tool name
 * appears in the per-session unlock Set on the dynamic assembly path.
 * `tool_search` returns the full contract and records that unlock. Managed
 * AMA tools are assembled once: their native descriptions stay short;
 * the search result supplies the full contract. Neither path removes an
 * executable capability merely because its description is deferred.
 *
 * Why centralized vs per-tool annotation: keeps deferred-tool policy in one
 * file rather than scattering `shouldDefer: true` across tool definitions;
 * easier to audit which tools are deferred and to evolve the list.
 *
 * Mirrors claudecode's `isDeferredTool` (`c:/Works/claudecode/src/tools/index.ts`)
 * and `ToolSearch` bootstrap pattern (`c:/Works/claudecode/src/tools/ToolSearchTool/`).
 *
 * NOT in the deferred set:
 *   - Core tools always-loaded: bash, read, edit, write, multi_edit, grep, glob,
 *     todo_create, todo_update, todo_get, todo_list, ask_user_question,
 *     spawn_agent, send_message, followup_task, wait_agent, list_agents,
 *     interrupt_agent, agent_output, exit_plan_mode, insert_after_anchor,
 *     changed_diff, changed_diff_bundle, undo, worktree_*, get_goal,
 *     create_goal, update_goal
 *   - `tool_search` itself (must always be available to unlock the rest)
 */

/**
 * Map of deferred tool name → one-line searchHint shown in place of the
 * full description until the tool is unlocked. Each hint must answer
 * "when would I want to look this up" in a compact form so the LLM can
 * decide whether to invoke `tool_search` for the full schema.
 */
export const DEFERRED_TOOL_HINTS: Readonly<Record<string, string>> = Object.freeze({
  // Web / discovery
  web_search:      'Discover web content when no specific URL is known — call `tool_search("web_search")` for full schema.',
  web_fetch:       'Read a specific URL as bounded plain text, or read an extension resource. tool_search returns the full contract.',
  code_search:     'Literal path/content search, or extension provider search via provider_id. Prefer grep/glob for ordinary local lookup; tool_search returns the full contract.',
  semantic_lookup: 'Symbol-/module-/process-aware semantic queries against repo intelligence — call `tool_search("semantic_lookup")` for full schema and selection rules.',

  // Repo intelligence
  repo_overview:   'Workspace structure snapshot. Reuse a supplied overview while applicable; query when missing or outdated. tool_search returns the full contract.',
  changed_scope:   'List files / areas changed in current git diff — for worktree, range, and other change-set reviews. After scope, fan out independent review lanes before reading every diff. `tool_search("changed_scope")` for full schema.',
  module_context:  'Module deps, entries, symbols, tests/docs and evidence. Query module or target_path directly; tool_search has details.',
  symbol_context:  'Definition, signature, imports and probable callers/callees. Query symbol directly; module disambiguates. tool_search has details.',
  process_context: 'Approximate static process summary/steps. Query entry, module or target_path directly; tool_search has details.',
  impact_estimate: 'Indexed impact and changed-scope overlap. Query symbol, path or module directly before refactoring; tool_search has details.',

  // FEATURE_259 — workflow authoring is a resident identity/activation hint;
  // the full orchestration guide remains available through tool_search.
  run_workflow: 'Explicitly requested Workflow execution: runs manifest + source with structured output/resume and returns a canonical Workflow actor path. `tool_search("run_workflow")` for contract.',

});

/**
 * Predicate: is this tool name in the deferred set?
 */
export function isDeferredTool(name: string): boolean {
  return name in DEFERRED_TOOL_HINTS;
}

/**
 * Look up the search hint for a deferred tool, or `undefined` if the tool
 * is not deferred.
 */
export function getDeferredToolHint(name: string): string | undefined {
  return DEFERRED_TOOL_HINTS[name];
}

/**
 * Snapshot of all currently deferred tool names.
 *
 * NOTE: there is deliberately NO resident "deferred tools" system-prompt
 * section — the mechanism is self-taught via (a) each tool's `searchHint`
 * (which is shown in place of its description in the LLM-visible tool list and
 * names `tool_search` explicitly) and (b) `tool_search`'s own description.
 * The two-hop reachability eval (FEATURE_250) confirms this is sufficient
 * across the coding-plan panel, so this helper is a utility for callers that
 * want the list (e.g. tests / diagnostics), not a prompt-surface feed.
 */
export function listDeferredToolNames(): readonly string[] {
  return Object.freeze(Object.keys(DEFERRED_TOOL_HINTS));
}

/* ----------------------------------------------------------------
 * Per-context unlock state — keyed by KodaXToolExecutionContext via
 * WeakMap so the lifetime tracks the context object (auto-cleans on
 * GC). Per-context isolation also keeps unit tests independent.
 * ---------------------------------------------------------------- */

const UNLOCKED_PER_CONTEXT: WeakMap<object, Set<string>> = new WeakMap();

/**
 * Mark a deferred tool as unlocked for this context. Subsequent calls to
 * `getActiveToolDefinitions` that pass this context's unlock set will see
 * the full description instead of the search hint.
 *
 * Idempotent — adding an already-unlocked name is a no-op.
 */
export function unlockDeferredToolForContext(
  context: object,
  toolName: string,
): void {
  let set = UNLOCKED_PER_CONTEXT.get(context);
  if (!set) {
    set = new Set();
    UNLOCKED_PER_CONTEXT.set(context, set);
  }
  set.add(toolName);
}

/**
 * Snapshot of currently-unlocked deferred tool names for this context.
 * Returns an empty set if nothing has been unlocked yet. The returned
 * set is a defensive copy — callers must not mutate the internal set.
 */
export function getUnlockedDeferredTools(
  context: object,
): ReadonlySet<string> {
  const set = UNLOCKED_PER_CONTEXT.get(context);
  return set ? new Set(set) : new Set();
}

/**
 * Test-only: clear the unlock set for a context. Production code paths
 * rely on context-object lifetime + GC, not explicit clears.
 */
export function _resetUnlockedDeferredToolsForTest(context: object): void {
  UNLOCKED_PER_CONTEXT.delete(context);
}
