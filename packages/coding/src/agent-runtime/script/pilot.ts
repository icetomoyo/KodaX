import { randomUUID } from 'node:crypto';
import type { KodaXToolUseBlock } from '@kodax-ai/llm';
import type { KodaXManagedWorkBudget } from '../../types.js';
import { getRegisteredToolDefinition, getToolDefinition } from '../../tools/index.js';
import { isToolDiscoverable } from '../../tools/tool-search.js';
import { projectModelToolDefinition } from '../../tools/model-tool-definition.js';
import { emitActiveExtensionEvent } from '../../extensions/runtime.js';
import { incrementManagedBudgetUsage } from '../../task-engine/_internal/managed-task/budget.js';
import { recordMutationForTool } from '../../task-engine/_internal/managed-task/tool-wrappers.js';
import { applyPostToolProcessing, runToolDispatch, type RunToolDispatchInput } from '../tool-dispatch.js';
import { runScriptCell, type ScriptCellLimits } from './cell.js';

type PilotDispatch = Omit<RunToolDispatchInput, 'toolBlocks' | 'abortSignal'> & { readonly abortSignal?: AbortSignal };

/** Internal phase-C probe. Not a public work mode or an alternative AMA executor.
 * The caller supplies raw host events, not a second budget-charging wrapper.
 */
export function createScriptPilot(dispatch: PilotDispatch, budget: KodaXManagedWorkBudget) {
  function assertHost(): void {
    if (dispatch.ctx.extensionRuntime) throw new Error('Script pilot does not yet qualify extension runtimes or MCP fallback.');
  }
  assertHost();
  const registrations = new Map(['read', 'grep', 'glob', 'edit', 'bash'].flatMap(name => {
    const registration = getRegisteredToolDefinition(name);
    return registration?.source.kind === 'builtin'
      && dispatch.activeToolNames?.includes(name) && isToolDiscoverable(name, dispatch.ctx)
      ? [[name, registration] as const] : [];
  }));
  const tools = [...registrations].map(([name, registration]) => {
    const tool = projectModelToolDefinition(getToolDefinition(name)!, registration.source);
    if (name !== 'bash') return tool;
    return { ...tool, description: `${tool.description} This Script pilot supports foreground commands only.`,
      input_schema: { ...tool.input_schema, properties: { ...tool.input_schema.properties,
        run_in_background: { type: 'boolean', const: false, description: 'Must be false in this Script pilot.' } } } };
  });
  const signals = [dispatch.abortSignal, dispatch.ctx.abortSignal].filter((signal): signal is AbortSignal => signal !== undefined);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  function assertActive(name: string): void {
    assertHost();
    if (!registrations.has(name) || getRegisteredToolDefinition(name) !== registrations.get(name)
      || !dispatch.activeToolNames?.includes(name) || !isToolDiscoverable(name, dispatch.ctx)) {
      throw new Error(`Tool ${name} is outside this Script pilot or its binding changed.`);
    }
  }
  return {
    tools,
    run: (code: string, limits: ScriptCellLimits) => runScriptCell({
      code, limits, toolNames: [...registrations.keys()], signal,
      invoke: async (name, input, signal, sequence) => {
        assertActive(name);
        const block: KodaXToolUseBlock = { type: 'tool_use', id: `script_${randomUUID()}_${sequence}`, name, input };
        const finalToolBlocks = new Map<string, KodaXToolUseBlock>();
        const artifacts = new Map<string, string>();
        const ctx = { ...dispatch.ctx, abortSignal: signal,
          recordToolResultArtifact: (id: string, outputPath: string) => {
            artifacts.set(id, outputPath);
            dispatch.ctx.recordToolResultArtifact?.(id, outputPath);
          },
        };
        const events = { ...dispatch.events, onToolExecutionStart: (...args: Parameters<NonNullable<typeof dispatch.events.onToolExecutionStart>>) => {
          assertActive(args[0].name);
          if (signal.aborted) throw new Error('Script cancelled before execution.');
          if (budget.spentBudget >= budget.totalBudget) throw new Error('Script work budget exhausted.');
          incrementManagedBudgetUsage(budget);
          const call = finalToolBlocks.get(block.id) ?? block;
          if (ctx.mutationTracker) recordMutationForTool(ctx.mutationTracker, call.name, call.input ?? {});
          dispatch.events.onToolExecutionStart?.(...args);
        } };
        const resultMap = await runToolDispatch({ ...dispatch, ctx, events,
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
          emitActiveExtensionEvent, ctx, runtimeSessionState: dispatch.runtimeSessionState, toolResultArtifactPaths: artifacts });
        const result = processed.toolResults[0];
        if (!result) throw new Error('Script leaf produced no visible result.');
        return { content: result.content, isError: result.is_error === true,
          metadata: { ...result.metadata, toolCall: canonical, editRecoveryMessages: processed.editRecoveryMessages } };
      },
    }),
  };
}
