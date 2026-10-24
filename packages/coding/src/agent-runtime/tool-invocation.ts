import { randomUUID } from 'node:crypto';
import { collectGuardrails, createAgent } from '@kodax-ai/agent';
import type { KodaXToolUseBlock } from '@kodax-ai/llm';
import type { KodaXOptions, KodaXResult } from '../types.js';
import { toolResultText } from '../tools/tool-result-content.js';
import { snapshotRuntimeSessionState } from './runtime-session-state.js';
import { createToolResultBlock, runToolDispatch } from './tool-dispatch.js';
import { isCancelledToolResultContent, isToolResultErrorContent } from './tool-result-classify.js';
import { withHostInvocation } from './host-invocation.js';

/** Explicit host invocation: the normal tool gates and Run lifetime, without a model turn. */
export function runToolInvocation(
  original: KodaXOptions,
  invocation: { readonly name: string; readonly input: Record<string, unknown> },
  prompt = `Invoke tool ${invocation.name}`,
): Promise<KodaXResult> {
  return withHostInvocation(original, prompt, async ({ options, sessionId, ctx, state, messages, save }) => {
    let shellSucceeded: boolean | undefined;
    if (invocation.name === 'bash') ctx.reportShellExecutionOutcome = (outcome) => { shellSucceeded = outcome.success; };
    const call: KodaXToolUseBlock = { type: 'tool_use', id: randomUUID(), name: invocation.name, input: invocation.input };
    const toolGuardrails = collectGuardrails(options.guardrails).tool;
    const results = await runToolDispatch({ toolBlocks: [call], ctx, events: options.events ?? {},
      runtimeSessionState: state, activeToolNames: state.activeTools, abortSignal: options.abortSignal, toolGuardrails,
      guardrailContext: { agent: createAgent({ name: 'Host tool invocation', instructions: 'Execute the explicitly requested tool.' }),
        messages, abortSignal: options.abortSignal, permissionIntent: options.context?.permissionIntent },
    });
    const content = results.get(call.id) ?? '[Tool Error] Tool invocation returned no result.';
    const lastText = toolResultText(content);
    // rc.2 fix: a foreground Shell's reported exit wins a later Stop during result delivery.
    const interrupted = isCancelledToolResultContent(content) || (options.abortSignal?.aborted === true
      && (shellSucceeded === undefined || invocation.input.run_in_background === true));
    const toolResult = createToolResultBlock(call.id, content);
    messages.push({ role: 'assistant', content: [call] }, { role: 'user', content: [toolResult] });
    options.events?.onToolResult?.({ id: call.id, name: call.name, content: lastText, toolResult });
    await save();
    return { sessionId, messages, lastText, interrupted, success: !interrupted && !isToolResultErrorContent(content)
      && (invocation.name !== 'bash' || shellSucceeded === true),
      runtimeSessionSnapshot: snapshotRuntimeSessionState(state, { includeUnchanged: false }) };
  });
}
