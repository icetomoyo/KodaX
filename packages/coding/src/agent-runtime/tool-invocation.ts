import { randomUUID } from 'node:crypto';
import { collectGuardrails, createAgent } from '@kodax-ai/agent';
import type { KodaXMessage, KodaXToolUseBlock } from '@kodax-ai/llm';
import type { KodaXOptions, KodaXResult } from '../types.js';
import { listTools } from '../tools/registry.js';
import { toolResultText } from '../tools/tool-result-content.js';
import { bindActiveExtensionExecutionRuntime, getActiveExtensionRuntime, withExtensionRuntimeContext } from '../extensions/runtime.js';
import { buildRuntimeSessionState, snapshotRuntimeSessionState } from './runtime-session-state.js';
import { buildToolExecutionContext } from './tool-execution-context.js';
import { applyToolVisibilityPolicy, filterExcludedTools } from './tool-resolution.js';
import { listRunScopedTools, runScopedToolMap } from './run-scoped-tools.js';
import { createToolResultBlock, runToolDispatch } from './tool-dispatch.js';
import { isCancelledToolResultContent, isToolResultErrorContent } from './tool-result-classify.js';
import { resolveInitialMessages } from './middleware/auto-resume.js';
import { createExtensionRuntimeSessionController } from './middleware/extension-queue.js';
import { saveRequiredSessionSnapshot } from './middleware/session-snapshot.js';

/** Explicit host invocation: the normal tool gates and Run lifetime, without a model turn. */
export function runToolInvocation(
  options: KodaXOptions,
  invocation: { readonly name: string; readonly input: Record<string, unknown> },
  prompt = `Invoke tool ${invocation.name}`,
): Promise<KodaXResult> {
  return withExtensionRuntimeContext(() => executeInvocation(options, invocation, prompt), options.extensionRuntime ?? getActiveExtensionRuntime());
}

async function executeInvocation(
  original: KodaXOptions, invocation: { readonly name: string; readonly input: Record<string, unknown> },
  prompt: string,
): Promise<KodaXResult> {
  const sessionId = original.session?.id ?? randomUUID();
  const options = { ...original, context: { ...original.context,
    runtimeRunId: original.context?.runtimeRunId ?? randomUUID() } };
  const runtime = options.extensionRuntime ?? getActiveExtensionRuntime() ?? undefined;
  const releaseExecution = bindActiveExtensionExecutionRuntime(runtime);
  let releaseController: (() => void) | void = undefined;
  try {
    options.abortSignal?.throwIfAborted();
    const resumed = await resolveInitialMessages(options, sessionId);
    const runTools = listRunScopedTools(runtime);
    const activeTools = applyToolVisibilityPolicy(filterExcludedTools([
      ...(runtime?.getDefaults?.().activeTools ?? listTools()), ...runTools.map((tool) => tool.name),
    ], options.context.excludeTools), options.context.toolVisibilityPolicy, runScopedToolMap(runTools));
    const state = buildRuntimeSessionState({ ...resumed, activeTools,
      modelSelection: runtime?.getDefaults?.().modelSelection ?? {},
      loadedExtensionState: resumed.loadedExtensionState, loadedExtensionRecords: resumed.loadedExtensionRecords });
    releaseController = runtime?.bindController?.(createExtensionRuntimeSessionController(state));
    await runtime?.hydrateSession?.(sessionId);
    const ctx = buildToolExecutionContext({ options, sessionId, runtime, managedProtocolPayloadRef: { current: undefined } });
    let shellSucceeded = false;
    if (invocation.name === 'bash') ctx.reportShellExecutionOutcome = (outcome) => { shellSucceeded = outcome.success; };
    const call: KodaXToolUseBlock = { type: 'tool_use', id: randomUUID(), name: invocation.name, input: invocation.input };
    const messages: KodaXMessage[] = [...resumed.messages, { role: 'user', content: prompt }];
    const toolGuardrails = collectGuardrails(options.guardrails).tool;
    const results = await runToolDispatch({ toolBlocks: [call], ctx, events: options.events ?? {},
      runtimeSessionState: state, activeToolNames: activeTools, abortSignal: options.abortSignal, toolGuardrails,
      guardrailContext: { agent: createAgent({ name: 'Host tool invocation', instructions: 'Execute the explicitly requested tool.' }),
        messages, abortSignal: options.abortSignal, permissionIntent: options.context.permissionIntent },
    });
    const content = results.get(call.id) ?? '[Tool Error] Tool invocation returned no result.';
    const lastText = toolResultText(content);
    const interrupted = options.abortSignal?.aborted === true || isCancelledToolResultContent(content);
    messages.push({ role: 'assistant', content: [call] }, { role: 'user', content: [createToolResultBlock(call.id, content)] });
    options.events?.onToolResult?.({ id: call.id, name: call.name, content: lastText });
    if (options.session?.storage) await saveRequiredSessionSnapshot(options, sessionId, {
      messages, title: resumed.title || prompt.slice(0, 80), gitRoot: options.context.gitRoot ?? undefined, runtimeSessionState: state,
    });
    return { sessionId, messages, lastText, interrupted, success: !interrupted && !isToolResultErrorContent(content)
      && (invocation.name !== 'bash' || shellSucceeded),
      runtimeSessionSnapshot: snapshotRuntimeSessionState(state, { includeUnchanged: false }) };
  } finally { releaseController?.(); releaseExecution(); }
}
