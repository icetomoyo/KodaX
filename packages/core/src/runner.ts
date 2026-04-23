/**
 * Layer A Primitive: Runner
 *
 * FEATURE_080 (v0.7.23): minimal execution entry for an `Agent`.
 *
 * Two dispatch paths:
 *   1. **Preset dispatch** (the "default coding agent" registers via
 *      `registerPresetDispatcher`): delegates to the existing `runKodaX`
 *      implementation so SA users see zero behavior change. This is the
 *      "Option Y" dog-food wiring negotiated during FEATURE_080+081 design.
 *   2. **Generic dispatch**: for user-defined agents. Performs a single
 *      system+user → assistant turn using an injected LLM callback. No tool
 *      loop, no extensions, no managed-task harness — those arrive with
 *      FEATURE_084 (v0.7.26).
 *
 * Status: @experimental. Moved to `@kodax/core` in FEATURE_082 (v0.7.24).
 * `@kodax/coding` retains a barrel re-export for batteries-included consumers.
 */

import type { Span, Tracer, Trace } from '@kodax/tracing';
import { defaultTracer } from '@kodax/tracing';

import type { Agent, AgentMessage, Guardrail } from './agent.js';
import type { Session } from './session.js';
import {
  MAX_TOOL_LOOP_ITERATIONS,
  buildAssistantMessageFromLlmResult,
  buildToolResultMessage,
  executeRunnerToolCall,
  isRunnerLlmResult,
  type RunnerLlmResult,
  type RunnerLlmReturn,
  type RunnerToolCall,
  type RunnerToolObserver,
  type RunnerToolResult,
} from './runner-tool-loop.js';
import {
  collectGuardrails,
  runInputGuardrails,
  runOutputGuardrails,
  runToolAfterGuardrails,
  runToolBeforeGuardrails,
} from './guardrail.js';
import {
  detectHandoffSignal,
  emitHandoffSpan,
  replaceSystemMessage,
} from './runner-handoff.js';

/**
 * Options accepted by `Runner.run` and `Runner.runStream`.
 */
export interface RunOptions {
  /**
   * Opaque payload forwarded to the preset dispatcher when one matches.
   * For the built-in coding preset this carries `KodaXOptions`.
   */
  readonly presetOptions?: unknown;
  /**
   * LLM callback used by the generic dispatch path. Receives the assembled
   * message transcript and the current Agent.
   *
   * Return a plain `string` to preserve the v0.7.23 single-turn behaviour
   * (no tool loop). Return a `RunnerLlmResult` with `toolCalls` to opt into
   * the FEATURE_084 tool loop — the Runner will execute each call against
   * the agent's `RunnableTool`s, append tool_use + tool_result blocks to
   * the transcript, and invoke this callback again until no tool calls are
   * returned (or `MAX_TOOL_LOOP_ITERATIONS` is reached).
   */
  readonly llm?: (
    messages: readonly AgentMessage[],
    agent: Agent,
  ) => Promise<RunnerLlmReturn>;
  /**
   * Optional Session to persist the generic-path transcript into. When
   * supplied, each generated message is appended as a `message` entry.
   */
  readonly session?: Session;
  /**
   * Abort signal forwarded to preset dispatchers that honor it.
   */
  readonly abortSignal?: AbortSignal;
  /**
   * FEATURE_083 (v0.7.24): tracer used to record AgentSpan / GenerationSpan /
   * ToolCallSpan / HandoffSpan for this run. Defaults to `defaultTracer` when
   * omitted. Pass `null` to disable tracing for this call.
   */
  readonly tracer?: Tracer | null;
  /**
   * When supplied, the run attaches its AgentSpan as a child of this trace's
   * root span instead of starting a new trace. Useful when an outer Agent
   * is orchestrating sub-runs and wants one trace per user request.
   */
  readonly trace?: Trace;
  /**
   * FEATURE_085 (v0.7.26): run-scoped guardrails. Merged with
   * `agent.guardrails` — declaration order is agent-first, then opts.
   * Input / output / tool-before / tool-after hooks all dispatch from
   * this union. See `@kodax/core/guardrail.ts` for shape.
   */
  readonly guardrails?: readonly Guardrail[];
  /**
   * Per-run override for the tool-loop iteration cap. When omitted, the
   * loop uses `MAX_TOOL_LOOP_ITERATIONS` (20) — a safe ceiling for
   * stand-alone agent runs. Managed-task orchestration (multi-role
   * handoff chain: Scout → Planner → Generator → Evaluator) needs a much
   * higher cap because the iteration counter is shared across every
   * role in the chain. Legacy `runManagedTask` gave each role its own
   * `DEFAULT_MANAGED_WORK_BUDGET` (200) — the Runner-driven path passes
   * that value here so long investigations don't trip the safety valve
   * after ~20 tool calls.
   */
  readonly maxToolLoopIterations?: number;
  /**
   * v0.7.26 parity: observer callbacks fired around every tool
   * invocation. Legacy `runManagedTask` emitted `events.onToolResult`
   * at three sites per invocation so the REPL worker ledger could
   * render live tool-call progress — without this plumbing, the
   * Runner-driven path's UI shows only the final output. Preset
   * dispatchers can attach this observer to surface `onToolCall` /
   * `onToolResult` through the usual `KodaXEvents` bus.
   */
  readonly toolObserver?: RunnerToolObserver;
  /**
   * v0.7.26 parity: compaction hook. Called AFTER each iteration's
   * tool_result has been appended to the transcript (or after the
   * assistant message when there are no tool calls), before the next
   * LLM turn. Return the replacement transcript to trigger compaction;
   * return the same array (or undefined) to skip. Legacy agent.ts ran
   * `intelligentCompact` on the same boundary, so Runner-driven parity
   * requires this hook point. The Runner owns the transcript mutably,
   * so this is the only point consumers can insert a compacted view.
   */
  readonly compactionHook?: (
    transcript: readonly AgentMessage[],
  ) => Promise<readonly AgentMessage[] | undefined>;
}

/**
 * Result returned by `Runner.run`.
 */
export interface RunResult<TData = unknown> {
  readonly output: string;
  readonly messages: readonly AgentMessage[];
  readonly sessionId?: string;
  readonly data?: TData;
}

/**
 * Stream events emitted by `Runner.runStream`. The event surface is
 * intentionally small in v0.7.23; FEATURE_084 expands it to mirror the
 * task-engine's event set.
 */
export type RunEvent<TData = unknown> =
  | { readonly kind: 'message'; readonly message: AgentMessage }
  | { readonly kind: 'complete'; readonly result: RunResult<TData> }
  | { readonly kind: 'error'; readonly error: Error };

/**
 * Tracing context handed to preset dispatchers so they can attach richer
 * spans (e.g. GenerationSpan, ToolCallSpan) under the Runner's AgentSpan.
 *
 * FEATURE_083 (v0.7.24): added in Slice 8 to let the coding preset emit
 * the AgentSpan lifecycle under the same trace as the Runner entry point.
 */
export interface PresetTracingContext {
  readonly tracer: Tracer;
  readonly trace: Trace;
  readonly agentSpan: Span;
}

/**
 * Preset dispatcher signature. Registered via `registerPresetDispatcher` and
 * keyed on `Agent.name`. The optional fourth argument carries tracing
 * context created by the Runner; dispatchers may emit child spans under
 * `tracingContext.agentSpan`.
 */
export type PresetDispatcher = (
  agent: Agent,
  input: string | readonly AgentMessage[],
  opts: RunOptions | undefined,
  tracingContext?: PresetTracingContext,
) => Promise<RunResult>;

const presetDispatchers = new Map<string, PresetDispatcher>();

/**
 * Register a preset dispatcher for a given Agent name. The coding package
 * registers the `runKodaX` dispatcher for the default coding agent on
 * import of `createDefaultCodingAgent`.
 *
 * Returns an unregister function.
 */
export function registerPresetDispatcher(
  agentName: string,
  dispatcher: PresetDispatcher,
): () => void {
  if (!agentName) {
    throw new Error('registerPresetDispatcher: agentName must be non-empty');
  }
  presetDispatchers.set(agentName, dispatcher);
  return () => {
    if (presetDispatchers.get(agentName) === dispatcher) {
      presetDispatchers.delete(agentName);
    }
  };
}

/** @internal Testing helper. Do not rely on this from application code. */
export function _resetPresetDispatchers(): void {
  presetDispatchers.clear();
}

function normalizeInput(input: string | readonly AgentMessage[]): readonly AgentMessage[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  return input;
}

function resolveInstructions(agent: Agent): string {
  const { instructions } = agent;
  if (typeof instructions === 'function') {
    return instructions(undefined);
  }
  return instructions;
}

function extractLastText(message: AgentMessage): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block) {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') texts.push(text);
    }
  }
  return texts.join('');
}

async function appendMessageEntry(session: Session, message: AgentMessage): Promise<void> {
  await session.append({
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    type: 'message',
    payload: {
      role: message.role,
      content: message.content,
    },
  });
}

interface GenerationTurnOutcome {
  readonly result: RunnerLlmResult;
  /** True when the llm callback returned a plain string (v0.7.23 shape). */
  readonly wasPlainString: boolean;
}

async function runGenerationTurn(
  agent: Agent,
  transcript: readonly AgentMessage[],
  llm: NonNullable<RunOptions['llm']>,
  agentSpan: Span | null,
): Promise<GenerationTurnOutcome> {
  const genSpan = agentSpan
    ? agentSpan.addChild(`generation:${agent.name}`, {
        kind: 'generation',
        agentName: agent.name,
        provider: agent.provider ?? 'unknown',
        model: agent.model ?? 'unknown',
        inputMessages: transcript.length,
      })
    : null;
  let reply: RunnerLlmReturn;
  try {
    reply = await llm([...transcript], agent);
  } catch (err) {
    if (genSpan) {
      genSpan.setError(err instanceof Error ? err : new Error(String(err)));
      genSpan.end();
    }
    throw err;
  }
  if (genSpan) {
    genSpan.end();
  }
  if (isRunnerLlmResult(reply)) {
    return { result: reply, wasPlainString: false };
  }
  // v0.7.23 backward-compat path: plain string → single-turn result.
  return { result: { text: reply, toolCalls: [] }, wasPlainString: true };
}

async function genericRun<TData>(
  startAgent: Agent,
  input: string | readonly AgentMessage[],
  opts: RunOptions | undefined,
  agentSpan: Span | null,
): Promise<RunResult<TData>> {
  if (!opts?.llm) {
    throw new Error(
      `Runner.run: agent "${startAgent.name}" has no registered preset dispatcher and no \`llm\` callback was provided. `
      + 'Either use a registered preset (e.g. createDefaultCodingAgent()) or pass opts.llm.',
    );
  }
  const instructions = resolveInstructions(startAgent);
  const userMessages = normalizeInput(input);
  const systemMessage: AgentMessage = { role: 'system', content: instructions };
  let transcript: AgentMessage[] = [systemMessage, ...userMessages];

  // FEATURE_085: collect guardrails from the START agent + opts. For Shard 4
  // guardrails are run-scoped — handoffs do NOT re-run input/output hooks
  // with the target agent's guardrails. Tool hooks run on every invocation
  // regardless of which agent is currently active.
  const mergedGuardrails: Guardrail[] = [];
  if (startAgent.guardrails) mergedGuardrails.push(...startAgent.guardrails);
  if (opts.guardrails) mergedGuardrails.push(...opts.guardrails);
  const guardrailSlots = collectGuardrails(mergedGuardrails);

  // FEATURE_084 Shard 4: the active agent may change mid-run when an emit
  // tool's result signals a handoff. `currentAgent` tracks this.
  let currentAgent: Agent = startAgent;
  const guardrailCtx = { agent: startAgent, abortSignal: opts.abortSignal };

  // Input guardrails: runs once on the assembled transcript before the first
  // LLM turn. A rewrite replaces the transcript; block/escalate throws.
  if (guardrailSlots.input.length > 0) {
    const inspected = await runInputGuardrails(transcript, guardrailSlots.input, guardrailCtx, agentSpan);
    transcript = [...inspected];
  }

  // Parity with the output-guardrail side: session records what the LLM
  // actually saw (post-guardrail), not the raw input. If an input
  // guardrail rewrote the transcript, the rewrite is what subsequent
  // iterations operate on; --resume / Scout replay / audit consumers
  // must see the same shape on both ends.
  if (opts.session) {
    for (const message of transcript) {
      if (message.role === 'user') {
        await appendMessageEntry(opts.session, message);
      }
    }
  }

  const iterationCap = opts.maxToolLoopIterations ?? MAX_TOOL_LOOP_ITERATIONS;
  for (let iteration = 0; iteration < iterationCap; iteration += 1) {
    const { result: turn, wasPlainString } = await runGenerationTurn(
      currentAgent,
      transcript,
      opts.llm,
      agentSpan,
    );
    const toolCalls = turn.toolCalls ?? [];

    // Preserve the v0.7.23 wire shape: when the llm returned a plain string
    // AND no tool calls happened, the assistant message carries plain-string
    // content. Consumers that snapshotted transcripts from v0.7.23 must keep
    // reading the same shape. Tool-loop turns always emit block content.
    let assistantMessage: AgentMessage =
      wasPlainString && toolCalls.length === 0
        ? { role: 'assistant', content: turn.text }
        : buildAssistantMessageFromLlmResult(turn);

    if (toolCalls.length === 0) {
      // Final turn — apply output guardrails before returning.
      if (guardrailSlots.output.length > 0) {
        assistantMessage = await runOutputGuardrails(
          assistantMessage,
          guardrailSlots.output,
          guardrailCtx,
          agentSpan,
        );
      }
      transcript.push(assistantMessage);
      if (opts.session) {
        await appendMessageEntry(opts.session, assistantMessage);
      }
      const finalText =
        typeof assistantMessage.content === 'string'
          ? assistantMessage.content
          : extractLastText(assistantMessage);
      return {
        output: finalText,
        messages: transcript,
        sessionId: opts.session?.id,
      };
    }

    // Tool-using turn — append assistant message (tool_use blocks), then
    // execute each call (before/after guardrail hooks around each), append
    // the tool_result user message, loop.
    transcript.push(assistantMessage);
    if (opts.session) {
      await appendMessageEntry(opts.session, assistantMessage);
    }

    const results: RunnerToolResult[] = new Array(toolCalls.length);
    const finalCalls: typeof toolCalls = [...toolCalls];

    // v0.7.26 parity (C2): execute tool calls with the legacy concurrency
    // model — non-bash tools run in parallel (Promise.all), bash tools
    // run serially. Legacy coding path: agent.ts:2533-2589. Parallelism
    // matters for scout-emitted fan-outs (3 dispatch_child_task in a
    // single turn should run concurrently, not 3x serial latency).
    // Bash stays serial because shell side-effects can interfere
    // (git checkout followed by git diff, etc.).
    const executeOneCall = async (index: number): Promise<void> => {
      let call = toolCalls[index]!;
      if (guardrailSlots.tool.length > 0) {
        // Tool guardrails are per-invocation (comment L313-316): the
        // active agent may have changed via handoff, so the hook must
        // see the CURRENT agent, not the run's start agent. Input /
        // output guardrails keep run-scoped `guardrailCtx` as designed.
        const beforeOutcome = await runToolBeforeGuardrails(
          call,
          guardrailSlots.tool,
          { ...guardrailCtx, agent: currentAgent },
          agentSpan,
        );
        if (beforeOutcome.kind === 'block') {
          results[index] = beforeOutcome.result;
          // Still fire the observer so the REPL sees the blocked call +
          // the guardrail-supplied result. Legacy task-engine treated a
          // guardrail-blocked tool as a real invocation from the user's
          // point of view (they see it happened and was rejected).
          opts.toolObserver?.onToolCall?.(call);
          opts.toolObserver?.onToolResult?.(call, beforeOutcome.result);
          return;
        }
        call = beforeOutcome.call;
        (finalCalls as RunnerToolCall[])[index] = call;
      }
      // v0.7.26 parity: fire `onToolCall` BEFORE the execute so the REPL
      // worker ledger can render the pending tool immediately (matches
      // legacy timing where events.onToolResult arrived at completion
      // but the tool name was surfaced live via the tool_use block
      // streaming).
      opts.toolObserver?.onToolCall?.(call);
      // v0.7.22 parity: plan-mode / accept-edits / extension "tool:before"
      // policies hook in here. beforeTool returns true (allow), false
      // (block with default message), or a string (block with that
      // message as the tool result seen by the LLM).
      if (opts.toolObserver?.beforeTool) {
        const verdict = await opts.toolObserver.beforeTool(call);
        if (verdict === false || typeof verdict === 'string') {
          const blockedMessage = typeof verdict === 'string'
            ? verdict
            : `Tool "${call.name}" was blocked by policy.`;
          const blockedResult: RunnerToolResult = {
            content: blockedMessage,
            isError: true,
          };
          opts.toolObserver.onToolResult?.(call, blockedResult);
          results[index] = blockedResult;
          return;
        }
      }
      let result = await executeRunnerToolCall(call, currentAgent, {
        agent: currentAgent,
        abortSignal: opts.abortSignal,
        agentSpan,
      });
      if (guardrailSlots.tool.length > 0) {
        // Per-invocation: pass the CURRENT agent (may differ from
        // startAgent after handoff). Same reasoning as the beforeTool
        // side above.
        result = await runToolAfterGuardrails(
          call,
          result,
          guardrailSlots.tool,
          { ...guardrailCtx, agent: currentAgent },
          agentSpan,
        );
      }
      // Fire `onToolResult` AFTER guardrails so consumers see the final
      // result shape the LLM will receive on the next turn.
      opts.toolObserver?.onToolResult?.(call, result);
      results[index] = result;
    };

    const parallelIndices: number[] = [];
    const serialIndices: number[] = [];
    for (let i = 0; i < toolCalls.length; i += 1) {
      if (toolCalls[i]!.name === 'bash') {
        serialIndices.push(i);
      } else {
        parallelIndices.push(i);
      }
    }
    if (parallelIndices.length > 0) {
      await Promise.all(parallelIndices.map((i) => executeOneCall(i)));
    }
    for (const i of serialIndices) {
      await executeOneCall(i);
    }
    const toolResultMessage = buildToolResultMessage(finalCalls, results);
    transcript.push(toolResultMessage);
    if (opts.session) {
      await appendMessageEntry(opts.session, toolResultMessage);
    }

    // v0.7.26 parity: compaction hook fires AFTER the tool_result message
    // is appended (so the hook sees the complete turn), before the next
    // LLM call. Legacy agent.ts:1737-1845 ran `intelligentCompact` on the
    // same boundary. When the hook returns a new transcript we replace
    // the live variable — subsequent iterations run on the compacted
    // history. Errors are swallowed (treated as "skip compaction") so a
    // hook bug can never abort the run.
    if (opts.compactionHook) {
      try {
        const compacted = await opts.compactionHook(transcript);
        if (compacted && compacted !== transcript) {
          transcript = [...compacted];
        }
      } catch (error) {
        // Compaction failure must never abort the run, but silent catch
        // loses too much signal — compaction is a known bug-surface area
        // (see CHANGELOG M3 post-compact reinjection). Surface the error
        // as a compaction span so operators notice the hook misbehaving.
        agentSpan?.addChild('compaction:hook-error', {
          kind: 'compaction',
          policyName: 'hook',
          tokensUsed: 0,
          budget: 0,
          replacedMessageCount: 0,
          summaryLength: 0,
          error: error instanceof Error ? error.message : String(error),
        }).end();
      }
    }

    // FEATURE_084 Shard 4: handoff detection. If any tool result carries a
    // handoffTarget metadata field that resolves to a declared handoff on
    // the current agent, transfer ownership. Only the first matching
    // handoff is executed per iteration; any subsequent emit in the same
    // batch is ignored (prevents non-determinism from multiple signals).
    const handoffSignal = detectHandoffSignal(currentAgent, finalCalls, results);
    if (handoffSignal) {
      emitHandoffSpan(
        agentSpan,
        handoffSignal.from,
        handoffSignal.to,
        handoffSignal.handoff.kind,
        handoffSignal.handoff.description,
      );
      currentAgent = handoffSignal.to;
      // M5 parity (v0.7.26) — apply the handoff's `inputFilter` to the
      // visible transcript (excluding the leading system message) before
      // swapping in the target's system prompt. The API contract declares
      // `inputFilter` on `Handoff`; without this call the filter was
      // silently ignored. Callers that leave inputFilter undefined get
      // the prior identity behaviour.
      const filter = handoffSignal.handoff.inputFilter;
      if (filter) {
        const leadingSystem = transcript.length > 0 && transcript[0]!.role === 'system'
          ? transcript[0]!
          : undefined;
        const body = leadingSystem ? transcript.slice(1) : transcript;
        const filtered = filter(body);
        transcript = leadingSystem
          ? [leadingSystem, ...filtered]
          : [...filtered];
      }
      transcript = replaceSystemMessage(transcript, currentAgent);
    }
  }

  throw new Error(
    `Runner.run: agent "${currentAgent.name}" exceeded MAX_TOOL_LOOP_ITERATIONS (${iterationCap}) — the LLM kept requesting tool calls without terminating. This likely indicates a prompt or tool design bug.`,
  );
}

/**
 * Minimal execution entry for an `Agent`.
 */
export class Runner {
  /**
   * Run an agent to completion. Resolves with the final output plus the
   * full transcript.
   *
   * FEATURE_083 (v0.7.24): emits an AgentSpan around every run and a
   * GenerationSpan around the underlying LLM call in the generic path.
   * Preset dispatchers receive a `PresetTracingContext` so they can attach
   * richer spans under the AgentSpan. Pass `opts.tracer = null` to skip
   * tracing entirely for performance-sensitive calls.
   */
  static async run<TData = unknown>(
    agent: Agent,
    input: string | readonly AgentMessage[],
    opts?: RunOptions,
  ): Promise<RunResult<TData>> {
    const tracer = opts?.tracer === null ? null : opts?.tracer ?? defaultTracer;

    if (!tracer) {
      // Tracing disabled — fall through to the no-span fast path.
      const preset = presetDispatchers.get(agent.name);
      if (preset) {
        return preset(agent, input, opts) as Promise<RunResult<TData>>;
      }
      return genericRun<TData>(agent, input, opts, null);
    }

    const ownsTrace = !opts?.trace;
    const trace = opts?.trace ?? tracer.startTrace({
      name: `run:${agent.name}`,
      rootSpanData: {
        kind: 'agent',
        agentName: agent.name,
        model: agent.model,
        provider: agent.provider,
        tools: agent.tools?.map((t) => (t as { name?: string }).name ?? 'anonymous'),
      },
    });
    const agentSpan = ownsTrace
      ? trace.rootSpan
      : trace.rootSpan.addChild(`agent:${agent.name}`, {
          kind: 'agent',
          agentName: agent.name,
          model: agent.model,
          provider: agent.provider,
          tools: agent.tools?.map((t) => (t as { name?: string }).name ?? 'anonymous'),
        });

    try {
      const preset = presetDispatchers.get(agent.name);
      let result: RunResult;
      if (preset) {
        result = await preset(agent, input, opts, { tracer, trace, agentSpan });
      } else {
        result = await genericRun<TData>(agent, input, opts, agentSpan);
      }
      return result as RunResult<TData>;
    } catch (err) {
      agentSpan.setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      if (!ownsTrace) {
        agentSpan.end();
      } else {
        trace.end();
      }
    }
  }

  /**
   * Streaming variant. v0.7.23 emits a single `complete` event after
   * delegating to `run`; richer intermediate events land with FEATURE_084.
   */
  static async *runStream<TData = unknown>(
    agent: Agent,
    input: string | readonly AgentMessage[],
    opts?: RunOptions,
  ): AsyncIterable<RunEvent<TData>> {
    try {
      const result = await Runner.run<TData>(agent, input, opts);
      for (const message of result.messages) {
        if (message.role === 'assistant') {
          yield { kind: 'message', message };
        }
      }
      yield { kind: 'complete', result };
    } catch (error) {
      yield {
        kind: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}

/** @internal Exposed so preset dispatchers can extract the assistant text from a KodaXResult. */
export function extractAssistantTextFromMessage(message: AgentMessage): string {
  return extractLastText(message);
}
