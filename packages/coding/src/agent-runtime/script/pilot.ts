import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isRunnableTool, type Agent, type RunnerToolObserver } from '@kodax-ai/agent';
import type { KodaXToolUseBlock } from '@kodax-ai/llm';
import type { KodaXManagedWorkBudget, ToolResultProjection } from '../../types.js';
import { getRegisteredToolDefinition, getToolDefinition, getBuiltinToolDefinition, isToolMutation } from '../../tools/index.js';
import { isToolDiscoverable } from '../../tools/tool-search.js';
import { projectModelToolDefinition } from '../../tools/model-tool-definition.js';
import { canProjectManagedToolContracts, projectManagedToolContract } from '../../tools/managed-tool-contract.js';
import { managedShellDescription } from '../../tools/managed-tool-text.js';
import { emitActiveExtensionEvent } from '../../extensions/runtime.js';
import { incrementManagedBudgetUsage } from '../../task-engine/_internal/managed-task/budget.js';
import { recordMutationForTool } from '../../task-engine/_internal/managed-task/tool-wrappers.js';
import { applyPostToolProcessing, runToolDispatch, type RunToolDispatchInput } from '../tool-dispatch.js';
import { runScriptCell, type ScriptCellLimits, type ScriptCellInput } from './cell.js';
import { listRunScopedTools, lookupRunScopedTool, runScopedToolMap, toModelToolDefinition } from '../run-scoped-tools.js';
import type { ReadFileStateCache } from '../../multi-instance/read-file-state-cache.js';

type PilotDispatch = Omit<RunToolDispatchInput, 'toolBlocks' | 'abortSignal'> & {
  readonly abortSignal?: AbortSignal;
  readonly toolObserver?: RunnerToolObserver;
  readonly mutationScopeReflection?: boolean;
};

/** Internal Script qualification probe. Not a public work mode or an alternative AMA executor.
 * The caller supplies raw host events, not a second budget-charging wrapper.
 */
export function createScriptPilot(dispatch: PilotDispatch, budget: KodaXManagedWorkBudget, ordinaryRoot?: Agent) {
  const parentReadCache = dispatch.ctx.readFileStateCache;
  // This cache describes model-visible reads, not data available to a fresh VM.
  // Guest selection may omit the body; mutations still invalidate native reads.
  const guestReadCache: ReadFileStateCache | undefined = parentReadCache && {
    lookup: () => ({ kind: 'miss' }), record: () => {},
    forget: path => parentReadCache.forget(path),
    clear: () => parentReadCache.clear(),
    size: () => parentReadCache.size(),
  };
  const registrations = new Map(['read', 'grep', 'glob', 'edit', 'write', 'insert_after_anchor', 'bash', 'changed_scope', 'changed_diff',
    'repo_overview', 'semantic_lookup', 'cyclic_dependencies', 'relationship_scan', 'module_context',
    'symbol_context', 'process_context', 'impact_estimate',
    'lsp_definition', 'lsp_hover', 'lsp_references', 'lsp_document_symbols', 'lsp_workspace_symbols',
    'lsp_implementation', 'lsp_incoming_calls', 'lsp_outgoing_calls', 'memory_recall',
    'session_history_search', 'session_history_read', 'kodax_manual', 'web_search', 'web_fetch',
    'mcp_search', 'mcp_describe', 'mcp_call', 'mcp_read_resource', 'mcp_get_prompt'].flatMap(name => {
    const registration = getRegisteredToolDefinition(name);
    return registration?.source.kind === 'builtin'
      && dispatch.activeToolNames?.includes(name) && isToolDiscoverable(name, dispatch.ctx)
      ? [[name, registration] as const] : [];
  }));
  for (const name of dispatch.activeToolNames ?? []) {
    const registration = getRegisteredToolDefinition(name);
    if (registration && !getBuiltinToolDefinition(name) && isToolDiscoverable(name, dispatch.ctx)) registrations.set(name, registration);
  }
  const scoped = runScopedToolMap(listRunScopedTools(dispatch.ctx.extensionRuntime).filter(tool =>
    !getRegisteredToolDefinition(tool.name) && dispatch.activeToolNames?.includes(tool.name) && isToolDiscoverable(tool.name, dispatch.ctx)));
  const shareContracts = ordinaryRoot !== undefined && canProjectManagedToolContracts(ordinaryRoot, dispatch.ctx);
  const tools = [...registrations].map(([name, registration]) => {
    const original = projectModelToolDefinition(getToolDefinition(name)!, registration.source);
    const rootTool = ordinaryRoot?.tools?.find(tool => tool.name === name);
    const tool = shareContracts && rootTool?.description === original.description
      && isDeepStrictEqual(rootTool.input_schema, original.input_schema) ? projectManagedToolContract(original) : original;
    if (name !== 'bash') return tool;
    return { ...tool, description: tool !== original ? managedShellDescription('foreground')
      : `${tool.description} This Script pilot supports foreground commands only.`,
      input_schema: { ...tool.input_schema, properties: { ...tool.input_schema.properties,
        run_in_background: { type: 'boolean', const: false, description: 'Must be false in this Script pilot.' } } } };
  }).concat([...scoped.values()].map(toModelToolDefinition));
  const signals = [dispatch.abortSignal, dispatch.ctx.abortSignal].filter((signal): signal is AbortSignal => signal !== undefined);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  function assertActive(name: string): void {
    const stable = registrations.has(name) ? getRegisteredToolDefinition(name) === registrations.get(name)
      : scoped.has(name) && !getRegisteredToolDefinition(name)
        && isDeepStrictEqual(lookupRunScopedTool(dispatch.ctx.extensionRuntime, name), scoped.get(name));
    if (!stable
      || !dispatch.activeToolNames?.includes(name) || !isToolDiscoverable(name, dispatch.ctx)) {
      throw new Error(`Tool ${name} is outside this Script pilot or its binding changed.`);
    }
  }
  return {
    tools,
    run: (code: string, limits: ScriptCellLimits, durability: Pick<ScriptCellInput, 'onCall' | 'onPrepared' | 'onReceipt' | 'storedValues' | 'onStore' | 'onOutput' | 'onYield'> = {}) => runScriptCell({
      code, limits, toolNames: tools.map(tool => tool.name), signal, ...durability, concurrentPreparation: true,
      invoke: async (name, input, signal, sequence, admit, prepare) => {
        assertActive(name);
        const block: KodaXToolUseBlock = { type: 'tool_use', id: `script_${randomUUID()}_${sequence}`, name, input };
        const finalToolBlocks = new Map<string, KodaXToolUseBlock>();
        const artifacts = new Map<string, string>();
        let projection: ToolResultProjection | undefined;
        let shellExecutionOutcome: { success: boolean } | undefined;
        let admittedParallel = false;
        const canParallel = (call: { name: string; input: Record<string, unknown> }): boolean => {
          const rootTool = (ordinaryRoot ?? dispatch.guardrailContext?.agent)?.tools?.find(tool => tool.name === call.name);
          return !isToolMutation(call.name, scoped)
            && !(rootTool && isRunnableTool(rootTool) && rootTool.requiresSerialExecution?.(call.input) === true);
        };
        const ctx = { ...dispatch.ctx, abortSignal: signal, readFileStateCache: guestReadCache,
          beforeToolInvoke: async (call: { readonly id: string; readonly name: string; readonly input: Record<string, unknown> }) => {
            await dispatch.ctx.beforeToolInvoke?.(call);
            if (call.id === block.id) {
              if (admittedParallel && !canParallel(call)) throw new Error('Hook changed Script call to require serial execution; retry explicitly after this cell settles.');
              await prepare({ id: sequence, name: call.name, input: call.input });
              finalToolBlocks.set(block.id, { type: 'tool_use', ...call });
              signal.throwIfAborted();
              assertActive(call.name);
            }
          },
          recordToolResultProjection: (id: string, value: ToolResultProjection) => {
            projection = value;
            dispatch.ctx.recordToolResultProjection?.(id, value);
          },
          reportShellExecutionOutcome: (outcome: { success: boolean }) => {
            shellExecutionOutcome = outcome;
            dispatch.ctx.reportShellExecutionOutcome?.(outcome);
          },
          recordToolResultArtifact: (id: string, outputPath: string) => {
            artifacts.set(id, outputPath);
            dispatch.ctx.recordToolResultArtifact?.(id, outputPath);
          },
        };
        const currentCall = () => finalToolBlocks.get(block.id) ?? block;
        const events: typeof dispatch.events = { ...dispatch.events,
          beforeToolExecute: async (...args) => {
            const verdict = await dispatch.toolObserver?.beforeTool?.(currentCall());
            if (verdict !== undefined && verdict !== true) return verdict;
            return await dispatch.events.beforeToolExecute?.(...args) ?? true;
          },
          onToolUseStart: (...args) => {
            dispatch.toolObserver?.onToolCall?.(currentCall());
            dispatch.events.onToolUseStart?.(...args);
          },
          onToolExecutionEnd: (...args) => {
            dispatch.toolObserver?.onToolExecutionEnd?.(currentCall());
            dispatch.events.onToolExecutionEnd?.(...args);
          },
          onToolExecutionStart: (...args) => {
          assertActive(args[0].name);
          if (signal.aborted) throw new Error('Script cancelled before execution.');
          if (budget.spentBudget >= budget.totalBudget) throw new Error('Script work budget exhausted.');
          incrementManagedBudgetUsage(budget);
          const call = finalToolBlocks.get(block.id) ?? block;
          if (ctx.mutationTracker) recordMutationForTool(ctx.mutationTracker, call.name, call.input ?? {});
          dispatch.toolObserver?.onToolExecutionStart?.(call);
          dispatch.events.onToolExecutionStart?.(...args);
        } };
        const resultMap = await runToolDispatch({ ...dispatch, ctx, events,
          allowMcpFallback: false,
          toolBlocks: [block], activeToolNames: tools.map(tool => tool.name), abortSignal: signal, finalToolBlocks,
          guardrailContext: dispatch.guardrailContext ? { ...dispatch.guardrailContext, abortSignal: signal } : undefined,
          getAfterGuardrailContext: dispatch.getAfterGuardrailContext
            ? () => ({ ...dispatch.getAfterGuardrailContext!(), abortSignal: signal }) : undefined,
          onToolCallsPrepared: async blocks => {
            for (const prepared of blocks) {
              assertActive(prepared.name);
              if (prepared.name === 'bash' && prepared.input?.run_in_background) {
                throw new Error('Script pilot supports foreground shell commands only.');
              }
            }
            await dispatch.onToolCallsPrepared?.(blocks);
            const canonical = blocks[0]!;
            admittedParallel = canParallel(canonical);
            await admit(admittedParallel, { id: sequence, name: canonical.name, input: canonical.input });
          },
        });
        const canonical = finalToolBlocks.get(block.id) ?? block;
        const processed = await applyPostToolProcessing({ toolBlocks: [canonical], resultMap, events,
          emitActiveExtensionEvent, ctx, runtimeSessionState: dispatch.runtimeSessionState, toolResultArtifactPaths: artifacts,
          mutationScopeReflection: dispatch.mutationScopeReflection });
        const result = processed.toolResults[0];
        if (!result) throw new Error('Script leaf produced no visible result.');
        const matchedProjection = projection && (typeof projection.content === 'string'
          ? result.content === projection.content : isDeepStrictEqual(result.content, projection.content)) ? projection : undefined;
        const settled = { content: result.content, isError: result.is_error === true
          || (canonical.name === 'bash' && shellExecutionOutcome?.success !== true),
          ...(matchedProjection?.sourceContent !== undefined && !result.is_error ? { sourceContent: matchedProjection.sourceContent } : {}),
          ...(matchedProjection?.data && !result.is_error ? { data: matchedProjection.data } : {}),
          metadata: { ...result.metadata, toolCall: canonical, editRecoveryMessages: processed.editRecoveryMessages,
            ...(typeof matchedProjection?.modelContent === 'string' ? { scriptModelContent: matchedProjection.modelContent } : {}),
            ...(shellExecutionOutcome ? { shellExecutionOutcome } : {}) } };
        dispatch.toolObserver?.onToolResult?.(canonical, settled);
        return settled;
      },
    }),
  };
}
