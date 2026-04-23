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

import { createAgent, type Agent, type Guardrail } from './agent.js';
import type { InputGuardrail, ToolGuardrail } from './guardrail.js';
import { createInMemorySession } from './session.js';
import {
  Runner,
  _resetPresetDispatchers,
  registerPresetDispatcher,
  type PresetDispatcher,
} from './runner.js';
import {
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
      const { Tracer, addTracingProcessor, setTracingProcessors } = await import('@kodax/tracing');
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
      const { Tracer } = await import('@kodax/tracing');
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
      const toolResultBlocks = result.messages[3]!.content as Array<{ type: string }>;
      expect(toolResultBlocks[0]!.type).toBe('tool_result');
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
      await expect(Runner.run(agent, 'hi', { llm }))
        .rejects.toThrow(/MAX_TOOL_LOOP_ITERATIONS/);
      expect(llm).toHaveBeenCalledTimes(MAX_TOOL_LOOP_ITERATIONS);
    });

    it('emits a ToolCallSpan under the AgentSpan for each tool execution', async () => {
      const { Tracer, addTracingProcessor, setTracingProcessors } = await import('@kodax/tracing');
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
      const { Tracer, addTracingProcessor, setTracingProcessors } = await import('@kodax/tracing');
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
      const calls: Array<{ kind: 'call' | 'result'; id: string; name: string; content?: string }> = [];
      await Runner.run(agent, 'hi', {
        llm,
        toolObserver: {
          onToolCall: (call) => {
            calls.push({ kind: 'call', id: call.id, name: call.name });
          },
          onToolResult: (call, result) => {
            calls.push({ kind: 'result', id: call.id, name: call.name, content: result.content });
          },
        },
      });
      expect(calls).toEqual([
        { kind: 'call', id: 'c1', name: 'echo' },
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
