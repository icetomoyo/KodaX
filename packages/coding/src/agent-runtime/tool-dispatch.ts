/**
 * Tool dispatch — CAP-024 + CAP-025 + CAP-077 + CAP-078 + CAP-079
 *
 * Capability inventory:
 *   - docs/features/v0.7.29-capability-inventory.md#cap-024-tool-execution-dispatch
 *   - docs/features/v0.7.29-capability-inventory.md#cap-025-mcp-fallback-resolution
 *   - docs/features/v0.7.29-capability-inventory.md#cap-077-tool-dispatch-parallelization-bash-sequential-non-bash-parallel
 *   - docs/features/v0.7.29-capability-inventory.md#cap-078-per-result-post-processing-chain-mutation-reflection-outcome-tracking-edit-recovery-visibility-events
 *   - docs/features/v0.7.29-capability-inventory.md#cap-079-applytoolresultguardrail-post-tool-truncation-wrapping
 *
 * Class 1 (substrate middleware). The dispatch core: per-`tool_use`
 * block execution + MCP fallback + tool-result block construction +
 * parallel/sequential dispatch split + per-result post-processing.
 *
 * **`createToolResultBlock`** — assembles the `tool_result` content
 * block sent back to the assistant. Sets `is_error: true` when the
 * content matches the CAP-037 error envelope, otherwise omits the
 * field. Used in the dispatch loop's success / cancel / error paths
 * (4 call sites in agent.ts).
 *
 * **`executeToolCall` (CAP-024)** — invoked once per `tool_use` block
 * extracted from an assistant message. Sequence (load-bearing —
 * each step is a substrate hook in P3):
 *
 *   1. **Abort gate** — if `abortSignal.aborted`, return
 *      `CANCELLED_TOOL_RESULT_MESSAGE` (Issue 088 cancellation).
 *   2. **Visibility + start events** — for non-managed-protocol
 *      tools (CAP-035), emit `tool:start` extension event AND
 *      `events.onToolUseStart` (REPL display). Managed-protocol
 *      tools are silent.
 *   3. **Permission gate (CAP-010)** — `getToolExecutionOverride`
 *      consults the host (REPL prompts user, IDE shows native dialog).
 *      Returning a non-undefined value short-circuits the dispatch
 *      and uses the override as the tool result string.
 *   4. **Active-tool gate** — when `activeToolNames` is supplied (set
 *      by Agent declaration / runtime), an unknown tool returns a
 *      `[Tool Error] <name>: Tool is not active in the current
 *      runtime.` envelope.
 *   5. **Edit-recovery write block (CAP-015)** —
 *      `maybeBlockExistingFileWrite` checks the
 *      `runtimeSessionState.blockedEditWrites` set and returns a
 *      structured block message if the write would clobber an
 *      anchor-recovery target.
 *   6. **Tool execution** — `executeTool(name, input, ctx)` from the
 *      tool registry. The `reportToolProgress` callback is wired only
 *      when `events.onToolProgress` is set, to avoid synthesising the
 *      callback for every dispatch (FEATURE_067 v2).
 *   7. **MCP fallback (CAP-025)** — when a built-in tool returns a
 *      `[Tool Error]` envelope AND the context has an extension
 *      runtime, try `tryMcpFallback`. The fallback is gated by the
 *      7-tool allow-list — mutating tools (`write`/`edit`/`bash`)
 *      MUST never silently redirect.
 *
 * The function returns a string (not a `KodaXToolResultBlock`) because
 * the substrate dispatch loop also handles cancellation and parallel
 * tool execution at a higher level — wrapping into a block happens in
 * the loop, not here.
 *
 * **`tryMcpFallback` (CAP-025)** — see CAP-025 docstring section
 * below. Three short-circuits + result wrapping.
 *
 * **`runToolDispatch` (CAP-077 + CAP-079)** — splits assistant tool_use
 * blocks into bash and non-bash, runs non-bash tools in parallel
 * (`Promise.all`) and bash tools sequentially (so side-effecting bash
 * never races), wrapping each call with `applyToolResultGuardrail` so
 * the post-tool truncation policy is the FIRST registered guardrail
 * layer (FEATURE_085 will register more on top). Each iteration of the
 * bash sequential loop re-checks `abortSignal` (Issue 088 mid-batch
 * Ctrl+C); the upstream pre-tool abort gate (CAP-076 / `checkPreToolAbort`)
 * prevents this helper from running at all when the user has already
 * aborted before dispatch. Returns a `Map<id, content>` keyed by
 * `tool_use_id`.
 *
 * **`applyPostToolProcessing` (CAP-078)** — per-result chain that runs
 * AFTER the dispatch map is built and BEFORE history push:
 *
 *   1. Mutation scope reflection (CAP-016 calling site) — appended
 *      ONCE per session when the mutation tracker crosses threshold,
 *      and only to a non-error mutation tool's content.
 *   2. `updateToolOutcomeTracking` (CAP-026 calling site) updates
 *      runtime outcome counters used by the auto-reroute judge.
 *   3. Edit-recovery message synthesis (CAP-015 calling site) — for
 *      `'edit'` tool results that carry an error envelope, build a
 *      synthetic recovery user message accumulated for the caller to
 *      append after the tool_results block.
 *   4. Visibility events — for visible tool names (CAP-035), emit
 *      `tool:result` extension event + `events.onToolResult` and push
 *      a `tool_result` block into the accumulator. Invisible tools
 *      (managed-protocol) are silently dropped from the transcript.
 *
 * Returns `{ toolResults, editRecoveryMessages }` — the caller pushes
 * `toolResults` into history and (if non-empty) the recovery messages
 * as a `_synthetic: true` user message.
 *
 * Migration history: extracted from `agent.ts:873-880`
 * (`createToolResultBlock`), `agent.ts:1306-1379` (`executeToolCall`),
 * `agent.ts:1384-1392` (`MCP_FALLBACK_ALLOWED_TOOLS`),
 * `agent.ts:1394-1428` (`tryMcpFallback`) — pre-FEATURE_100 baseline
 * — during FEATURE_100 P2.  `runToolDispatch` and
 * `applyPostToolProcessing` extracted from `agent.ts:1271-1353`
 * — pre-FEATURE_100 baseline — during FEATURE_100 P3.3d.
 */

import type {
  KodaXEvents,
  KodaXToolExecutionContext,
  KodaXToolResultBlock,
} from '../types.js';
import type { KodaXToolUseBlock } from '@kodax/ai';
import { CANCELLED_TOOL_RESULT_MESSAGE } from '../constants.js';
import { executeTool } from '../tools/index.js';
import { emitActiveExtensionEvent } from '../extensions/runtime.js';
import { isVisibleToolName } from './event-emitter.js';
import { getToolExecutionOverride } from './permission-gate.js';
import {
  type RunnableToolCall,
  maybeBlockExistingFileWrite,
  buildEditRecoveryUserMessage,
} from './middleware/edit-recovery.js';
import { isToolResultErrorContent } from './tool-result-classify.js';
import type { RuntimeSessionState } from './runtime-session-state.js';
import { applyToolResultGuardrail } from '../tools/tool-result-policy.js';
import {
  buildMutationScopeReflection,
  isMutationScopeSignificant,
  isMutationTool,
} from './middleware/mutation-reflection.js';
import { updateToolOutcomeTracking } from './middleware/tool-outcome-tracking.js';
import type { ExtensionEventEmitter } from './stream-handler-wiring.js';

export function createToolResultBlock(
  toolUseId: string,
  content: string,
): KodaXToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    ...(isToolResultErrorContent(content) ? { is_error: true } : {}),
  };
}

export async function executeToolCall(
  events: KodaXEvents,
  toolCall: RunnableToolCall,
  ctx: KodaXToolExecutionContext,
  runtimeSessionState: RuntimeSessionState,
  activeToolNames?: string[],
  abortSignal?: AbortSignal,
): Promise<string> {
  // Issue 088: Check abort signal before executing each tool
  if (abortSignal?.aborted) {
    return CANCELLED_TOOL_RESULT_MESSAGE;
  }

  const visibleTool = isVisibleToolName(toolCall.name);
  if (visibleTool) {
    await emitActiveExtensionEvent('tool:start', {
      name: toolCall.name,
      id: toolCall.id,
      input: toolCall.input,
    });
    events.onToolUseStart?.({
      name: toolCall.name,
      id: toolCall.id,
      input: toolCall.input,
    });
  }

  const override = await getToolExecutionOverride(
    events,
    toolCall.name,
    toolCall.input ?? {},
    toolCall.id,
    ctx.executionCwd,
    ctx.gitRoot,
  );
  if (override !== undefined) {
    return override;
  }

  if (activeToolNames && !activeToolNames.includes(toolCall.name)) {
    return `[Tool Error] ${toolCall.name}: Tool is not active in the current runtime.`;
  }

  const blockedWrite = maybeBlockExistingFileWrite(toolCall, ctx, runtimeSessionState);
  if (blockedWrite) {
    return blockedWrite;
  }

  // FEATURE_067 v2: Inject reportToolProgress for long-running tools (dispatch_child_tasks)
  const ctxWithProgress: KodaXToolExecutionContext = events.onToolProgress
    ? {
        ...ctx,
        reportToolProgress: (message: string) => {
          events.onToolProgress?.({ id: toolCall.id, message });
        },
      }
    : ctx;

  const result = await executeTool(toolCall.name, toolCall.input ?? {}, ctxWithProgress);

  // MCP fallback: when a built-in tool fails, try to find a same-name MCP tool.
  if (result.startsWith('[Tool Error]') && ctx.extensionRuntime) {
    const fallbackResult = await tryMcpFallback(
      toolCall.name,
      toolCall.input ?? {},
      ctx,
    );
    if (fallbackResult !== undefined) {
      return fallbackResult;
    }
  }

  return result;
}

// Only allow MCP fallback for read-only / network-fetch tools.
// Write, edit, bash, and other mutating tools must never silently
// redirect to a remote MCP capability.
export const MCP_FALLBACK_ALLOWED_TOOLS = new Set([
  'web_search',
  'web_fetch',
  'glob',
  'grep',
  'read',
  'code_search',
  'semantic_lookup',
]);

export async function tryMcpFallback(
  toolName: string,
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string | undefined> {
  if (!MCP_FALLBACK_ALLOWED_TOOLS.has(toolName)) {
    return undefined;
  }
  try {
    const hits = await ctx.extensionRuntime!.searchCapabilities('mcp', toolName, {
      kind: 'tool',
      limit: 1,
    });
    if (hits.length === 0) {
      return undefined;
    }
    const hit = hits[0] as { id?: string; name?: string };
    // Only fallback when the MCP tool name exactly matches the built-in name.
    if (!hit?.id || (hit.name !== toolName && !hit.id.endsWith(`:${toolName}`))) {
      return undefined;
    }
    const mcpResult = await ctx.extensionRuntime!.executeCapability('mcp', hit.id, input);
    const content = typeof mcpResult.content === 'string'
      ? mcpResult.content
      : JSON.stringify(mcpResult.structuredContent ?? mcpResult, null, 2);
    return `[MCP Fallback via ${hit.id}]\n${content}`;
  } catch (error) {
    if (process.env.KODAX_DEBUG_TOOL_HISTORY) {
      // eslint-disable-next-line no-console
      console.debug(`[tryMcpFallback] ${toolName} failed:`, error instanceof Error ? error.message : error);
    }
    return undefined;
  }
}

export interface RunToolDispatchInput {
  readonly toolBlocks: readonly KodaXToolUseBlock[];
  readonly events: KodaXEvents;
  readonly ctx: KodaXToolExecutionContext;
  readonly runtimeSessionState: RuntimeSessionState;
  readonly activeToolNames: string[] | undefined;
  readonly abortSignal: AbortSignal | undefined;
}

/**
 * CAP-077 + CAP-079: dispatch the assistant's tool_use blocks. Non-bash
 * tools run in parallel via `Promise.all`; bash tools run sequentially
 * with a per-iteration `abortSignal` recheck (mid-batch Ctrl+C honored).
 * Each call is wrapped with `applyToolResultGuardrail` (CAP-079) so the
 * truncation policy is the FIRST guardrail layer.
 *
 * Returns a `Map<id, content>` keyed by tool_use_id. Caller threads the
 * map into `applyPostToolProcessing` (CAP-078).
 */
export async function runToolDispatch(
  input: RunToolDispatchInput,
): Promise<Map<string, string>> {
  const bashTools = input.toolBlocks.filter((tc) => tc.name === 'bash');
  const nonBashTools = input.toolBlocks.filter((tc) => tc.name !== 'bash');
  const resultMap = new Map<string, string>();

  if (nonBashTools.length > 0) {
    const promises = nonBashTools.map(async (tc) => ({
      id: tc.id,
      content: (
        await applyToolResultGuardrail(
          tc.name,
          await executeToolCall(
            input.events,
            {
              id: tc.id,
              name: tc.name,
              input: tc.input as Record<string, unknown> | undefined,
            },
            input.ctx,
            input.runtimeSessionState,
            input.activeToolNames,
            input.abortSignal,
          ),
          input.ctx,
        )
      ).content,
    }));
    const results = await Promise.all(promises);
    for (const r of results) resultMap.set(r.id, r.content);
  }

  for (const tc of bashTools) {
    // Issue 088: Check abort signal before each sequential bash tool.
    if (input.abortSignal?.aborted) {
      resultMap.set(tc.id, CANCELLED_TOOL_RESULT_MESSAGE);
      continue;
    }
    const content = (
      await applyToolResultGuardrail(
        tc.name,
        await executeToolCall(
          input.events,
          {
            id: tc.id,
            name: tc.name,
            input: tc.input as Record<string, unknown> | undefined,
          },
          input.ctx,
          input.runtimeSessionState,
          input.activeToolNames,
          input.abortSignal,
        ),
        input.ctx,
      )
    ).content;
    resultMap.set(tc.id, content);
  }

  return resultMap;
}

export interface PostToolProcessingInput {
  readonly toolBlocks: readonly KodaXToolUseBlock[];
  readonly resultMap: Map<string, string>;
  readonly events: KodaXEvents;
  readonly emitActiveExtensionEvent: ExtensionEventEmitter;
  /**
   * Tool execution context. The function MUTATES
   * `ctx.mutationTracker.reflectionInjected` to `true` on the first
   * significant mutation result it processes — this latch is owned
   * by the caller's tracker (per-session, propagates back through the
   * shared reference). The `readonly` modifier on this field protects
   * the input wrapper, NOT the tracker's interior. Callers passing a
   * non-shared tracker will lose the once-per-session invariant.
   */
  readonly ctx: KodaXToolExecutionContext;
  readonly runtimeSessionState: RuntimeSessionState;
}

export interface PostToolProcessingOutput {
  readonly toolResults: KodaXToolResultBlock[];
  readonly editRecoveryMessages: string[];
}

/**
 * CAP-078: per-result post-processing chain. For each tool_use block,
 * in order:
 *   1. Mutation scope reflection — appended once when the tracker
 *      crosses threshold and the result is a non-error mutation tool.
 *   2. `updateToolOutcomeTracking` — outcome counters for the
 *      auto-reroute judge.
 *   3. Edit recovery message synthesis — for `'edit'` results carrying
 *      an error envelope.
 *   4. Visibility events — `tool:result` extension event +
 *      `events.onToolResult`, then push `tool_result` block into the
 *      accumulator for visible tools.
 *
 * Invisible tools (managed-protocol) are silently dropped from the
 * transcript: they neither emit visibility events nor push a
 * `tool_result` block. The `resultMap` lookup falls back to
 * `'[Error] No result'` for any block missing from the map.
 */
export async function applyPostToolProcessing(
  input: PostToolProcessingInput,
): Promise<PostToolProcessingOutput> {
  const toolResults: KodaXToolResultBlock[] = [];
  const editRecoveryMessages: string[] = [];

  for (const tc of input.toolBlocks) {
    let content = input.resultMap.get(tc.id) ?? '[Error] No result';
    // Scope reflection: when mutation tracker crosses threshold, append
    // once to a write tool result.
    if (
      input.ctx.mutationTracker
      && !input.ctx.mutationTracker.reflectionInjected
      && !isToolResultErrorContent(content)
      && isMutationTool(tc.name)
      && isMutationScopeSignificant(input.ctx.mutationTracker)
    ) {
      content += buildMutationScopeReflection(input.ctx.mutationTracker);
      // MUTATION: latches the once-per-session contract — see
      // `PostToolProcessingInput.ctx` JSDoc for the ownership note.
      input.ctx.mutationTracker.reflectionInjected = true;
    }
    updateToolOutcomeTracking(tc, content, input.runtimeSessionState, input.ctx);
    if (tc.name === 'edit' && isToolResultErrorContent(content)) {
      const recoveryMessage = await buildEditRecoveryUserMessage(
        tc,
        content,
        input.runtimeSessionState,
        input.ctx,
      );
      if (recoveryMessage) {
        editRecoveryMessages.push(recoveryMessage);
      }
    }
    if (isVisibleToolName(tc.name)) {
      await input.emitActiveExtensionEvent('tool:result', {
        id: tc.id,
        name: tc.name,
        content,
      });
      input.events.onToolResult?.({ id: tc.id, name: tc.name, content });
      toolResults.push(createToolResultBlock(tc.id, content));
    }
  }

  return { toolResults, editRecoveryMessages };
}
