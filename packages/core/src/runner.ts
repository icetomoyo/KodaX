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

import type { Agent, AgentMessage } from './agent.js';
import type { Session } from './session.js';

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
   * message transcript and the current Agent; returns the assistant reply
   * as a single string.
   */
  readonly llm?: (
    messages: readonly AgentMessage[],
    agent: Agent,
  ) => Promise<string>;
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

async function genericRun<TData>(
  agent: Agent,
  input: string | readonly AgentMessage[],
  opts: RunOptions | undefined,
  agentSpan: Span | null,
): Promise<RunResult<TData>> {
  if (!opts?.llm) {
    const toolHint = agent.tools && agent.tools.length > 0
      ? ' NOTE: this agent declares tools; the generic path does not yet execute tools. '
        + 'For tool execution use a registered preset (e.g. createDefaultCodingAgent()) or wait for FEATURE_084.'
      : '';
    throw new Error(
      `Runner.run: agent "${agent.name}" has no registered preset dispatcher and no \`llm\` callback was provided. `
      + 'Either use a registered preset (e.g. createDefaultCodingAgent()) or pass opts.llm.'
      + toolHint,
    );
  }
  const instructions = resolveInstructions(agent);
  const userMessages = normalizeInput(input);
  const systemMessage: AgentMessage = { role: 'system', content: instructions };
  const transcript: AgentMessage[] = [systemMessage, ...userMessages];

  if (opts.session) {
    for (const message of userMessages) {
      await appendMessageEntry(opts.session, message);
    }
  }

  // Emit a GenerationSpan around the LLM callback. The callback itself is
  // opaque to the Runner (it could hit Anthropic, OpenAI, a local model, ...)
  // so we only record the agent/provider/model shape declared on the Agent.
  const genSpan = agentSpan
    ? agentSpan.addChild(`generation:${agent.name}`, {
        kind: 'generation',
        agentName: agent.name,
        provider: agent.provider ?? 'unknown',
        model: agent.model ?? 'unknown',
        inputMessages: transcript.length,
      })
    : null;
  let reply: string;
  try {
    reply = await opts.llm([...transcript], agent);
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

  const assistantMessage: AgentMessage = { role: 'assistant', content: reply };
  transcript.push(assistantMessage);

  if (opts.session) {
    await appendMessageEntry(opts.session, assistantMessage);
  }

  return {
    output: reply,
    messages: transcript,
    sessionId: opts.session?.id,
  };
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
