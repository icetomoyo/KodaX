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
 * **`runToolDispatch` (CAP-077)** — splits assistant tool_use
 * blocks into bash and non-bash, runs non-bash tools in parallel
 * (`Promise.all`) and bash tools sequentially (so side-effecting bash
 * never races), and returns raw results. `applyPostToolProcessing` owns the
 * aggregate capacity decision only after visibility/reflection have formed
 * the final transcript batch. Individual tools and bridge targets do not
 * pre-truncate their output. Each iteration of the
 * bash sequential loop re-checks `abortSignal` (Issue 088 mid-batch
 * Ctrl+C); the upstream pre-tool abort gate (CAP-076 / `checkPreToolAbort`)
 * prevents this helper from running at all when the user has already
 * aborted before dispatch. Returns a `Map<id, content>` keyed by
 * `tool_use_id`.
 *
 * **`applyPostToolProcessing` (CAP-078 + CAP-079)** — per-result chain that runs
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
 *   4. Visibility filter — only visible tool names enter the transcript.
 *   5. Final-batch capacity admission — visible, reflected results and the
 *      synthetic edit-recovery message share one aggregate decision.
 *   6. Visibility events — emit the admitted content to extensions/hosts.
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
  KodaXToolEventMeta,
  KodaXToolExecutionContext,
  KodaXToolResultBlock,
} from '../types.js';
import type { CapabilityResult, KodaXToolUseBlock } from '@kodax-ai/llm';
import {
  emitKodaXDiagnostic,
  runToolAfterGuardrails,
  runToolBeforeGuardrails,
  type GuardrailContext,
  type RunnerToolCall,
  type RunnerToolResult,
  type ToolGuardrail,
} from '@kodax-ai/agent';
import { CANCELLED_TOOL_RESULT_MESSAGE } from '../constants.js';
import {
  executeTool,
  getToolDefinition,
  resolveToolBridgeTarget,
  TOOL_CALL_NAME,
  TOOL_DESCRIBE_NAME,
} from '../tools/index.js';
import { executeRunScopedTool, lookupRunScopedTool, toModelToolDefinition } from './run-scoped-tools.js';
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
import { applyToolResultBatchGuardrail } from '../tools/tool-result-policy.js';
import type { ToolResultBudget } from '../tools/tool-result-budget.js';
import {
  buildMutationScopeReflection,
  isMutationScopeSignificant,
  isMutationTool,
} from './middleware/mutation-reflection.js';
import { updateToolOutcomeTracking } from './middleware/tool-outcome-tracking.js';
import type { ExtensionEventEmitter } from './stream-handler-wiring.js';
import { estimateTokens } from '../tokenizer.js';

export function createToolResultBlock(
  toolUseId: string,
  content: string,
  metadata?: KodaXToolResultBlock['metadata'],
): KodaXToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    ...(isToolResultErrorContent(content) ? { is_error: true } : {}),
    ...(metadata ? { metadata } : {}),
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

  // NOTE: conservative tool-name repair (`Write` → `write`) happens ONCE
  // upstream in run-substrate via `repairToolBlockNames`, before history,
  // dispatch (bash routing), events, and the incomplete-tool scan read the
  // blocks — so the canonical name is used uniformly and `tool:start` /
  // `tool:result` cannot disagree. By the time a block reaches here its name
  // is already canonical.

  const visibleTool = isVisibleToolName(toolCall.name);
  const toolMeta = createToolEventMeta(events, toolCall.id);
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
    }, toolMeta);
  }

  // Bridge meta-tools do not perform the requested operation themselves.
  // `tool_call` re-enters the gate below with the concrete target, while
  // `tool_describe` is read-only. Gating the wrapper as well would produce two
  // indistinguishable permission prompts for one bridged operation.
  const isBridgeMetaTool = toolCall.name === TOOL_CALL_NAME || toolCall.name === TOOL_DESCRIBE_NAME;
  if (!isBridgeMetaTool) {
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
    if (abortSignal?.aborted) {
      return CANCELLED_TOOL_RESULT_MESSAGE;
    }
  }

  if (activeToolNames && !activeToolNames.includes(toolCall.name)) {
    return `[Tool Error] ${toolCall.name}: Tool is not active in the current runtime.`;
  }

  if (toolCall.name === TOOL_DESCRIBE_NAME) {
    return describeBridgeTools(toolCall.input ?? {}, activeToolNames, ctx.extensionRuntime);
  }
  if (toolCall.name === TOOL_CALL_NAME) {
    return executeBridgeToolCall({
      events,
      bridgeCall: toolCall,
      ctx,
      runtimeSessionState,
      activeToolNames,
      abortSignal,
    });
  }

  const blockedWrite = maybeBlockExistingFileWrite(toolCall, ctx, runtimeSessionState);
  if (blockedWrite) {
    return blockedWrite;
  }

  // FEATURE_067/229: inject per-call host hooks with stable tool/workflow meta.
  // FEATURE_247 (R7): always stamp `toolCallId` (the LLM tool_use block id) onto
  // the per-call ctx so host-registered tools can correlate a handler invocation
  // to its event stream / de-duplicate retries — both the hooks and no-hooks
  // branch carry it.
  // FEATURE_294: run-scoped host tools dispatch before the registry lookup so
  // a materialized lease tool executes through the capability channel even
  // though it never registers in TOOL_REGISTRY.
  // Registry-first mirrors the model-facing table (tool-resolution): a tool
  // registered after the binding wins, so the schema the model saw is the
  // implementation that executes.
  const runScopedDefinition = getToolDefinition(toolCall.name) === undefined
    ? lookupRunScopedTool(ctx.extensionRuntime, toolCall.name)
    : undefined;
  if (runScopedDefinition === undefined
    && getToolDefinition(toolCall.name) === undefined
    && activeToolNames?.includes(toolCall.name)) {
    // The name passed the frozen per-run candidate gate but resolves nowhere
    // live: the run-scoped host tool lease was revoked or expired mid-run.
    return `[Tool Error] ${toolCall.name}: Host tool lease was revoked or the tool is no longer bound to this run.`;
  }
  const ctxWithToolHooks = createContextForToolCall(events, toolCall, ctx);

  events.onToolExecutionStart?.(
    { id: toolCall.id, name: toolCall.name },
    toolMeta,
  );
  let result: string;
  try {
    result = runScopedDefinition === undefined
      ? await executeTool(toolCall.name, toolCall.input ?? {}, ctxWithToolHooks)
      : await executeRunScopedTool(ctxWithToolHooks, runScopedDefinition, toolCall.input ?? {});

    // MCP fallback: when a built-in tool fails, try to find a same-name MCP tool.
    if (result.startsWith('[Tool Error]') && ctx.extensionRuntime) {
      const fallbackResult = await tryMcpFallback(
        toolCall.name,
        toolCall.input ?? {},
        ctx,
      );
      if (fallbackResult !== undefined) result = fallbackResult;
    }
  } finally {
    events.onToolExecutionEnd?.(
      { id: toolCall.id, name: toolCall.name },
      toolMeta,
    );
  }
  return result;
}

export function createToolEventMeta(
  events: Pick<KodaXEvents, 'workflowCorrelation'>,
  toolId: string,
): KodaXToolEventMeta {
  return {
    toolId,
    ...(events.workflowCorrelation !== undefined ? { workflowCorrelation: events.workflowCorrelation } : {}),
  };
}

function createContextForToolCall(
  events: KodaXEvents,
  toolCall: RunnableToolCall,
  ctx: KodaXToolExecutionContext,
): KodaXToolExecutionContext {
  const toolMeta = createToolEventMeta(events, toolCall.id);
  return events.onToolProgress
      || events.onToolSandboxObservation
      || events.askUser
      || events.askUserMulti
      || events.askUserInput
    ? {
        ...ctx,
        toolCallId: toolCall.id,
        ...(events.onToolProgress
          ? {
              reportToolProgress: (message: string) => {
                events.onToolProgress?.({ id: toolCall.id, message }, toolMeta);
              },
            }
          : {}),
        ...(events.onToolSandboxObservation
          ? {
              reportToolSandboxObservation: (observation) => {
                events.onToolSandboxObservation?.(
                  { id: toolCall.id, observation },
                  toolMeta,
                );
              },
            }
          : {}),
        ...(events.askUser
          ? { askUser: (options) => events.askUser!(options, toolMeta) }
          : {}),
        ...(events.askUserMulti
          ? { askUserMulti: (options) => events.askUserMulti!(options, toolMeta) }
          : {}),
        ...(events.askUserInput
          ? { askUserInput: (options) => events.askUserInput!(options, toolMeta) }
          : {}),
      }
    : { ...ctx, toolCallId: toolCall.id };
}

function describeBridgeTools(
  input: Record<string, unknown>,
  activeToolNames: readonly string[] | undefined,
  extensionRuntime: KodaXToolExecutionContext['extensionRuntime'],
): string {
  const names = readBridgeToolNames(input);
  if (names.length === 0) {
    return '[Tool Error] tool_describe: `name` or `names` is required.';
  }

  const active = activeToolNames ? new Set(activeToolNames) : undefined;
  const lines: string[] = [];
  for (const name of names) {
    if (active && !active.has(name)) {
      lines.push(`<!-- ${name}: not active in the current runtime -->`);
      continue;
    }
    let definition = getToolDefinition(name);
    if (definition === undefined) {
      const runScoped = lookupRunScopedTool(extensionRuntime, name);
      if (runScoped !== undefined) definition = toModelToolDefinition(runScoped);
    }
    if (!definition) {
      lines.push(`<!-- ${name}: not registered -->`);
      continue;
    }
    lines.push(`<function>${JSON.stringify({
      name: definition.name,
      description: definition.description,
      parameters: definition.input_schema,
    })}</function>`);
  }

  return lines.join('\n');
}

function readBridgeToolNames(input: Record<string, unknown>): string[] {
  const names: string[] = [];
  const append = (value: unknown): void => {
    if (typeof value === 'string' && value.trim().length > 0) {
      names.push(value.trim());
    }
  };
  append(input.name);
  append(input.tool_name);
  for (const key of ['names', 'tools']) {
    const value = input[key];
    if (Array.isArray(value)) {
      for (const item of value) append(item);
    }
  }
  return [...new Set(names)];
}

async function executeBridgeToolCall(input: {
  readonly events: KodaXEvents;
  readonly bridgeCall: RunnableToolCall;
  readonly ctx: KodaXToolExecutionContext;
  readonly runtimeSessionState: RuntimeSessionState;
  readonly activeToolNames: readonly string[] | undefined;
  readonly abortSignal: AbortSignal | undefined;
}): Promise<string> {
  const resolved = resolveToolBridgeTarget(input.bridgeCall);
  if (!resolved?.ok) {
    return `[Tool Error] ${TOOL_CALL_NAME}: ${resolved?.error ?? 'invalid bridge call.'}`;
  }
  const targetCall = resolved.call;
  const targetName = targetCall.name;
  const targetInput = targetCall.input;
  if (targetName === TOOL_CALL_NAME || targetName === TOOL_DESCRIBE_NAME) {
    return `[Tool Error] ${TOOL_CALL_NAME}: bridge meta-tools cannot be called through ${TOOL_CALL_NAME}.`;
  }

  if (input.abortSignal?.aborted) {
    return CANCELLED_TOOL_RESULT_MESSAGE;
  }
  const override = await getToolExecutionOverride(
    input.events,
    targetName,
    targetInput,
    targetCall.id,
    input.ctx.executionCwd,
    input.ctx.gitRoot,
  );
  if (override !== undefined) {
    return override;
  }
  if (input.abortSignal?.aborted) {
    return CANCELLED_TOOL_RESULT_MESSAGE;
  }
  if (input.activeToolNames && !input.activeToolNames.includes(targetName)) {
    return `[Tool Error] ${targetName}: Tool is not active in the current runtime.`;
  }

  const blockedWrite = maybeBlockExistingFileWrite(targetCall, input.ctx, input.runtimeSessionState);
  if (blockedWrite) {
    return blockedWrite;
  }

  const ctxWithToolHooks = createContextForToolCall(input.events, targetCall, input.ctx);
  const recordTargetArtifact = ctxWithToolHooks.recordToolResultArtifact;
  if (recordTargetArtifact !== undefined) {
    ctxWithToolHooks.recordToolResultArtifact = (toolCallId, outputPath) => {
      recordTargetArtifact(toolCallId, outputPath);
      recordTargetArtifact(input.bridgeCall.id, outputPath);
    };
  }
  const toolMeta = createToolEventMeta(input.events, targetCall.id);
  const runScopedTarget = getToolDefinition(targetName) === undefined
    ? lookupRunScopedTool(input.ctx.extensionRuntime, targetName)
    : undefined;
  input.events.onToolExecutionStart?.(
    { id: targetCall.id, name: targetName },
    toolMeta,
  );
  let result: string;
  try {
    result = runScopedTarget === undefined
      ? await executeTool(targetName, targetInput, ctxWithToolHooks)
      : await executeRunScopedTool(ctxWithToolHooks, runScopedTarget, targetInput);
    if (result.startsWith('[Tool Error]') && input.ctx.extensionRuntime) {
      const fallbackResult = await tryMcpFallback(targetName, targetInput, input.ctx);
      if (fallbackResult !== undefined) result = fallbackResult;
    }
  } finally {
    input.events.onToolExecutionEnd?.(
      { id: targetCall.id, name: targetName },
      toolMeta,
    );
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

function stringifyMcpFallbackPart(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0 ? value : undefined;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatMcpFallbackContent(result: CapabilityResult): string {
  const content = stringifyMcpFallbackPart(result.content);
  const structured = stringifyMcpFallbackPart(result.structuredContent);
  if (content && structured && content !== structured) {
    return `${content}\n\nStructured content:\n${structured}`;
  }
  return content ?? structured ?? JSON.stringify(result, null, 2);
}

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
    const content = formatMcpFallbackContent(mcpResult);
    return `[MCP Fallback via ${hit.id}]\n${content}`;
  } catch (error) {
    if (process.env.KODAX_DEBUG_TOOL_HISTORY) {
      emitKodaXDiagnostic({
        source: 'coding:tool-dispatch',
        level: 'debug',
        message: `MCP fallback failed for ${toolName}.`,
        detail: error,
      });
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
  readonly toolGuardrails?: readonly ToolGuardrail[];
  readonly guardrailContext?: GuardrailContext;
  /** Supplies the post-commit transcript to after-tool guardrails. */
  readonly getAfterGuardrailContext?: () => GuardrailContext;
  /** Receives the post-rewrite call keyed by the immutable provider tool id. */
  readonly finalToolBlocks?: Map<string, KodaXToolUseBlock>;
  /** Fires after every before-guardrail settles and before any tool executes. */
  readonly onToolCallsPrepared?: (blocks: readonly KodaXToolUseBlock[]) => void;
}

interface PreparedToolCall {
  readonly index: number;
  readonly call: RunnerToolCall;
  readonly blockedContent?: string;
}

/**
 * CAP-077: dispatch the assistant's tool_use blocks. Non-bash
 * tools run in parallel via `Promise.all`; bash tools run sequentially
 * with a per-iteration `abortSignal` recheck (mid-batch Ctrl+C honored).
 * Results remain raw here because visibility filtering and mutation
 * reflection have not formed the final transcript batch yet.
 *
 * Returns a `Map<id, content>` keyed by tool_use_id. Caller threads the
 * map into `applyPostToolProcessing` (CAP-078).
 */
export async function runToolDispatch(
  input: RunToolDispatchInput,
): Promise<Map<string, string>> {
  const resultMap = new Map<string, string>();
  const preparedByIndex = new Map<number, PreparedToolCall>();
  const nonBashEntries = input.toolBlocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.name !== 'bash');
  const preparedNonBash = await Promise.all(nonBashEntries.map(
    ({ block, index }) => prepareToolBlock(input, block, index),
  ));
  for (const prepared of preparedNonBash) {
    preparedByIndex.set(prepared.index, prepared);
  }
  for (let index = 0; index < input.toolBlocks.length; index += 1) {
    const block = input.toolBlocks[index]!;
    if (block.name !== 'bash') continue;
    preparedByIndex.set(index, await prepareToolBlock(input, block, index));
  }
  const preparedCalls = input.toolBlocks.map((_, index) => {
    const prepared = preparedByIndex.get(index);
    if (!prepared) throw new Error(`Tool call at index ${index} was not prepared.`);
    return prepared;
  });

  // The host commits these canonical calls to transcript/session before any
  // observer, permission hook, or executor can consume them.
  input.onToolCallsPrepared?.(
    preparedCalls.map((prepared) => runnerCallToToolBlock(prepared.call)),
  );

  for (const prepared of preparedCalls) {
    if (prepared.blockedContent === undefined) continue;
    await emitToolCallStart(input.events, prepared.call);
    resultMap.set(prepared.call.id, prepared.blockedContent);
  }

  const parallel = preparedCalls.filter((prepared) => (
    prepared.blockedContent === undefined
    && input.toolBlocks[prepared.index]!.name !== 'bash'
    && prepared.call.name !== 'bash'
  ));
  const parallelResults = await Promise.all(parallel.map(async (prepared) => ({
    id: prepared.call.id,
    content: await executePreparedToolCall(input, prepared.call),
  })));
  for (const result of parallelResults) resultMap.set(result.id, result.content);

  const serial = preparedCalls.filter((prepared) => (
    prepared.blockedContent === undefined
    && (input.toolBlocks[prepared.index]!.name === 'bash' || prepared.call.name === 'bash')
  ));
  for (const prepared of serial) {
    if (input.abortSignal?.aborted) {
      resultMap.set(prepared.call.id, CANCELLED_TOOL_RESULT_MESSAGE);
      continue;
    }
    resultMap.set(
      prepared.call.id,
      await executePreparedToolCall(input, prepared.call),
    );
  }

  return resultMap;
}

async function prepareToolBlock(
  input: RunToolDispatchInput,
  block: KodaXToolUseBlock,
  index: number,
): Promise<PreparedToolCall> {
  const original: RunnerToolCall = {
    id: block.id,
    name: block.name,
    input: block.input as Record<string, unknown>,
  };
  let prepared: PreparedToolCall = { index, call: original };
  if (!input.abortSignal?.aborted && input.toolGuardrails?.length) {
    if (!input.guardrailContext) {
      throw new Error('Tool guardrails require a GuardrailContext.');
    }
    const outcome = await runToolBeforeGuardrails(
      original,
      input.toolGuardrails,
      input.guardrailContext,
      null,
    );
    prepared = outcome.kind === 'block'
      ? {
          index,
          call: outcome.call,
          blockedContent: normalizeGuardrailResult(outcome.result.content, true),
        }
      : { index, call: outcome.call };
  }
  input.finalToolBlocks?.set(block.id, runnerCallToToolBlock(prepared.call));
  return prepared;
}

async function executePreparedToolCall(
  input: RunToolDispatchInput,
  call: RunnerToolCall,
): Promise<string> {
  let content = await executeToolCall(
    input.events,
    call,
    input.ctx,
    input.runtimeSessionState,
    input.activeToolNames,
    input.abortSignal,
  );
  if (input.toolGuardrails?.length && input.guardrailContext) {
    const result = await runToolAfterGuardrails(
      call,
      { content, isError: isToolResultErrorContent(content) },
      input.toolGuardrails,
      input.getAfterGuardrailContext?.() ?? input.guardrailContext,
      null,
    );
    content = normalizeGuardrailResult(result.content, result.isError === true);
  }
  return content;
}

function runnerCallToToolBlock(call: RunnerToolCall): KodaXToolUseBlock {
  return {
    id: call.id,
    name: call.name,
    type: 'tool_use',
    input: call.input,
  } as KodaXToolUseBlock;
}

function normalizeGuardrailResult(content: RunnerToolResult['content'], isError: boolean): string {
  const text = typeof content === 'string'
    ? content
    : content.map((item) => (
        item.type === 'text' ? item.text : `[Image: ${item.path}]`
      )).join('\n');
  return isError && !isToolResultErrorContent(text)
    ? `[Blocked] ${text}`
    : text;
}

async function emitToolCallStart(
  events: KodaXEvents,
  call: RunnerToolCall,
): Promise<void> {
  if (!isVisibleToolName(call.name)) return;
  await emitActiveExtensionEvent('tool:start', {
    name: call.name,
    id: call.id,
    input: call.input,
  });
  events.onToolUseStart?.({
    name: call.name,
    id: call.id,
    input: call.input,
  }, createToolEventMeta(events, call.id));
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
  readonly toolResultBudget?: ToolResultBudget;
  /** Trusted artifacts recorded by tools during this dispatch. */
  readonly toolResultArtifactPaths?: ReadonlyMap<string, string>;
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
 *   4. Visibility filter into the final `tool_result` accumulator.
 *   5. Aggregate capacity admission over the final visible/reflected batch
 *      plus its same-request edit-recovery message.
 *   6. Visibility events carrying the admitted content.
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
      const outputPath = input.toolResultArtifactPaths?.get(tc.id);
      toolResults.push(createToolResultBlock(
        tc.id,
        content,
        outputPath
          ? { truncated: true, capacityFallback: true, outputPath }
          : undefined,
      ));
    }
  }

  const finalToolResults = await admitAndEmitVisibleToolResults(
    input,
    toolResults,
    editRecoveryMessages,
  );
  return {
    toolResults: finalToolResults,
    editRecoveryMessages,
  };
}

async function admitAndEmitVisibleToolResults(
  input: PostToolProcessingInput,
  toolResults: readonly KodaXToolResultBlock[],
  editRecoveryMessages: readonly string[],
): Promise<KodaXToolResultBlock[]> {
  const toolBlockById = new Map(input.toolBlocks.map((block) => [block.id, block]));
  const recoveryMessageTokens = editRecoveryMessages.length > 0
    ? estimateTokens([{
        role: 'user',
        content: editRecoveryMessages.join('\n\n'),
        _synthetic: true,
      }])
    : 0;
  const guardedBatch = await applyToolResultBatchGuardrail(
    toolResults.map((result) => ({
      id: result.tool_use_id,
      toolName: toolBlockById.get(result.tool_use_id)?.name ?? 'tool',
      content: result.content as string,
      ...(typeof result.metadata?.outputPath === 'string' && result.metadata.outputPath.length > 0
        ? { outputPath: result.metadata.outputPath }
        : {}),
    })),
    input.ctx,
    input.toolResultBudget,
    recoveryMessageTokens,
  );
  const guardedById = new Map(guardedBatch.entries.map((entry) => [entry.id, entry]));
  const finalResults = toolResults.map((result) => {
    const guarded = guardedById.get(result.tool_use_id);
    if (!guarded || guarded.content === result.content) {
      // FEATURE_296 (ADR-067): an over-budget batch admits with debt metadata
      // so the pair commits; the recovery ladder owns the next request.
      return guardedBatch.capacityDebt
        ? { ...result, metadata: { ...(result.metadata ?? {}), capacityDebt: true } }
        : result;
    }
    return {
      ...result,
      content: guarded.content,
      metadata: {
        ...(result.metadata ?? {}),
        truncated: true,
        capacityFallback: true,
        ...(guardedBatch.capacityDebt ? { capacityDebt: true } : {}),
        ...(guarded.outputPath ? { outputPath: guarded.outputPath } : {}),
      },
    };
  });
  for (const result of finalResults) {
    const toolBlock = toolBlockById.get(result.tool_use_id);
    if (!toolBlock || typeof result.content !== 'string') continue;
    await input.emitActiveExtensionEvent('tool:result', {
      id: toolBlock.id,
      name: toolBlock.name,
      content: result.content,
    });
    input.events.onToolResult?.(
      { id: toolBlock.id, name: toolBlock.name, content: result.content },
      createToolEventMeta(input.events, toolBlock.id),
    );
  }
  return finalResults;
}
