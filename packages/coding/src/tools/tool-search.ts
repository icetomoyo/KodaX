/**
 * tool_search — FEATURE_189 Batch 3 B.2 progressive disclosure bootstrap.
 *
 * Returns the full description + JSON Schema for one or more deferred tools.
 * Mirrors claudecode's `ToolSearchTool` (`c:/Works/claudecode/src/tools/ToolSearchTool/`).
 *
 * Query forms:
 *   - `"select:Name1,Name2"`  — fetch exact tools by name
 *   - `"keyword"`             — keyword search across discoverable tools
 *   - `"+keyword tool"`       — require all keywords (filter mode)
 *
 * Side effect: each tool name resolved is added to the per-context unlock
 * Set via {@link unlockDeferredToolForContext}. The next call to
 * `getActiveToolDefinitions` for this context emits the full description
 * for the unlocked tools instead of the search hint.
 *
 * Return format:
 *   A text block with one `<function>{...}</function>` line per resolved
 *   tool. Each line is the same JSON shape that
 *   `getActiveToolDefinitions` emits, so the LLM sees the schema in the
 *   exact form it would arrive in a real tool list.
 */

import type { KodaXToolDefinition } from '@kodax-ai/llm';
import type { LocalToolDefinition, ToolHandlerSync } from './types.js';
import type { KodaXToolExecutionContext } from '../types.js';
import { getRegisteredToolDefinition, getToolDefinition, listToolDefinitions } from './index.js';
import { isMcpToolName } from './registry.js';
import { isSessionHistoryTool } from './session-history.js';
import { listRunScopedTools, lookupRunScopedTool, toModelToolDefinition } from '../agent-runtime/run-scoped-tools.js';

/** Context needed for run-scoped lookup and host-backed skill availability. */
type ToolSearchContext = Pick<KodaXToolExecutionContext,
  'extensionRuntime' | 'skillScriptRunner' | 'executionCwd' | 'excludeTools' | 'toolVisibilityPolicy'
  | 'discoveryToolNames' | 'workflowHost' | 'loadSessionHistory' | 'actorControl'
  | 'lspService' | 'lspNavigationDisabled' | 'workMode'>;

const LSP_NAVIGATION_TOOL_NAMES = new Set([
  'lsp_definition', 'lsp_hover', 'lsp_references', 'lsp_document_symbols',
  'lsp_workspace_symbols', 'lsp_implementation', 'lsp_incoming_calls',
  'lsp_outgoing_calls', 'lsp_prepare_call_hierarchy',
]);

const ACTOR_BOUND_TOOL_NAMES = new Set([
  'spawn_agent', 'send_message', 'followup_task', 'wait_agent',
  'interrupt_agent', 'list_agents', 'agent_output',
]);

import {
  DEFERRED_TOOL_HINTS,
  isDeferredTool,
  unlockDeferredToolForContext,
} from './deferred-tools.js';
import {
  buildToolSearchIndex,
  searchToolIndex,
} from './tool-search-index.js';
import { withManualToolBranding } from '../self-knowledge/tool-description.js';
import { projectModelToolDefinition } from './model-tool-definition.js';

interface ToolSearchInput {
  query?: string;
  max_results?: number;
}

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CAP = 15;

/**
 * Parse the query string into either a select list (exact names) or a
 * keyword set (with optional `+` required terms).
 */
function parseQuery(rawQuery: string): { mode: 'select' | 'keyword'; names: string[]; required: string[]; loose: string[] } {
  const trimmed = rawQuery.trim();
  if (trimmed.startsWith('select:')) {
    const list = trimmed.slice('select:'.length);
    const names = list.split(/[,\s]+/).map((s) => s.trim()).filter((s) => s.length > 0);
    return { mode: 'select', names, required: [], loose: [] };
  }
  const tokens = trimmed.split(/\s+/).filter((s) => s.length > 0);
  const required: string[] = [];
  const loose: string[] = [];
  for (const t of tokens) {
    if (t.startsWith('+') && t.length > 1) required.push(t.slice(1).toLowerCase());
    else loose.push(t.toLowerCase());
  }
  return { mode: 'keyword', names: [], required, loose };
}

/** Shared discovery/dispatch ceiling; lazy service startup is not a capability check. */
export function isToolDiscoverable(name: string, context: ToolSearchContext): boolean {
  if (context.discoveryToolNames && !context.discoveryToolNames.includes(name)) return false;
  if (context.excludeTools?.includes(name)) return false;
  const registered = getRegisteredToolDefinition(name);
  if (registered?.source.kind === 'builtin') {
    if (context.workMode === 'agent' && registered.workSurface === 'coding') return false;
    if (context.lspNavigationDisabled === true && !context.lspService
      && LSP_NAVIGATION_TOOL_NAMES.has(name)) return false;
    if (!context.actorControl && ACTOR_BOUND_TOOL_NAMES.has(name)) return false;
    if (name === 'run_workflow' && !context.workflowHost) return false;
    if (name === 'run_skill_script' && (!context.skillScriptRunner || !context.executionCwd)) return false;
    if (isSessionHistoryTool(name) && !context.loadSessionHistory) return false;
    if (isMcpToolName(name)
      && !(context.extensionRuntime?.hasCapabilityProvider?.('mcp') ?? !!context.extensionRuntime)) return false;
  }
  if (!context.toolVisibilityPolicy) return true;
  const definition = registered
    ?? lookupRunScopedTool(context.extensionRuntime, name);
  return definition !== undefined && context.toolVisibilityPolicy({
    name: definition.name,
    sideEffect: definition.sideEffect,
    planModeAllowed: definition.planModeAllowed === true,
  });
}

function resolveSelectNames(
  names: readonly string[],
  context: ToolSearchContext,
): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    if (!isToolDiscoverable(n, context)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    if (isDeferredTool(n)) resolved.push(n);
    // For non-deferred tools requested by name, still resolve and emit —
    // useful when the LLM is uncertain whether a tool is deferred.
    else if (getToolDefinition(n) ?? lookupRunScopedTool(context.extensionRuntime, n)) resolved.push(n);
  }
  return resolved;
}

function discoverableDefinitions(context: ToolSearchContext): KodaXToolDefinition[] {
  const registered = listToolDefinitions();
  const registeredNames = new Set(registered.map((definition) => definition.name));
  return [
    ...registered,
    ...listRunScopedTools(context.extensionRuntime)
      .filter((definition) => !registeredNames.has(definition.name))
      .map(toModelToolDefinition),
  ].filter((definition) => isToolDiscoverable(definition.name, context));
}

function searchKeywords(required: readonly string[], loose: readonly string[], maxResults: number, context: ToolSearchContext): string[] {
  const index = buildToolSearchIndex(discoverableDefinitions(context), { hints: DEFERRED_TOOL_HINTS });
  return searchToolIndex(index, { required, loose }, maxResults).map((result) => result.name);
}

function formatToolAsFunctionBlock(def: KodaXToolDefinition): string {
  const schema = {
    description: def.description,
    name: def.name,
    parameters: def.input_schema,
  };
  return `<function>${JSON.stringify(schema)}</function>`;
}

function buildResult(
  resolved: readonly string[],
  context: ToolSearchContext,
  selfManualProductName?: string,
): string {
  if (resolved.length === 0) {
    const available = discoverableDefinitions(context);
    return 'No tools matched the query. Available tools: '
      + available.slice(0, MAX_RESULTS_CAP).map((definition) => definition.name).join(', ')
      + '. Use query form `select:NAME` to fetch a specific schema.'
      + (available.length > MAX_RESULTS_CAP
        ? ` [DIRECTORY_LIMIT_REACHED: showing ${MAX_RESULTS_CAP} of ${available.length} tools. Search capability keywords or use an exact name.]` : '');
  }
  const lines: string[] = [];
  const extensionRuntime = context.extensionRuntime;
  for (const name of resolved) {
    let def = getToolDefinition(name);
    if (!def) {
      const runScoped = lookupRunScopedTool(extensionRuntime, name);
      if (runScoped) def = toModelToolDefinition(runScoped);
    }
    if (!def) {
      lines.push(`<!-- ${name}: not registered (skipped) -->`);
      continue;
    }
    unlockDeferredToolForContext(context, name);
    // FEATURE_221: white-label the kodax_manual description here too, so a
    // re-branded consumer's `select:kodax_manual` lookup cannot pull the raw
    // KodaX description. No-op for every other tool / the default product name.
    lines.push(formatToolAsFunctionBlock(withManualToolBranding(projectModelToolDefinition(def,
      getRegisteredToolDefinition(def.name)?.source), selfManualProductName)));
  }
  return lines.join('\n');
}

function appendLimitMarker(result: string, maxResults: number, hasMore: boolean): string {
  if (!hasMore) {
    return result;
  }
  return `${result}\n[RESULT_LIMIT_REACHED: max_results=${maxResults}; additional tools matched. Narrow the keyword query or use \`select:NAME\` for an exact schema.]`;
}

export const toolSearchHandler: ToolHandlerSync = async (input, context) => {
  const i = input as ToolSearchInput;
  const query = typeof i.query === 'string' ? i.query : '';
  if (query.length === 0) {
    return 'tool_search: `query` is required. Forms: `select:NAME[,NAME...]` for exact lookup, or keyword search (`+required loose terms`).';
  }
  const requestedMax = typeof i.max_results === 'number' && i.max_results > 0
    ? Math.min(Math.floor(i.max_results), MAX_RESULTS_CAP)
    : DEFAULT_MAX_RESULTS;
  const parsed = parseQuery(query);
  if (parsed.mode === 'select') {
    return buildResult(
      resolveSelectNames(parsed.names, context),
      context,
      context.selfManual?.productName,
    );
  }
  const probed = searchKeywords(parsed.required, parsed.loose, requestedMax + 1, context);
  const resolved = probed.slice(0, requestedMax);
  const result = buildResult(resolved, context, context.selfManual?.productName);
  return appendLimitMarker(result, requestedMax, probed.length > requestedMax);
};

/**
 * Tool definition exported so registry.ts can register it. Always-loaded;
 * the description below is itself short by design (do not need to defer
 * the meta-tool used to unlock deferred tools).
 */
export const TOOL_SEARCH_DEFINITION: LocalToolDefinition = {
  name: 'tool_search',
  description: [
    'Look up full contracts for active tools. Native tools are directly callable; use tool_call for discovered tools absent from the native list.',
    'Use query="select:NAME[,NAME...]" for exact lookup across discoverable tools. Keyword queries search their names, descriptions and parameters, with +required terms and loose ranked terms.',
    'Results include full descriptions and schemas. Use the returned contract even if later tool lists remain compact.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Either `select:ToolName[,ToolName...]` for exact lookup, or keyword search (`+keyword required loose terms`).',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return (default 5, capped at 15). Ignored in `select:` mode.',
      },
    },
    required: ['query'],
  },
  handler: toolSearchHandler,
  sideEffect: 'readonly',
  // Plan mode permits tool_search: it is a pure read against the registry
  // catalog and the on-context unlock set. Schema retrieval is the kind
  // of investigative action plan-mode is for.
  planModeAllowed: true,
  toClassifierInput: () => '',
};
