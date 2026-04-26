/**
 * Tool dispatch — CAP-024 + CAP-025
 *
 * Capability inventory:
 *   - docs/features/v0.7.29-capability-inventory.md#cap-024-tool-execution-dispatch
 *   - docs/features/v0.7.29-capability-inventory.md#cap-025-mcp-fallback-resolution
 *
 * Class 1 (substrate middleware). The dispatch core: per-`tool_use`
 * block execution + MCP fallback + tool-result block construction.
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
 * Migration history: extracted from `agent.ts:873-880`
 * (`createToolResultBlock`), `agent.ts:1306-1379` (`executeToolCall`),
 * `agent.ts:1384-1392` (`MCP_FALLBACK_ALLOWED_TOOLS`),
 * `agent.ts:1394-1428` (`tryMcpFallback`) — pre-FEATURE_100 baseline
 * — during FEATURE_100 P2.
 */

import type {
  KodaXEvents,
  KodaXToolExecutionContext,
  KodaXToolResultBlock,
} from '../types.js';
import { CANCELLED_TOOL_RESULT_MESSAGE } from '../constants.js';
import { executeTool } from '../tools/index.js';
import { emitActiveExtensionEvent } from '../extensions/runtime.js';
import { isVisibleToolName } from './event-emitter.js';
import { getToolExecutionOverride } from './permission-gate.js';
import {
  type RunnableToolCall,
  maybeBlockExistingFileWrite,
} from './middleware/edit-recovery.js';
import { isToolResultErrorContent } from './tool-result-classify.js';
import type { RuntimeSessionState } from './runtime-session-state.js';

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
