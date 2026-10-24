// Experimental model-view projection only. Execution registries, SDKs and defaults stay unchanged.
import { getRegisteredToolDefinition } from '../packages/coding/src/tools/index.js';
import type { FrozenInput } from './first-turn-eval-support.js';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KodaXProviderError } from '@kodax-ai/llm';
import type { RunnerToolCall } from '@kodax-ai/agent';
import { resolveToolBridgeTarget } from '../packages/coding/src/tools/tool-bridge.js';

/** Local-only fixture experiment; callers must exclude provider-search and explicit SDK profiles. */
export function projectLocalSearchInput(input: FrozenInput, root: boolean): FrozenInput {
  if (!root || getRegisteredToolDefinition('code_search')?.source.kind !== 'builtin'
    || !['code_search', 'grep', 'glob', 'read', 'tool_search', 'tool_call'].every(name =>
      input.tools.some(tool => tool.name === name)
      && getRegisteredToolDefinition(name)?.source.kind === 'builtin')) return input;
  return { ...input, tools: input.tools.filter(tool => tool.name !== 'code_search') };
}

/** Experimental wording only; no schema, executor, policy, or child changes. */
export function projectBridgeTeachingInput(input: FrozenInput, root: boolean): FrozenInput {
  if (!root || getRegisteredToolDefinition('tool_call')?.source.kind !== 'builtin') return input;
  return { ...input, tools: input.tools.map(tool => tool.name === 'tool_call' ? {
    ...tool, description: tool.description + ' Supply name and input as sibling top-level fields, e.g. {"name":"read","input":{"path":"README.md"}}. Put only the target arguments inside input.',
  } : tool) };
}

/** Let the real bridge return its validation error only when no target can dispatch. */
export function isRejectOnlyBridgeCall(call: RunnerToolCall): boolean {
  if (getRegisteredToolDefinition('tool_call')?.source.kind !== 'builtin') return false;
  const target = resolveToolBridgeTarget(call);
  return (target?.ok === false && target.error === '`name` is required.')
    || (target?.ok === true && ['tool_call', 'tool_describe'].includes(target.call.name));
}

/** Mirrors the final-native smoke's proven local rejection contract; never excuses a physical attempt. */
export function isAuxiliaryLocalPreflight(error: unknown, facts: readonly { boundary: string }[], tools: readonly string[]): boolean {
  return tools.length === 1 && tools[0] === 'report_stall_judgment' && error instanceof KodaXProviderError
    && error.metadata?.failureCode === 'request_build_failed' && error.metadata.stage === 'request_build'
    && facts.every(fact => fact.boundary !== 'physical_attempt');
}

export function resolveDeferredEvidenceRoot(value: string): string {
  const result = path.resolve(value);
  const relative = path.relative(path.resolve(os.tmpdir()), result);
  const repositoryRelative = path.relative(fileURLToPath(new URL('..', import.meta.url)), result);
  const belowRepository = repositoryRelative === '' || (!repositoryRelative.startsWith(`..${path.sep}`)
    && repositoryRelative !== '..' && !path.isAbsolute(repositoryRelative));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || belowRepository) {
    throw new Error('Raw evidence must stay under OS Temp and outside the worktree.');
  }
  return result;
}

const REPO_NAMES: readonly string[] = Object.freeze([
  'module_context', 'symbol_context', 'process_context', 'impact_estimate',
]);
const LSP_NAMES: readonly string[] = Object.freeze([
  'lsp_definition', 'lsp_references', 'lsp_implementation', 'lsp_hover',
  'lsp_document_symbols', 'lsp_workspace_symbols', 'lsp_incoming_calls', 'lsp_outgoing_calls',
]);
export const DEFERRED_REPO_LSP_NAMES: readonly string[] = Object.freeze([...REPO_NAMES, ...LSP_NAMES]);

/** Only the root model sees the experiment; the existing bridge retains the full target inventory. */
export function projectDeferredRepoLspInput(input: FrozenInput, root: boolean, family: 'all' | 'repo' | 'lsp' | 'manual' = 'all'): FrozenInput {
  if (!root || !input.tools.some(tool => tool.name === 'tool_search')
    || !input.tools.some(tool => tool.name === 'tool_call')) return input;
  const requested = family === 'manual' ? ['kodax_manual'] : family === 'repo' ? REPO_NAMES : family === 'lsp' ? LSP_NAMES : DEFERRED_REPO_LSP_NAMES;
  const deferred = input.tools.filter(tool => requested.includes(tool.name)
    && getRegisteredToolDefinition(tool.name)?.source.kind === 'builtin').map(tool => tool.name);
  if (deferred.length === 0) return input;
  const names = new Set(deferred);
  const capabilities = family === 'manual' ? 'the installed product manual, including SDK-provided topics' : family === 'repo' ? 'detailed repo context' : family === 'lsp' ? 'compiler navigation, symbols and call hierarchy'
    : 'detailed repo context and compiler navigation, symbols and call hierarchy';
  const guide = '\nAdditional available capabilities (full contracts via tool_search query="select:NAME[,NAME...]"): '
    + deferred.join(', ') + '. These provide ' + capabilities + '. '
    + 'Use tool_call(name,input) to invoke these tools after discovery; they are absent from this native list. '
    + 'Original permissions and input contracts still apply.';
  return { ...input, tools: input.tools.filter(tool => !names.has(tool.name))
    .map(tool => tool.name === 'tool_search' ? { ...tool, description: tool.description + guide } : tool) };
}
