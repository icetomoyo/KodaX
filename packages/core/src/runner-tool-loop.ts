/**
 * Runner Tool Loop — FEATURE_084 Shard 1 (v0.7.26).
 *
 * Extends the Layer A Runner generic-dispatch path with tool-call support.
 * Before Shard 1 the Runner could only do a single `system+user → assistant`
 * turn. Now the injected LLM callback may return a structured result that
 * declares tool calls; the Runner executes them, appends tool_use +
 * tool_result content blocks, and loops until the LLM stops emitting tool
 * calls (or MAX_TOOL_LOOP_ITERATIONS is reached).
 *
 * This Shard only lands the capability. No built-in Agent consumes it yet —
 * the coding preset (SA path) continues to dispatch through
 * `registerPresetDispatcher` unchanged.
 *
 * @experimental Shape may be refined during the v0.7.26 shard rollout.
 */

import type {
  KodaXContentBlock,
  KodaXRedactedThinkingBlock,
  KodaXTextBlock,
  KodaXThinkingBlock,
  KodaXToolResultBlock,
  KodaXToolUseBlock,
} from '@kodax/ai';
import type { Span } from '@kodax/tracing';

import type { Agent, AgentMessage, AgentTool } from './agent.js';

/**
 * Hard ceiling on tool-loop iterations. A single run may invoke at most this
 * many LLM turns (counting the initial turn); if the model keeps returning
 * tool calls past this limit we abort to prevent runaway behaviour.
 */
export const MAX_TOOL_LOOP_ITERATIONS = 20;

/**
 * One tool invocation requested by the LLM.
 */
export interface RunnerToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/**
 * Structured LLM result. Returning this instead of a plain string lets the
 * Runner drive a tool loop. If `toolCalls` is empty or omitted the loop
 * terminates and `text` becomes the final output.
 */
export interface RunnerLlmResult {
  readonly text: string;
  readonly toolCalls?: readonly RunnerToolCall[];
  readonly stopReason?: string;
  /**
   * v0.7.26 parity: extended-thinking blocks from the provider stream.
   * Must be preserved on the assistant message so (a) session resume can
   * re-render them and (b) Anthropic's extended-thinking API contract is
   * honoured — provider rejects the next turn with a 400 when a tool_use
   * turn's `thinking` block is missing from prior assistant history.
   */
  readonly thinkingBlocks?: readonly (KodaXThinkingBlock | KodaXRedactedThinkingBlock)[];
}

/**
 * LLM callback return type. `string` preserves the v0.7.23 single-turn
 * behaviour; `RunnerLlmResult` opts into the tool loop.
 */
export type RunnerLlmReturn = string | RunnerLlmResult;

/**
 * Observer callbacks fired around every tool invocation. Preset
 * dispatchers (e.g. the coding Runner-driven path) pass these through
 * `RunOptions.toolObserver` so REPL / CLI consumers see live
 * `onToolCall` / `onToolResult` events, matching the legacy task-engine
 * event surface (v0.7.22 agent.ts fired `events.onToolResult` at three
 * sites per invocation).
 */
export interface RunnerToolObserver {
  /**
   * Permission / policy gate fired BEFORE each tool invocation. Return
   * `true` (or `undefined`) to allow, `false` to block with a generic
   * message, or a `string` to block with that message as the tool result.
   * Used to hook plan-mode / accept-edits / extension `tool:before`
   * policies onto the Runner-driven path (v0.7.22 parity — legacy
   * `events.beforeToolExecute` surface).
   */
  readonly beforeTool?: (call: RunnerToolCall) => Promise<boolean | string | undefined>;
  readonly onToolCall?: (call: RunnerToolCall) => void;
  readonly onToolResult?: (call: RunnerToolCall, result: RunnerToolResult) => void;
}

/**
 * Context passed to a RunnableTool's `execute` function.
 */
export interface RunnerToolContext {
  readonly agent: Agent;
  readonly abortSignal?: AbortSignal;
  /** The agent's Span, so tool implementations can nest custom spans if needed. */
  readonly agentSpan?: Span | null;
  /**
   * Current tool_use call id. Passed through so tool wrappers can correlate
   * progress events (`onToolProgress`) and other per-call side-effects with
   * the REPL's tool-block in the transcript. Populated by `executeRunnerToolCall`.
   */
  readonly toolCallId?: string;
}

/**
 * Value returned by `RunnableTool.execute`. The `content` string is what the
 * LLM sees in the next turn as `tool_result`.
 */
export interface RunnerToolResult {
  readonly content: string;
  readonly isError?: boolean;
  readonly metadata?: Record<string, unknown>;
}

/**
 * A tool bundled with its executor. Extends `AgentTool` (the wire-format
 * `KodaXToolDefinition`) so it can be passed through to the provider
 * unchanged while also carrying a function the Runner can invoke.
 */
export interface RunnableTool extends AgentTool {
  readonly execute: (
    input: Record<string, unknown>,
    ctx: RunnerToolContext,
  ) => Promise<RunnerToolResult>;
}

/**
 * Narrowing helper — distinguishes a `RunnableTool` from a plain
 * `AgentTool`. An agent may declare both: the Runner only executes the
 * tools that carry an `execute` function.
 */
export function isRunnableTool(tool: AgentTool): tool is RunnableTool {
  return typeof (tool as { execute?: unknown }).execute === 'function';
}

/**
 * Narrowing helper for the LLM callback return shape.
 */
export function isRunnerLlmResult(value: unknown): value is RunnerLlmResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'text' in value &&
    typeof (value as RunnerLlmResult).text === 'string'
  );
}

/**
 * Execute one tool call against the agent's declared tools. Emits a
 * ToolCallSpan under `ctx.agentSpan` when tracing is active. Returns a
 * `RunnerToolResult` — tool errors do not throw, they are surfaced with
 * `isError: true` so the LLM can see them in the next turn and react.
 */
export async function executeRunnerToolCall(
  call: RunnerToolCall,
  agent: Agent,
  ctx: RunnerToolContext,
): Promise<RunnerToolResult> {
  const tool = agent.tools?.find((t) => t.name === call.name);
  const toolSpan = ctx.agentSpan
    ? ctx.agentSpan.addChild(`tool_call:${call.name}`, {
        kind: 'tool_call',
        toolName: call.name,
        inputPreview: safePreview(call.input),
        status: 'ok',
      })
    : null;

  if (!tool) {
    const error = new Error(
      `tool "${call.name}" not declared on agent "${agent.name}"`,
    );
    if (toolSpan) {
      toolSpan.setError(error);
      toolSpan.end();
    }
    return { content: `Error: ${error.message}`, isError: true };
  }

  if (!isRunnableTool(tool)) {
    const error = new Error(
      `tool "${call.name}" is declared on agent "${agent.name}" but has no executor — the Runner generic path only runs RunnableTool instances`,
    );
    if (toolSpan) {
      toolSpan.setError(error);
      toolSpan.end();
    }
    return { content: `Error: ${error.message}`, isError: true };
  }

  try {
    // Propagate the tool_use call id into the execute context so tool
    // wrappers can attach per-call side-effects (progress events,
    // telemetry, etc.) without threading the id through every layer.
    const executeCtx: RunnerToolContext = { ...ctx, toolCallId: call.id };
    const result = await tool.execute(call.input, executeCtx);
    if (toolSpan) {
      if (result.isError) {
        toolSpan.setError(new Error(result.content));
      }
      toolSpan.end();
    }
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (toolSpan) {
      toolSpan.setError(error);
      toolSpan.end();
    }
    return { content: `Error: ${error.message}`, isError: true };
  }
}

/**
 * Build the assistant message that captures one LLM turn. Preserves
 * thinking blocks (extended-thinking contract), text blocks, and tool_use
 * blocks in the order Anthropic's wire format expects: thinking → text →
 * tool_use. This mirrors v0.7.22 `agent.ts:2230`
 * (`[...thinkingBlocks, ...textBlocks, ...visibleToolBlocks]`) which the
 * Runner-driven path must preserve — without it Anthropic returns 400 on
 * the next turn when extended thinking is active, and session resume
 * loses the reasoning trace.
 */
export function buildAssistantMessageFromLlmResult(
  result: RunnerLlmResult,
): AgentMessage {
  const blocks: KodaXContentBlock[] = [];
  if (result.thinkingBlocks && result.thinkingBlocks.length > 0) {
    for (const tb of result.thinkingBlocks) {
      blocks.push(tb);
    }
  }
  if (result.text.length > 0) {
    const textBlock: KodaXTextBlock = { type: 'text', text: result.text };
    blocks.push(textBlock);
  }
  if (result.toolCalls && result.toolCalls.length > 0) {
    for (const call of result.toolCalls) {
      const useBlock: KodaXToolUseBlock = {
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.input,
      };
      blocks.push(useBlock);
    }
  }
  // If the LLM returned nothing we still emit an empty text block so the
  // message is well-formed.
  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '' } satisfies KodaXTextBlock);
  }
  return { role: 'assistant', content: blocks };
}

/**
 * Build the user message that carries tool_result blocks back to the LLM.
 * Provider serializers (Anthropic, OpenAI) both accept tool_result on the
 * user turn.
 */
export function buildToolResultMessage(
  calls: readonly RunnerToolCall[],
  results: readonly RunnerToolResult[],
): AgentMessage {
  const blocks: KodaXContentBlock[] = [];
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i]!;
    const result = results[i]!;
    const block: KodaXToolResultBlock = {
      type: 'tool_result',
      tool_use_id: call.id,
      content: result.content,
      ...(result.isError === true ? { is_error: true } : {}),
    };
    blocks.push(block);
  }
  return { role: 'user', content: blocks };
}

function safePreview(input: unknown): string {
  try {
    const json = JSON.stringify(input);
    if (json === undefined) return '[undefined]';
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return '[unserializable]';
  }
}
