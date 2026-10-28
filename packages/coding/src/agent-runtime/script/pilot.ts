import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Agent, RunnerToolObserver } from '@kodax-ai/agent';
import type { KodaXToolUseBlock } from '@kodax-ai/llm';
import type { KodaXManagedWorkBudget } from '../../types.js';
import { getRegisteredToolDefinition, getToolDefinition } from '../../tools/index.js';
import { isToolDiscoverable } from '../../tools/tool-search.js';
import { projectModelToolDefinition } from '../../tools/model-tool-definition.js';
import { canProjectManagedToolContracts, projectManagedToolContract } from '../../tools/managed-tool-contract.js';
import { managedShellDescription } from '../../tools/managed-tool-text.js';
import { emitActiveExtensionEvent } from '../../extensions/runtime.js';
import { incrementManagedBudgetUsage } from '../../task-engine/_internal/managed-task/budget.js';
import { recordMutationForTool } from '../../task-engine/_internal/managed-task/tool-wrappers.js';
import { applyPostToolProcessing, runToolDispatch, type RunToolDispatchInput } from '../tool-dispatch.js';
import { runScriptCell, type ScriptCellLimits, type ScriptCellInput } from './cell.js';

type PilotDispatch = Omit<RunToolDispatchInput, 'toolBlocks' | 'abortSignal'> & {
  readonly abortSignal?: AbortSignal;
  readonly toolObserver?: RunnerToolObserver;
  readonly mutationScopeReflection?: boolean;
};

/** Internal Script qualification probe. Not a public work mode or an alternative AMA executor.
 * The caller supplies raw host events, not a second budget-charging wrapper.
 */
export function createScriptPilot(dispatch: PilotDispatch, budget: KodaXManagedWorkBudget, ordinaryRoot?: Agent) {
  const registrations = new Map(['read', 'grep', 'glob', 'edit', 'write', 'insert_after_anchor', 'bash', 'changed_scope', 'changed_diff',
    'repo_overview', 'semantic_lookup', 'cyclic_dependencies', 'relationship_scan', 'module_context',
    'symbol_context', 'process_context', 'impact_estimate',
    'lsp_definition', 'lsp_hover', 'lsp_references', 'lsp_document_symbols', 'lsp_workspace_symbols',
    'lsp_implementation', 'lsp_incoming_calls', 'lsp_outgoing_calls', 'memory_recall',
    'session_history_search', 'session_history_read', 'kodax_manual', 'web_search', 'web_fetch'].flatMap(name => {
    const registration = getRegisteredToolDefinition(name);
    return registration?.source.kind === 'builtin'
      && dispatch.activeToolNames?.includes(name) && isToolDiscoverable(name, dispatch.ctx)
      ? [[name, registration] as const] : [];
  }));
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
  });
  const signals = [dispatch.abortSignal, dispatch.ctx.abortSignal].filter((signal): signal is AbortSignal => signal !== undefined);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  function assertActive(name: string): void {
    if (!registrations.has(name) || getRegisteredToolDefinition(name) !== registrations.get(name)
      || !dispatch.activeToolNames?.includes(name) || !isToolDiscoverable(name, dispatch.ctx)) {
      throw new Error(`Tool ${name} is outside this Script pilot or its binding changed.`);
    }
  }
  return {
    tools,
    run: (code: string, limits: ScriptCellLimits, durability: Pick<ScriptCellInput, 'onCall' | 'onReceipt'> = {}) => runScriptCell({
      code, limits, toolNames: [...registrations.keys()], signal, ...durability,
      invoke: async (name, input, signal, sequence) => {
        assertActive(name);
        const block: KodaXToolUseBlock = { type: 'tool_use', id: `script_${randomUUID()}_${sequence}`, name, input };
        const finalToolBlocks = new Map<string, KodaXToolUseBlock>();
        const artifacts = new Map<string, string>();
        let shellExecutionOutcome: { success: boolean } | undefined;
        const ctx = { ...dispatch.ctx, abortSignal: signal,
          ...(dispatch.ctx.visualObservationOwner ? { visualSource: { ...dispatch.ctx.visualSource,
            imageOrdinal: 0, leafReceiptId: sequence } } : {}),
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
          toolBlocks: [block], activeToolNames: [...registrations.keys()], abortSignal: signal, finalToolBlocks,
          guardrailContext: dispatch.guardrailContext ? { ...dispatch.guardrailContext, abortSignal: signal } : undefined,
          getAfterGuardrailContext: dispatch.getAfterGuardrailContext
            ? () => ({ ...dispatch.getAfterGuardrailContext!(), abortSignal: signal }) : undefined,
          onToolCallsPrepared: blocks => {
            for (const prepared of blocks) {
              assertActive(prepared.name);
              if (prepared.name === 'bash' && prepared.input?.run_in_background) {
                throw new Error('Script pilot supports foreground shell commands only.');
              }
            }
            dispatch.onToolCallsPrepared?.(blocks);
          },
        });
        const canonical = finalToolBlocks.get(block.id) ?? block;
        const processed = await applyPostToolProcessing({ toolBlocks: [canonical], resultMap, events,
          emitActiveExtensionEvent, ctx, runtimeSessionState: dispatch.runtimeSessionState, toolResultArtifactPaths: artifacts,
          mutationScopeReflection: dispatch.mutationScopeReflection });
        const result = processed.toolResults[0];
        if (!result) throw new Error('Script leaf produced no visible result.');
        const settled = { content: result.content, isError: result.is_error === true
          || (canonical.name === 'bash' && shellExecutionOutcome?.success !== true),
          metadata: { ...result.metadata, toolCall: canonical, editRecoveryMessages: processed.editRecoveryMessages,
            ...(shellExecutionOutcome ? { shellExecutionOutcome } : {}) } };
        dispatch.toolObserver?.onToolResult?.(canonical, settled);
        return settled;
      },
    }),
  };
}
