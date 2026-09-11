/**
 * Unit tests for Runner (FEATURE_080 v0.7.23).
 *
 * Covers:
 *   - Generic dispatch: single-turn LLM call through injected `opts.llm`.
 *   - Session integration on generic path: user + assistant appended as
 *     `message` entries.
 *   - Preset dispatch: registered dispatcher receives agent + input + opts
 *     and its return value is returned verbatim.
 *   - Error surface: missing `llm` for generic agent yields a clear error.
 *   - `runStream` emits message + complete events in order.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgent, type Agent, type AgentMessage, type Guardrail } from './agent.js';
import type { InputGuardrail, ToolGuardrail } from './guardrail.js';
import { createInMemorySession } from './session.js';
import {
  isRunnerIterationLimitError,
  readRunnerRecoveryTranscript,
  Runner,
  _resetPresetDispatchers,
  registerPresetDispatcher,
  type PresetDispatcher,
} from './runner.js';
import {
  MAX_RUN_CONTINUATION_ITERATIONS,
  MAX_TOOL_LOOP_ITERATIONS,
  type RunnableTool,
  type RunnerLlmResult,
} from './runner-tool-loop.js';

describe('Runner', () => {
  afterEach(() => {
    _resetPresetDispatchers();
  });

  describe('generic dispatch', () => {
    const helloAgent: Agent = createAgent({
      name: 'test-hello',
      instructions: 'Be helpful and concise.',
    });

    it('calls the injected llm with system + user messages and returns output', async () => {
      type LlmFn = NonNullable<Parameters<typeof Runner.run>[2]>['llm'];
      const llm = vi.fn<NonNullable<LlmFn>>(async () => 'hello, world');
      const result = await Runner.run(helloAgent, 'say hi', { llm });
      expect(result.output).toBe('hello, world');
      expect(result.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
      expect(result.messages[0]!.content).toBe('Be helpful and concise.');
      expect(result.messages[1]!.content).toBe('say hi');
      expect(result.messages[2]!.content).toBe('hello, world');
      expect(llm).toHaveBeenCalledTimes(1);
      const call = llm.mock.calls[0]!;
      expect(call[0]).toHaveLength(2);
      expect(call[1]).toBe(helloAgent);
    });

    it('accepts a pre-built message array as input', async () => {
      const llm = vi.fn(async () => 'ok');
      const result = await Runner.run(helloAgent, [{ role: 'user', content: 'q1' }], { llm });
      expect(result.messages.map((m) => m.content)).toEqual([
        'Be helpful and concise.',
        'q1',
        'ok',
      ]);
    });

    it('supports instructions as a function', async () => {
      const fnAgent: Agent = createAgent({
        name: 'fn-agent',
        instructions: () => 'Dynamic instructions',
      });
      const llm = vi.fn(async () => 'reply');
      const result = await Runner.run(fnAgent, 'x', { llm });
      expect(result.messages[0]!.content).toBe('Dynamic instructions');
    });

    it('appends user + assistant to the provided Session', async () => {
      const session = createInMemorySession();
      const llm = vi.fn(async () => 'done');
      const result = await Runner.run(helloAgent, 'q', { llm, session });
      expect(result.sessionId).toBe(session.id);
      const collected: Array<{ role: string; content: unknown }> = [];
      for await (const entry of session.entries()) {
        if (entry.type === 'message') {
          const payload = entry.payload as { role: string; content: unknown };
          collected.push({ role: payload.role, content: payload.content });
        }
      }
      expect(collected).toEqual([
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'done' },
      ]);
    });

    it('fires onMessageCommitted only after the message is durable', async () => {
      const session = createInMemorySession();
      const observed: Array<{ role: string; persisted: boolean }> = [];
      const llm = vi.fn()
        .mockResolvedValueOnce({
          text: '',
          toolCalls: [{ id: 'call-1', name: 'echo', input: {} }],
        })
        .mockResolvedValueOnce('done');
      const agent = createAgent({
        name: 'commit-order',
        instructions: 'test',
        tools: [{
          name: 'echo',
          description: 'echo',
          input_schema: { type: 'object', properties: {} },
          execute: async () => ({ content: 'tool output' }),
        }],
      });

      await Runner.run(agent, 'q', {
        llm,
        session,
        onMessageCommitted: async (message) => {
          const persisted = [];
          for await (const entry of session.entries()) persisted.push(entry);
          observed.push({
            role: message.role,
            persisted: persisted.some((entry) => (
              entry.type === 'message'
              && (entry.payload as { content?: unknown }).content === message.content
            )),
          });
        },
      });

      expect(observed).toHaveLength(4);
      expect(observed.every((entry) => entry.persisted)).toBe(true);
    });

    it('does not fire onMessageCommitted when persistence fails', async () => {
      const base = createInMemorySession();
      const committed: AgentMessage[] = [];
      const session = {
        ...base,
        append: vi.fn(async () => {
          throw new Error('storage unavailable');
        }),
      };

      await expect(Runner.run(helloAgent, 'q', {
        llm: vi.fn(async () => 'done'),
        session,
        onMessageCommitted: (message) => {
          committed.push(message);
        },
      })).rejects.toThrow('storage unavailable');
      expect(committed).toEqual([]);
    });

    it('throws a clear error when neither llm nor preset is available', async () => {
      await expect(Runner.run(helloAgent, 'hi'))
        .rejects.toThrow(/no registered preset dispatcher/);
    });
  });

  describe('preset dispatch', () => {
    it('routes to the registered dispatcher when agent.name matches', async () => {
      const dispatcher: PresetDispatcher = vi.fn(async () => ({
        output: 'preset output',
        messages: [{ role: 'assistant' as const, content: 'preset output' }],
        sessionId: 'preset-session-1',
      }));
      registerPresetDispatcher('preset-agent', dispatcher);
      const agent: Agent = createAgent({
        name: 'preset-agent',
        instructions: 'ignored',
      });

      // Pass `tracer: null` so the Runner skips the tracing context and
      // invokes the dispatcher with the 3-arg backward-compatible shape.
      // Tracing-aware dispatch behavior is covered in the tracing tests.
      const result = await Runner.run(agent, 'hi', {
        presetOptions: { flag: true },
        tracer: null,
      });
      expect(result.output).toBe('preset output');
      expect(result.sessionId).toBe('preset-session-1');
      expect(dispatcher).toHaveBeenCalledTimes(1);
      expect(dispatcher).toHaveBeenCalledWith(
        agent,
        'hi',
        { presetOptions: { flag: true }, tracer: null },
      );
    });

    it('unregister function stops the dispatcher from matching', async () => {
      const dispatcher: PresetDispatcher = vi.fn(async () => ({
        output: 'x',
        messages: [],
      }));
      const unregister = registerPresetDispatcher('tmp-agent', dispatcher);
      unregister();
      const agent: Agent = createAgent({ name: 'tmp-agent', instructions: 'i' });
      await expect(Runner.run(agent, 'hi'))
        .rejects.toThrow(/no registered preset dispatcher/);
      expect(dispatcher).not.toHaveBeenCalled();
    });
  });

  describe('tracing integration (FEATURE_083)', () => {
    it('emits an AgentSpan + GenerationSpan around the generic path', async () => {
      const { Tracer, addTracingProcessor, setTracingProcessors } = await import('../tracing/index.js');
      setTracingProcessors([]);
      const startedSpans: string[] = [];
      const endedSpans: string[] = [];
      addTracingProcessor({
        onSpanStart: (span) => startedSpans.push(`${span.name}:${span.data.kind}`),
        onSpanEnd: (span) => endedSpans.push(`${span.name}:${span.data.kind}`),
        onTraceEnd: () => { /* noop */ },
      });

      const agent = createAgent({
        name: 'traced-agent',
        instructions: 'sys',
        provider: 'mock-provider',
        model: 'mock-model',
      });
      const tracer = new Tracer();

      await Runner.run(agent, 'hi', {
        llm: async () => 'reply',
        tracer,
      });

      setTracingProcessors([]);

      // Root AgentSpan, nested GenerationSpan under it.
      expect(startedSpans).toContain('run:traced-agent:agent');
      expect(startedSpans).toContain('generation:traced-agent:generation');
      expect(endedSpans).toContain('generation:traced-agent:generation');
      expect(endedSpans).toContain('run:traced-agent:agent');
    });

    it('passes a PresetTracingContext to preset dispatchers when tracer is active', async () => {
      const { Tracer } = await import('../tracing/index.js');
      let receivedTracingContext: unknown;
      const dispatcher: PresetDispatcher = vi.fn(async (_a, _i, _opts, ctx) => {
        receivedTracingContext = ctx;
        return {
          output: 'preset',
          messages: [{ role: 'assistant' as const, content: 'preset' }],
        };
      });
      registerPresetDispatcher('traced-preset', dispatcher);
      const agent = createAgent({ name: 'traced-preset', instructions: 'sys' });

      await Runner.run(agent, 'hi', { tracer: new Tracer() });

      expect(receivedTracingContext).toBeDefined();
      expect((receivedTracingContext as { agentSpan: unknown }).agentSpan).toBeDefined();
    });
  });

  describe('tool loop (FEATURE_084 Shard 1)', () => {
    function makeEchoTool(): RunnableTool {
      return {
        name: 'echo',
        description: 'Echo the provided text back to the caller',
        input_schema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        execute: async (input) => ({
          content: `echoed:${(input as { text?: string }).text ?? ''}`,
        }),
      };
    }

    it('backward-compat: llm returning a plain string yields one assistant turn', async () => {
      const agent = createAgent({ name: 'str-reply', instructions: 'sys' });
      const llm = vi.fn(async () => 'hello, world');
      const result = await Runner.run(agent, 'hi', { llm });
      expect(result.output).toBe('hello, world');
      expect(result.messages).toHaveLength(3);
      expect(llm).toHaveBeenCalledTimes(1);
    });

    it('llm returning RunnerLlmResult without toolCalls behaves like single-turn', async () => {
      const agent = createAgent({ name: 'result-reply', instructions: 'sys' });
      const llm = vi.fn(async (): Promise<RunnerLlmResult> => ({ text: 'done', toolCalls: [] }));
      const result = await Runner.run(agent, 'hi', { llm });
      expect(result.output).toBe('done');
      expect(result.messages).toHaveLength(3);
      expect(llm).toHaveBeenCalledTimes(1);
    });

    it('executes RunnableTool and loops until LLM stops emitting toolCalls', async () => {
      const echoTool = makeEchoTool();
      const agent = createAgent({
        name: 'loop-agent',
        instructions: 'sys',
        tools: [echoTool],
      });
      let turn = 0;
      const llm = vi.fn(async (messages): Promise<RunnerLlmResult> => {
        turn += 1;
        if (turn === 1) {
          return {
            text: 'Calling echo...',
            toolCalls: [{ id: 'call-1', name: 'echo', input: { text: 'ping' } }],
          };
        }
        // second turn — LLM has seen the tool_result block
        const last = messages[messages.length - 1]!;
        expect(Array.isArray(last.content)).toBe(true);
        expect((last.content as Array<{ type: string }>)[0]!.type).toBe('tool_result');
        return { text: 'final answer', toolCalls: [] };
      });
      const result = await Runner.run(agent, 'hi', { llm });
      expect(result.output).toBe('final answer');
      expect(llm).toHaveBeenCalledTimes(2);
      // Transcript: system, user, assistant(tool_use), user(tool_result), assistant(final)
      expect(result.messages).toHaveLength(5);
      expect(result.messages[2]!.role).toBe('assistant');
      const assistantBlocks = result.messages[2]!.content as Array<{ type: string }>;
      expect(assistantBlocks.some((b) => b.type === 'tool_use')).toBe(true);
      expect(result.messages[3]!.role).toBe('user');
      expect(result.messages[3]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      const toolResultBlocks = result.messages[3]!.content as Array<{ type: string }>;
      expect(toolResultBlocks[0]!.type).toBe('tool_result');
    });

    it('commits adapter-injected input before the assistant so the next request preserves the prefix', async () => {
      const agent = createAgent({
        name: 'injected-input-agent',
        instructions: 'sys',
        tools: [makeEchoTool()],
      });
      const reminder: AgentMessage = {
        role: 'user',
        content: 'runtime reminder',
        _synthetic: true,
        _source: 'managed-runtime-reminder',
      };
      let turn = 0;
      const llm = vi.fn(async (messages): Promise<RunnerLlmResult> => {
        turn += 1;
        if (turn === 1) {
          return {
            text: 'Calling echo...',
            injectedInputMessages: [reminder],
            toolCalls: [{ id: 'call-1', name: 'echo', input: { text: 'ping' } }],
          };
        }
        expect(messages[2]).toEqual(reminder);
        expect(messages[3]?.role).toBe('assistant');
        expect(messages[4]?.role).toBe('user');
        return { text: 'done', toolCalls: [] };
      });

      const result = await Runner.run(agent, 'hi', { llm });

      expect(result.messages[2]).toEqual(reminder);
      expect(result.messages[3]?.role).toBe('assistant');
      expect(result.messages[4]?.role).toBe('user');
      expect(result.messages[5]?.content).toEqual([
        { type: 'text', text: 'done' },
      ]);
    });

    it('transforms the settled tool-result batch once before building the result message', async () => {
      const first: RunnableTool = {
        name: 'first',
        description: 'first result',
        input_schema: { type: 'object', properties: {} },
        execute: async () => ({ content: 'raw-first', metadata: { handoffTarget: 'next' } }),
      };
      const second: RunnableTool = {
        name: 'bash',
        description: 'multimodal result',
        input_schema: { type: 'object', properties: {} },
        execute: async () => ({
          content: [
            { type: 'text', text: 'visual evidence' },
            { type: 'image', path: 'C:/tmp/evidence.png' },
          ],
          metadata: { source: 'image-reader' },
        }),
      };
      const agent = createAgent({
        name: 'batch-transform-agent',
        instructions: 'sys',
        tools: [first, second],
      });
      let turn = 0;
      const llm = async (messages: readonly { content: unknown }[]): Promise<RunnerLlmResult> => {
        turn += 1;
        if (turn === 1) {
          return {
            text: '',
            toolCalls: [
              { id: 'first-call', name: 'first', input: {} },
              { id: 'second-call', name: 'bash', input: {} },
            ],
          };
        }
        const blocks = messages.at(-1)!.content as Array<{
          content: unknown;
          metadata?: Record<string, unknown>;
        }>;
        expect(blocks[0]!.content).toBe('batch:first');
        expect(blocks[0]!.metadata).toEqual({ handoffTarget: 'next' });
        expect(blocks[1]!.content).toEqual([
          { type: 'text', text: 'visual evidence' },
          { type: 'image', path: 'C:/tmp/evidence.png' },
        ]);
        expect(blocks[1]!.metadata).toEqual({ source: 'image-reader' });
        return { text: 'done', toolCalls: [] };
      };
      const transform = vi.fn(async ({ calls, results, transcript }) => {
        expect(calls.map((call) => call.id)).toEqual(['first-call', 'second-call']);
        expect(results.map((result) => result.content)).toHaveLength(2);
        expect(transcript.at(-1)?.role).toBe('assistant');
        return [
          { ...results[0]!, content: 'batch:first' },
          results[1]!,
        ];
      });

      const result = await Runner.run(agent, 'q', {
        llm,
        toolResultBatchTransform: transform,
      });

      expect(result.output).toBe('done');
      expect(transform).toHaveBeenCalledTimes(1);
      const transformedResults = await transform.mock.results[0]!.value;
      expect(transformedResults[0]!.metadata).toEqual({ handoffTarget: 'next' });
      expect(transformedResults[1]!.metadata).toEqual({ source: 'image-reader' });
    });

    it('rejects a batch transform that breaks tool-call/result pairing', async () => {
      const agent = createAgent({
        name: 'invalid-batch-transform-agent',
        instructions: 'sys',
        tools: [makeEchoTool()],
      });
      const llm = async (): Promise<RunnerLlmResult> => ({
        text: '',
        toolCalls: [{ id: 'call-1', name: 'echo', input: { text: 'x' } }],
      });

      await expect(Runner.run(agent, 'q', {
        llm,
        toolResultBatchTransform: async () => [],
      })).rejects.toThrow(/must preserve one result per tool call/i);
    });

    it('delivers post-transform results to the observer', async () => {
      const agent = createAgent({
        name: 'observed-batch-transform-agent',
        instructions: 'sys',
        tools: [makeEchoTool()],
      });
      let turn = 0;
      let observedContent: unknown;
      await Runner.run(agent, 'q', {
        llm: async (): Promise<RunnerLlmResult> => {
          turn += 1;
          return turn === 1
            ? { text: '', toolCalls: [{ id: 'call-1', name: 'echo', input: { text: 'raw' } }] }
            : { text: 'done', toolCalls: [] };
        },
        toolResultBatchTransform: async ({ results }) => [
          { ...results[0]!, content: 'admitted-result' },
        ],
        toolObserver: {
          onToolResult: (_call, result) => { observedContent = result.content; },
        },
      });

      expect(observedContent).toBe('admitted-result');
    });

    it('attaches the last legal transcript when a batch transform fails', async () => {
      const agent = createAgent({
        name: 'batch-transform-recovery-agent',
        instructions: 'sys',
        tools: [makeEchoTool()],
      });
      const capacityError = new Error('batch cannot fit');
      capacityError.name = 'ToolResultBatchCapacityError';
      let caught: unknown;

      try {
        await Runner.run(agent, 'q', {
          llm: async (): Promise<RunnerLlmResult> => ({
            text: '',
            toolCalls: [{ id: 'call-1', name: 'echo', input: { text: 'raw' } }],
          }),
          toolResultBatchTransform: async () => { throw capacityError; },
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(capacityError);
      expect(readRunnerRecoveryTranscript(caught)).toEqual([
        { role: 'user', content: 'q' },
      ]);
    });

    it('returns tool error content to the LLM when tool is unknown', async () => {
      const agent = createAgent({ name: 'missing-tool', instructions: 'sys' });
      let turn = 0;
      const llm = vi.fn(async (messages): Promise<RunnerLlmResult> => {
        turn += 1;
        if (turn === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'c1', name: 'nonexistent', input: {} }],
          };
        }
        const last = messages[messages.length - 1]!;
        const blocks = last.content as Array<{ type: string; content: string; is_error?: boolean }>;
        expect(blocks[0]!.is_error).toBe(true);
        expect(blocks[0]!.content).toMatch(/not declared/);
        return { text: 'recovered', toolCalls: [] };
      });
      const result = await Runner.run(agent, 'hi', { llm });
      expect(result.output).toBe('recovered');
    });

    it('surfaces is_error when a RunnableTool throws', async () => {
      const brokenTool: RunnableTool = {
        name: 'broken',
        description: 'Always throws',
        input_schema: { type: 'object', properties: {} },
        execute: async () => {
          throw new Error('kaboom');
        },
      };
      const agent = createAgent({
        name: 'broken-agent',
        instructions: 'sys',
        tools: [brokenTool],
      });
      let turn = 0;
      const llm = vi.fn(async (messages): Promise<RunnerLlmResult> => {
        turn += 1;
        if (turn === 1) {
          return { text: '', toolCalls: [{ id: 'c1', name: 'broken', input: {} }] };
        }
        const last = messages[messages.length - 1]!;
        const blocks = last.content as Array<{ type: string; content: string; is_error?: boolean }>;
        expect(blocks[0]!.is_error).toBe(true);
        expect(blocks[0]!.content).toMatch(/kaboom/);
        return { text: 'recovered', toolCalls: [] };
      });
      const result = await Runner.run(agent, 'hi', { llm });
      expect(result.output).toBe('recovered');
    });

    it('surfaces is_error when a declared tool has no executor', async () => {
      const defOnly = {
        name: 'def-only',
        description: 'definition without executor',
        input_schema: { type: 'object' as const, properties: {} },
      };
      const agent = createAgent({
        name: 'no-exec',
        instructions: 'sys',
        tools: [defOnly],
      });
      let turn = 0;
      const llm = vi.fn(async (messages): Promise<RunnerLlmResult> => {
        turn += 1;
        if (turn === 1) {
          return { text: '', toolCalls: [{ id: 'c1', name: 'def-only', input: {} }] };
        }
        const last = messages[messages.length - 1]!;
        const blocks = last.content as Array<{ type: string; content: string; is_error?: boolean }>;
        expect(blocks[0]!.is_error).toBe(true);
        expect(blocks[0]!.content).toMatch(/no executor/);
        return { text: 'recovered', toolCalls: [] };
      });
      const result = await Runner.run(agent, 'hi', { llm });
      expect(result.output).toBe('recovered');
    });

    it('aborts with a clear error after MAX_TOOL_LOOP_ITERATIONS', async () => {
      const echoTool = makeEchoTool();
      const agent = createAgent({
        name: 'runaway',
        instructions: 'sys',
        tools: [echoTool],
      });
      // Always return a tool call — should hit the ceiling and throw.
      const llm = vi.fn(async (): Promise<RunnerLlmResult> => ({
        text: '',
        toolCalls: [{ id: `c-${Math.random()}`, name: 'echo', input: { text: 'x' } }],
      }));
      let caught: unknown;
      try {
        await Runner.run(agent, 'hi', { llm });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(isRunnerIterationLimitError(caught)).toBe(true);
      expect(caught).toMatchObject({
        code: 'RUNNER_ITERATION_LIMIT',
        limitReached: true,
      });
      expect((caught as Error).message).toMatch(/MAX_TOOL_LOOP_ITERATIONS/);
      const recoveryTranscript = readRunnerRecoveryTranscript(caught);
      expect(recoveryTranscript?.length).toBeGreaterThan(1);
      expect(recoveryTranscript?.[0]?.role).toBe('user');
      expect(isRunnerIterationLimitError({
        code: 'RUNNER_ITERATION_LIMIT',
      })).toBe(false);
      expect(llm).toHaveBeenCalledTimes(MAX_TOOL_LOOP_ITERATIONS);
    });

    it('emits a ToolCallSpan under the AgentSpan for each tool execution', async () => {
      const { Tracer, addTracingProcessor, setTracingProcessors } = await import('../tracing/index.js');
      setTracingProcessors([]);
      const endedSpans: Array<{ name: string; kind: string; error: boolean }> = [];
      addTracingProcessor({
        onSpanStart: () => { /* noop */ },
        onSpanEnd: (span) => {
          endedSpans.push({
            name: span.name,
            kind: span.data.kind,
            error: Boolean(span.error),
          });
        },
        onTraceEnd: () => { /* noop */ },
      });

      const echoTool = makeEchoTool();
      const agent = createAgent({
        name: 'traced-tool',
        instructions: 'sys',
        tools: [echoTool],
        provider: 'mock',
        model: 'mock',
      });
      let turn = 0;
      const llm = async (): Promise<RunnerLlmResult> => {
        turn += 1;
        if (turn === 1) {
          return { text: '', toolCalls: [{ id: 'c1', name: 'echo', input: { text: 'hi' } }] };
        }
        return { text: 'done', toolCalls: [] };
      };

      await Runner.run(agent, 'hi', { llm, tracer: new Tracer() });
      setTracingProcessors([]);

      const toolCallSpan = endedSpans.find((s) => s.kind === 'tool_call');
      expect(toolCallSpan).toBeDefined();
      expect(toolCallSpan!.name).toBe('tool_call:echo');
      expect(toolCallSpan!.error).toBe(false);
      // Also ensure the two generation turns emitted spans.
      const genSpans = endedSpans.filter((s) => s.kind === 'generation');
      expect(genSpans).toHaveLength(2);
    });

    it('marks ToolCallSpan with error=true when the tool throws', async () => {
      const { Tracer, addTracingProcessor, setTracingProcessors } = await import('../tracing/index.js');
      setTracingProcessors([]);
      const endedSpans: Array<{ kind: string; error: boolean }> = [];
      addTracingProcessor({
        onSpanStart: () => { /* noop */ },
        onSpanEnd: (span) => {
          endedSpans.push({ kind: span.data.kind, error: Boolean(span.error) });
        },
        onTraceEnd: () => { /* noop */ },
      });

      const brokenTool: RunnableTool = {
        name: 'broken',
        description: 'Always throws',
        input_schema: { type: 'object', properties: {} },
        execute: async () => { throw new Error('boom'); },
      };
      const agent = createAgent({
        name: 'broken-traced',
        instructions: 'sys',
        tools: [brokenTool],
      });
      let turn = 0;
      const llm = async (): Promise<RunnerLlmResult> => {
        turn += 1;
        if (turn === 1) return { text: '', toolCalls: [{ id: 'c1', name: 'broken', input: {} }] };
        return { text: 'done', toolCalls: [] };
      };

      await Runner.run(agent, 'hi', { llm, tracer: new Tracer() });
      setTracingProcessors([]);

      const toolCallSpan = endedSpans.find((s) => s.kind === 'tool_call');
      expect(toolCallSpan).toBeDefined();
      expect(toolCallSpan!.error).toBe(true);
    });

    it('persists tool_use and tool_result messages to the Session', async () => {
      const echoTool = makeEchoTool();
      const agent = createAgent({
        name: 'session-loop',
        instructions: 'sys',
        tools: [echoTool],
      });
      const session = createInMemorySession();
      let turn = 0;
      const llm = async (): Promise<RunnerLlmResult> => {
        turn += 1;
        if (turn === 1) return { text: '', toolCalls: [{ id: 'c1', name: 'echo', input: { text: 'x' } }] };
        return { text: 'done', toolCalls: [] };
      };
      await Runner.run(agent, 'q', { llm, session });

      const roles: string[] = [];
      for await (const entry of session.entries()) {
        if (entry.type === 'message') {
          roles.push((entry.payload as { role: string }).role);
        }
      }
      // Expected order: user(q), assistant(tool_use), user(tool_result), assistant(final)
      expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
    });
  });

  describe('toolObserver (v0.7.26 parity)', () => {
    function makeLocalEchoTool(): RunnableTool {
      return {
        name: 'echo',
        description: 'echo',
        input_schema: { type: 'object', properties: { text: { type: 'string' } } },
        execute: async (input) => ({
          content: `echo:${(input as { text?: string }).text ?? ''}`,
        }),
      };
    }

    it('does not start a tool after caller cancellation is observed by beforeTool', async () => {
      const controller = new AbortController();
      const execute = vi.fn(async () => ({ content: 'must not execute' }));
      const executionStart = vi.fn();
      const executionEnd = vi.fn();
      const agent = createAgent({
        name: 'cancelled-before-tool-agent',
        instructions: 'sys',
        tools: [{
          name: 'bash',
          description: 'test tool',
          input_schema: { type: 'object', properties: {} },
          execute,
        }],
      });

      const run = Runner.run(agent, 'q', {
        abortSignal: controller.signal,
        llm: async () => ({
          text: '',
          toolCalls: [{ id: 'cancelled-call', name: 'bash', input: {} }],
        }),
        toolObserver: {
          beforeTool: async () => {
            controller.abort();
            return true;
          },
          onToolExecutionStart: executionStart,
          onToolExecutionEnd: executionEnd,
        },
      });

      await expect(run).rejects.toMatchObject({ name: 'AbortError' });
      expect(execute).not.toHaveBeenCalled();
      expect(executionStart).not.toHaveBeenCalled();
      expect(executionEnd).not.toHaveBeenCalled();
    });

    it.each(['This operation was aborted', 'host requested stop'])(
      'preserves cancellation during a rejected generation with reason %s',
      async (reason) => {
        const controller = new AbortController();
        const llm = vi.fn(async () => {
          controller.abort(new Error(reason));
          throw new DOMException('This operation was aborted', 'AbortError');
        });
        await expect(Runner.run(createAgent({ name: 'cancel-probe', instructions: 'test' }), 'hello', {
          llm, abortSignal: controller.signal, tracer: null,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(llm).toHaveBeenCalledTimes(1);
      },
    );

    it('preserves an independent generation failure racing with caller cancellation', async () => {
      const controller = new AbortController();
      const failure = new Error('independent generation failure');
      await expect(Runner.run(createAgent({ name: 'failure-probe', instructions: 'test' }), 'hello', {
        tracer: null, abortSignal: controller.signal,
        llm: async () => {
          controller.abort(new Error('host requested stop'));
          throw failure;
        },
      })).rejects.toBe(failure);
    });

    it('fires onToolCall + onToolResult around each invocation', async () => {
      const echoTool = makeLocalEchoTool();
      const agent = createAgent({ name: 'obs-agent', instructions: 'sys', tools: [echoTool] });
      let turn = 0;
      const llm = vi.fn(async (): Promise<RunnerLlmResult> => {
        turn += 1;
        if (turn === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'c1', name: 'echo', input: { text: 'ping' } }],
          };
        }
        return { text: 'done', toolCalls: [] };
      });
      const calls: Array<{ kind: 'call' | 'start' | 'end' | 'result'; id: string; name: string; content?: string }> = [];
      await Runner.run(agent, 'hi', {
        llm,
        toolObserver: {
          onToolCall: (call) => {
            calls.push({ kind: 'call', id: call.id, name: call.name });
          },
          onToolResult: (call, result) => {
            calls.push({ kind: 'result', id: call.id, name: call.name, content: result.content });
          },
          onToolExecutionStart: (call) => calls.push({ kind: 'start', id: call.id, name: call.name }),
          onToolExecutionEnd: (call) => calls.push({ kind: 'end', id: call.id, name: call.name }),
        },
      });
      expect(calls).toEqual([
        { kind: 'call', id: 'c1', name: 'echo' },
        { kind: 'start', id: 'c1', name: 'echo' },
        { kind: 'end', id: 'c1', name: 'echo' },
        { kind: 'result', id: 'c1', name: 'echo', content: 'echo:ping' },
      ]);
    });

    it('fires observer even when guardrail blocks a call', async () => {
      const echoTool = makeLocalEchoTool();
      const blockingGuardrail: ToolGuardrail = {
        kind: 'tool',
        name: 'block-echo',
        beforeTool: async () => ({
          action: 'block',
          reason: 'blocked by policy',
        }),
      };
      const agent = createAgent({
        name: 'obs-block-agent',
        instructions: 'sys',
        tools: [echoTool],
        guardrails: [blockingGuardrail as Guardrail],
      });
      let turn = 0;
      const llm = vi.fn(async (): Promise<RunnerLlmResult> => {
        turn += 1;
        if (turn === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'c1', name: 'echo', input: { text: 'x' } }],
          };
        }
        return { text: 'done', toolCalls: [] };
      });
      const events: Array<{ kind: string; content?: string }> = [];
      await Runner.run(agent, 'hi', {
        llm,
        toolObserver: {
          onToolCall: () => events.push({ kind: 'call' }),
          onToolResult: (_call, result) => events.push({ kind: 'result', content: result.content }),
        },
      });
      // Both fire even on block so the UI can render the rejection.
      expect(events.map((e) => e.kind)).toEqual(['call', 'result']);
      expect(events[1]!.content).toMatch(/blocked by policy/i);
    });

    it('forwards runtime-authenticated permission intent to tool guardrails', async () => {
      const echoTool = makeLocalEchoTool();
      let observedRootIntent: string | undefined;
      const guardrail: ToolGuardrail = {
        kind: 'tool',
        name: 'observe-intent',
        beforeTool: async (_call, context) => {
          observedRootIntent = context.permissionIntent?.rootUserIntent;
          return { action: 'allow' };
        },
      };
      const agent = createAgent({
        name: 'intent-agent',
        instructions: 'sys',
        tools: [echoTool],
        guardrails: [guardrail as Guardrail],
      });
      let turn = 0;
      await Runner.run(agent, 'generated child briefing', {
        llm: async (): Promise<RunnerLlmResult> => {
          turn += 1;
          return turn === 1
            ? { text: '', toolCalls: [{ id: 'c1', name: 'echo', input: { text: 'x' } }] }
            : { text: 'done', toolCalls: [] };
        },
        permissionIntent: { rootUserIntent: 'Review the current changes.' },
      });

      expect(observedRootIntent).toBe('Review the current changes.');
    });

    it('skips tool execution when observer.beforeTool returns false (default-blocked message)', async () => {
      const echoTool = makeLocalEchoTool();
      let executeCalled = 0;
      const countingTool: RunnableTool = {
        ...echoTool,
        execute: async (input) => {
          executeCalled += 1;
          return { content: `echo:${(input as { text?: string }).text ?? ''}` };
        },
      };
      const agent = createAgent({ name: 'obs-false-agent', instructions: 'sys', tools: [countingTool] });
      let turn = 0;
      const llm = vi.fn(async (): Promise<RunnerLlmResult> => {
        turn += 1;
        if (turn === 1) {
          return { text: '', toolCalls: [{ id: 'c1', name: 'echo', input: { text: 'x' } }] };
        }
        return { text: 'done', toolCalls: [] };
      });
      let observedResultContent: string | undefined;
      await Runner.run(agent, 'hi', {
        llm,
        toolObserver: {
          beforeTool: async () => false,
          onToolResult: (_call, result) => { observedResultContent = result.content; },
        },
      });
      expect(executeCalled).toBe(0);
      expect(observedResultContent).toMatch(/blocked by policy/i);
    });

    it('uses observer.beforeTool string return as the blocked tool result', async () => {
      const echoTool = makeLocalEchoTool();
      let executeCalled = 0;
      const countingTool: RunnableTool = {
        ...echoTool,
        execute: async () => { executeCalled += 1; return { content: 'never' }; },
      };
      const agent = createAgent({ name: 'obs-str-agent', instructions: 'sys', tools: [countingTool] });
      let turn = 0;
      const llm = vi.fn(async (): Promise<RunnerLlmResult> => {
        turn += 1;
        if (turn === 1) {
          return { text: '', toolCalls: [{ id: 'c1', name: 'echo', input: { text: 'x' } }] };
        }
        return { text: 'done', toolCalls: [] };
      });
      let observedResultContent: string | undefined;
      await Runner.run(agent, 'hi', {
        llm,
        toolObserver: {
          beforeTool: async () => 'custom blocker reason',
          onToolResult: (_call, result) => { observedResultContent = result.content; },
        },
      });
      expect(executeCalled).toBe(0);
      expect(observedResultContent).toBe('custom blocker reason');
    });
  });

  describe('input guardrail / session parity (HIGH-1)', () => {
    it('records the post-guardrail user message in the session, not the raw input', async () => {
      // Input guardrail rewrites "raw" → "REWRITTEN". Parity with the
      // output side: session must capture what the LLM actually saw, not
      // the original user input.
      const rewritingGuardrail: InputGuardrail = {
        kind: 'input',
        name: 'rewriter',
        check: async (transcript) => ({
          action: 'rewrite',
          payload: transcript.map((m) =>
            m.role === 'user' ? { ...m, content: 'REWRITTEN' } : m,
          ),
        }),
      };
      const agent = createAgent({
        name: 'hi-guard',
        instructions: 'sys',
        guardrails: [rewritingGuardrail as Guardrail],
      });
      const session = createInMemorySession();
      await Runner.run(agent, 'raw', { llm: async () => 'ok', session });
      const captured: Array<{ role: string; content: unknown }> = [];
      for await (const entry of session.entries()) {
        if (entry.type === 'message') {
          const p = entry.payload as { role: string; content: unknown };
          captured.push({ role: p.role, content: p.content });
        }
      }
      expect(captured).toEqual([
        { role: 'user', content: 'REWRITTEN' },
        { role: 'assistant', content: 'ok' },
      ]);
    });
  });

  describe('beforeNextTurn hook (FEATURE_164)', () => {
    function makeEchoTool(): RunnableTool {
      return {
        name: 'echo',
        description: 'Echo the provided text back to the caller',
        input_schema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        execute: async (input) => ({
          content: `echoed:${(input as { text?: string }).text ?? ''}`,
        }),
      };
    }

    it('does nothing when hook is omitted (back-compat default)', async () => {
      const echoTool = makeEchoTool();
      const agent = createAgent({
        name: 'no-hook-agent',
        instructions: 'sys',
        tools: [echoTool],
      });
      let turn = 0;
      const llm = vi.fn(async (): Promise<RunnerLlmResult> => {
        turn += 1;
        if (turn === 1) {
          return { text: '', toolCalls: [{ id: 'c1', name: 'echo', input: { text: 'x' } }] };
        }
        return { text: 'done', toolCalls: [] };
      });
      const result = await Runner.run(agent, 'hi', { llm });
      expect(result.output).toBe('done');
      // 5 messages: system, user, assistant(tool_use), user(tool_result), assistant(final)
      expect(result.messages).toHaveLength(5);
    });

    it('injects returned messages into transcript before the next LLM call', async () => {
      const echoTool = makeEchoTool();
      const agent = createAgent({
        name: 'inject-agent',
        instructions: 'sys',
        tools: [echoTool],
      });
      let turn = 0;
      let secondCallSawInjection = false;
      const llm = vi.fn(async (messages): Promise<RunnerLlmResult> => {
        turn += 1;
        if (turn === 1) {
          return { text: '', toolCalls: [{ id: 'c1', name: 'echo', input: { text: 'x' } }] };
        }
        // Second call: transcript should include the injected user message
        // between the tool_result and this generation point.
        const last = messages[messages.length - 1]!;
        secondCallSawInjection = last.role === 'user' && last.content === 'injected by hook';
        return { text: 'done', toolCalls: [] };
      });
      const beforeNextTurn = vi.fn(async () => [
        { role: 'user' as const, content: 'injected by hook' },
      ]);
      const result = await Runner.run(agent, 'hi', { llm, beforeNextTurn });
      expect(beforeNextTurn).toHaveBeenCalledTimes(1);
      expect(secondCallSawInjection).toBe(true);
      // Transcript: system, user, assistant(tool_use), user(tool_result), user(injected), assistant(final)
      expect(result.messages).toHaveLength(6);
      expect(result.messages[4]!.role).toBe('user');
      expect(result.messages[4]!.content).toBe('injected by hook');
      expect(result.output).toBe('done');
    });

    it('reports the latest tool names to the beforeNextTurn yield boundary', async () => {
      const echoTool = makeEchoTool();
      const agent = createAgent({
        name: 'yield-boundary-agent',
        instructions: 'sys',
        tools: [echoTool],
      });
      let turn = 0;
      const llm = vi.fn(async (): Promise<RunnerLlmResult> => {
        turn += 1;
        return turn === 1
          ? { text: '', toolCalls: [{ id: 'c1', name: 'echo', input: { text: 'x' } }] }
          : { text: 'done', toolCalls: [] };
      });
      const beforeNextTurn = vi.fn(async () => []);

      await Runner.run(agent, 'hi', { llm, beforeNextTurn });

      expect(beforeNextTurn).toHaveBeenCalledWith(expect.objectContaining({
        lastTurnToolNames: ['echo'],
      }));
    });

    it('injects a FIFO batch as separate user messages in one next LLM call', async () => {
      const echoTool = makeEchoTool();
      const agent = createAgent({
        name: 'batch-inject-agent',
        instructions: 'sys',
        tools: [echoTool],
      });
      let turn = 0;
      let secondCallBatch: readonly { readonly role: string; readonly content: unknown }[] = [];
      const llm = vi.fn(async (messages): Promise<RunnerLlmResult> => {
        turn += 1;
        if (turn === 1) {
          return { text: '', toolCalls: [{ id: 'c1', name: 'echo', input: { text: 'x' } }] };
        }
        secondCallBatch = messages.slice(-2);
        return { text: 'done', toolCalls: [] };
      });
      const beforeNextTurn = vi.fn(async () => [
        { role: 'user' as const, content: 'first interrupt' },
        { role: 'user' as const, content: 'second interrupt' },
      ]);

      await Runner.run(agent, 'hi', { llm, beforeNextTurn });

      expect(llm).toHaveBeenCalledTimes(2);
      expect(beforeNextTurn).toHaveBeenCalledTimes(1);
      expect(secondCallBatch).toEqual([
        { role: 'user', content: 'first interrupt' },
        { role: 'user', content: 'second interrupt' },
      ]);
    });

    it('is a no-op when hook returns an empty array', async () => {
      const echoTool = makeEchoTool();
      const agent = createAgent({
        name: 'empty-inject',
        instructions: 'sys',
        tools: [echoTool],
      });
      let turn = 0;
      const llm = vi.fn(async (): Promise<RunnerLlmResult> => {
        turn += 1;
        if (turn === 1) {
          return { text: '', toolCalls: [{ id: 'c1', name: 'echo', input: { text: 'x' } }] };
        }
        return { text: 'done', toolCalls: [] };
      });
      const beforeNextTurn = vi.fn(async () => []);
      const result = await Runner.run(agent, 'hi', { llm, beforeNextTurn });
      expect(beforeNextTurn).toHaveBeenCalledTimes(1);
      expect(result.messages).toHaveLength(5);
    });

    it('is NOT called on terminal (no-tool) iteration', async () => {
      const agent = createAgent({ name: 'terminal-only', instructions: 'sys' });
      const beforeNextTurn = vi.fn(async () => []);
      const llm = vi.fn(async (): Promise<RunnerLlmResult> => ({ text: 'done', toolCalls: [] }));
      await Runner.run(agent, 'hi', { llm, beforeNextTurn });
      expect(beforeNextTurn).not.toHaveBeenCalled();
    });

    it('closes the active input window and consumes an accepted terminal continuation before returning', async () => {
      const agent = createAgent({ name: 'terminal-continuation', instructions: 'sys' });
      let inputWindowOpen = true;
      let turn = 0;
      const closeInputWindow = vi.fn(() => {
        inputWindowOpen = false;
      });
      const reopenInputWindow = vi.fn(() => {
        inputWindowOpen = true;
      });
      const drain = vi.fn(async () => {
        expect(inputWindowOpen).toBe(false);
        return turn === 1
          ? [{ role: 'user' as const, content: 'accepted during the final request' }]
          : [];
      });
      const llm = vi.fn(async (messages: readonly AgentMessage[]): Promise<RunnerLlmResult> => {
        turn += 1;
        expect(inputWindowOpen).toBe(true);
        if (turn === 2) {
          expect(messages.at(-1)).toMatchObject({
            role: 'user',
            content: 'accepted during the final request',
          });
        }
        return {
          text: turn === 1 ? 'first answer' : 'follow-up answer',
          toolCalls: [],
        };
      });

      const result = await Runner.run(agent, 'hi', {
        llm,
        terminalContinuation: {
          closeInputWindow,
          reopenInputWindow,
          drain,
        },
      });

      expect(llm).toHaveBeenCalledTimes(2);
      expect(closeInputWindow).toHaveBeenCalledTimes(2);
      expect(reopenInputWindow).toHaveBeenCalledTimes(1);
      expect(drain).toHaveBeenCalledTimes(2);
      expect(result.output).toBe('follow-up answer');
      expect(inputWindowOpen).toBe(false);
    });

    it('reserves a generation turn when terminal continuation arrives at the iteration cap', async () => {
      const agent = createAgent({ name: 'terminal-continuation-at-cap', instructions: 'sys' });
      let turn = 0;
      const llm = vi.fn(async (): Promise<RunnerLlmResult> => {
        turn += 1;
        return {
          text: turn === 1 ? 'first answer' : 'follow-up answer',
          toolCalls: [],
        };
      });
      const drain = vi.fn(async () => (
        turn === 1
          ? [{ role: 'user' as const, content: 'accepted at the final iteration' }]
          : []
      ));

      const result = await Runner.run(agent, 'hi', {
        llm,
        maxToolLoopIterations: 1,
        terminalContinuation: {
          closeInputWindow: vi.fn(),
          reopenInputWindow: vi.fn(),
          drain,
        },
      });

      expect(llm).toHaveBeenCalledTimes(2);
      expect(result.output).toBe('follow-up answer');
    });

    it('honors an explicit total-iteration fuse without continuation expansion', async () => {
      const agent = createAgent({ name: 'hard-total-iteration-fuse', instructions: 'sys' });
      const llm = vi.fn(async (): Promise<RunnerLlmResult> => ({
        text: 'first answer',
        toolCalls: [],
      }));
      const drain = vi.fn(async () => [
        { role: 'user' as const, content: 'must not extend the hard fuse' },
      ]);

      const result = await Runner.run(agent, 'hi', {
        llm,
        maxToolLoopIterations: 1,
        maxTotalIterations: 1,
        terminalContinuation: {
          closeInputWindow: vi.fn(),
          reopenInputWindow: vi.fn(),
          drain,
        },
      });

      expect(llm).toHaveBeenCalledTimes(1);
      expect(drain).not.toHaveBeenCalled();
      expect(result.output).toBe('first answer');
    });

    it('bounds repeated terminal continuations beyond the configured iteration cap', async () => {
      const agent = createAgent({ name: 'bounded-terminal-continuation', instructions: 'sys' });
      let inputWindowOpen = true;
      let turn = 0;
      const queuedInputs: AgentMessage[] = [];
      const reopenInputWindow = vi.fn(() => {
        inputWindowOpen = true;
      });
      const llm = vi.fn(async (messages: readonly AgentMessage[]): Promise<RunnerLlmResult> => {
        turn += 1;
        if (
          inputWindowOpen
          && turn <= MAX_RUN_CONTINUATION_ITERATIONS + 2
        ) {
          queuedInputs.push({ role: 'user', content: `interrupt-${turn}` });
        }
        if (turn === MAX_RUN_CONTINUATION_ITERATIONS + 1) {
          expect(inputWindowOpen).toBe(false);
          expect(messages.at(-1)).toMatchObject({
            role: 'user',
            content: `interrupt-${MAX_RUN_CONTINUATION_ITERATIONS}`,
          });
        }
        return { text: `answer-${turn}`, toolCalls: [] };
      });

      const result = await Runner.run(agent, 'hi', {
        llm,
        maxToolLoopIterations: 1,
        terminalContinuation: {
          closeInputWindow: () => {
            inputWindowOpen = false;
          },
          reopenInputWindow,
          drain: vi.fn(async () => queuedInputs.splice(0)),
        },
      });

      expect(llm).toHaveBeenCalledTimes(MAX_RUN_CONTINUATION_ITERATIONS + 1);
      expect(reopenInputWindow).toHaveBeenCalledTimes(MAX_RUN_CONTINUATION_ITERATIONS - 1);
      expect(result.output).toBe(`answer-${MAX_RUN_CONTINUATION_ITERATIONS + 1}`);
      expect(inputWindowOpen).toBe(false);
    });

    it('reserves a generation turn when a stop hook reanimates at the iteration cap', async () => {
      const agent = createAgent({ name: 'stop-hook-reanimate-at-cap', instructions: 'sys' });
      let turn = 0;
      let inputWindowOpen = true;
      const llm = vi.fn(async (): Promise<RunnerLlmResult> => {
        turn += 1;
        expect(inputWindowOpen).toBe(true);
        return {
          text: turn === 1 ? 'premature answer' : 'verified answer',
          toolCalls: [],
        };
      });

      const result = await Runner.run(agent, 'hi', {
        llm,
        maxToolLoopIterations: 1,
        stopHook: vi.fn(async () => (
          turn === 1 ? 'verify before stopping' : undefined
        )),
        terminalContinuation: {
          closeInputWindow: () => {
            inputWindowOpen = false;
          },
          reopenInputWindow: () => {
            inputWindowOpen = true;
          },
          drain: vi.fn(async () => []),
        },
      });

      expect(llm).toHaveBeenCalledTimes(2);
      expect(result.output).toBe('verified answer');
      expect(inputWindowOpen).toBe(false);
    });

    it('reserves a generation turn for a terminal tool signal at the iteration cap', async () => {
      const terminalTool: RunnableTool = {
        name: 'finish',
        description: 'Finish the current step',
        input_schema: { type: 'object', properties: {} },
        execute: async () => ({
          content: 'finished',
          metadata: { isTerminal: true },
        }),
      };
      const agent = createAgent({
        name: 'terminal-tool-continuation-at-cap',
        instructions: 'sys',
        tools: [terminalTool],
        handoffs: [],
      });
      let turn = 0;
      const llm = vi.fn(async (): Promise<RunnerLlmResult> => {
        turn += 1;
        return turn === 1
          ? {
              text: '',
              toolCalls: [{ id: 'finish-1', name: 'finish', input: {} }],
            }
          : { text: 'follow-up answer', toolCalls: [] };
      });

      const result = await Runner.run(agent, 'hi', {
        llm,
        maxToolLoopIterations: 1,
        terminalContinuation: {
          closeInputWindow: vi.fn(),
          reopenInputWindow: vi.fn(),
          drain: vi.fn(async () => (
            turn === 1
              ? [{ role: 'user' as const, content: 'accepted after terminal tool' }]
              : []
          )),
        },
      });

      expect(llm).toHaveBeenCalledTimes(2);
      expect(result.output).toBe('follow-up answer');
    });

    it('persists injected messages to the Session when configured', async () => {
      const echoTool = makeEchoTool();
      const agent = createAgent({
        name: 'inject-session',
        instructions: 'sys',
        tools: [echoTool],
      });
      const session = createInMemorySession();
      let turn = 0;
      const llm = vi.fn(async (): Promise<RunnerLlmResult> => {
        turn += 1;
        if (turn === 1) {
          return { text: '', toolCalls: [{ id: 'c1', name: 'echo', input: { text: 'x' } }] };
        }
        return { text: 'done', toolCalls: [] };
      });
      await Runner.run(agent, 'hi', {
        llm,
        session,
        beforeNextTurn: async () => [{ role: 'user' as const, content: 'mid-turn user input' }],
      });
      const persisted: Array<{ role: string; content: unknown }> = [];
      for await (const entry of session.entries()) {
        if (entry.type === 'message') {
          const p = entry.payload as { role: string; content: unknown };
          persisted.push({ role: p.role, content: p.content });
        }
      }
      // Sequence: user(initial), assistant(tool_use), user(tool_result), user(mid-turn), assistant(final)
      expect(persisted.find((m) => m.content === 'mid-turn user input')).toBeDefined();
    });

    it('hook errors propagate (caller-controlled failure)', async () => {
      const echoTool = makeEchoTool();
      const agent = createAgent({
        name: 'hook-err',
        instructions: 'sys',
        tools: [echoTool],
      });
      let turn = 0;
      const llm = vi.fn(async (): Promise<RunnerLlmResult> => {
        turn += 1;
        if (turn === 1) {
          return { text: '', toolCalls: [{ id: 'c1', name: 'echo', input: { text: 'x' } }] };
        }
        return { text: 'done', toolCalls: [] };
      });
      const beforeNextTurn = vi.fn(async () => {
        throw new Error('caller asked for failure');
      });
      await expect(
        Runner.run(agent, 'hi', { llm, beforeNextTurn }),
      ).rejects.toThrow('caller asked for failure');
    });

    it('hook receives current iteration number for diagnostics', async () => {
      const echoTool = makeEchoTool();
      const agent = createAgent({
        name: 'iter-diag',
        instructions: 'sys',
        tools: [echoTool],
      });
      let turn = 0;
      const llm = vi.fn(async (): Promise<RunnerLlmResult> => {
        turn += 1;
        if (turn <= 2) {
          return {
            text: '',
            toolCalls: [{ id: `c${turn}`, name: 'echo', input: { text: 'x' } }],
          };
        }
        return { text: 'done', toolCalls: [] };
      });
      const seenIterations: number[] = [];
      const beforeNextTurn = vi.fn(async (ctx) => {
        seenIterations.push(ctx.iteration);
        return [];
      });
      await Runner.run(agent, 'hi', { llm, beforeNextTurn });
      // Hook called twice (after iter 0 tool turn, after iter 1 tool turn);
      // iter 2 is terminal so hook not called.
      expect(seenIterations).toEqual([0, 1]);
    });
  });

  describe('runStream', () => {
    it('yields one message event per assistant message then complete', async () => {
      const agent = createAgent({ name: 'stream-hello', instructions: 'sys' });
      const events: Array<{ kind: string }> = [];
      for await (const event of Runner.runStream(agent, 'hi', { llm: async () => 'reply' })) {
        events.push({ kind: event.kind });
      }
      expect(events.map((e) => e.kind)).toEqual(['message', 'complete']);
    });

    it('yields an error event when the run throws', async () => {
      const agent = createAgent({ name: 'stream-err', instructions: 'sys' });
      const events: Array<{ kind: string; error?: Error }> = [];
      for await (const event of Runner.runStream(agent, 'hi', {
        llm: async () => { throw new Error('llm boom'); },
      })) {
        events.push(event.kind === 'error' ? { kind: event.kind, error: event.error } : { kind: event.kind });
      }
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe('error');
      expect(events[0]!.error?.message).toBe('llm boom');
    });
  });
});
