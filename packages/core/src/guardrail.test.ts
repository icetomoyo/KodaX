/**
 * Guardrail runtime tests — FEATURE_085 (v0.7.26).
 *
 * Covers:
 *   - All four verdict actions (allow / rewrite / block / escalate)
 *   - All three hook points (input / output / tool-before / tool-after)
 *   - Declaration order composition
 *   - Runner integration: guardrails attached via Agent or opts
 *   - Span emission
 *   - Legacy path (SA preset dispatcher) unaffected
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgent } from './agent.js';
import {
  GuardrailBlockedError,
  GuardrailEscalateError,
  collectGuardrails,
  runInputGuardrails,
  runOutputGuardrails,
  runToolAfterGuardrails,
  runToolBeforeGuardrails,
  type InputGuardrail,
  type OutputGuardrail,
  type ToolGuardrail,
} from './guardrail.js';
import {
  Runner,
  _resetPresetDispatchers,
  registerPresetDispatcher,
  type PresetDispatcher,
} from './runner.js';
import type { RunnerLlmResult } from './runner-tool-loop.js';

const dummyAgent = createAgent({ name: 'guardrail-test', instructions: 'sys' });
const dummyCtx = { agent: dummyAgent };

describe('collectGuardrails', () => {
  it('partitions by kind', () => {
    const input: InputGuardrail = { kind: 'input', name: 'in', check: async () => ({ action: 'allow' }) };
    const output: OutputGuardrail = { kind: 'output', name: 'out', check: async () => ({ action: 'allow' }) };
    const tool: ToolGuardrail = { kind: 'tool', name: 't' };
    const slots = collectGuardrails([input, output, tool]);
    expect(slots.input).toHaveLength(1);
    expect(slots.output).toHaveLength(1);
    expect(slots.tool).toHaveLength(1);
  });

  it('returns empty slots for undefined/empty input', () => {
    const slots = collectGuardrails(undefined);
    expect(slots.input).toHaveLength(0);
    expect(slots.output).toHaveLength(0);
    expect(slots.tool).toHaveLength(0);
  });
});

describe('runInputGuardrails', () => {
  const baseTranscript = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'q' },
  ];

  it('passes transcript through when all allow', async () => {
    const g: InputGuardrail = { kind: 'input', name: 'g1', check: async () => ({ action: 'allow' }) };
    const result = await runInputGuardrails(baseTranscript, [g], dummyCtx, null);
    expect(result).toEqual(baseTranscript);
  });

  it('applies rewrite payload in order', async () => {
    const first: InputGuardrail = {
      kind: 'input',
      name: 'rewrite-1',
      check: async () => ({
        action: 'rewrite',
        payload: [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: 'rewritten' }],
      }),
    };
    const result = await runInputGuardrails(baseTranscript, [first], dummyCtx, null);
    expect(result[1]!.content).toBe('rewritten');
  });

  it('throws GuardrailBlockedError on block', async () => {
    const g: InputGuardrail = { kind: 'input', name: 'blocker', check: async () => ({ action: 'block', reason: 'nope' }) };
    await expect(runInputGuardrails(baseTranscript, [g], dummyCtx, null))
      .rejects.toThrow(GuardrailBlockedError);
  });

  it('throws GuardrailEscalateError on escalate', async () => {
    const g: InputGuardrail = { kind: 'input', name: 'escalator', check: async () => ({ action: 'escalate', reason: 'needs review' }) };
    await expect(runInputGuardrails(baseTranscript, [g], dummyCtx, null))
      .rejects.toThrow(GuardrailEscalateError);
  });

  it('rejects rewrite with non-array payload', async () => {
    const g: InputGuardrail = {
      kind: 'input', name: 'bad-rewrite', check: async () => ({ action: 'rewrite', payload: 'not-an-array' }),
    };
    await expect(runInputGuardrails(baseTranscript, [g], dummyCtx, null))
      .rejects.toThrow(/expected AgentMessage/);
  });
});

describe('runOutputGuardrails', () => {
  const baseOutput = { role: 'assistant' as const, content: 'final' };

  it('passes through when all allow', async () => {
    const g: OutputGuardrail = { kind: 'output', name: 'o1', check: async () => ({ action: 'allow' }) };
    const result = await runOutputGuardrails(baseOutput, [g], dummyCtx, null);
    expect(result).toBe(baseOutput);
  });

  it('applies rewrite and feeds it to the next guardrail', async () => {
    const first: OutputGuardrail = {
      kind: 'output',
      name: 'redact',
      check: async () => ({
        action: 'rewrite',
        payload: { role: 'assistant' as const, content: '[REDACTED]' },
      }),
    };
    const second: OutputGuardrail = {
      kind: 'output',
      name: 'inspect',
      check: async (msg) => {
        expect(msg.content).toBe('[REDACTED]');
        return { action: 'allow' };
      },
    };
    const result = await runOutputGuardrails(baseOutput, [first, second], dummyCtx, null);
    expect(result.content).toBe('[REDACTED]');
  });

  it('throws on block', async () => {
    const g: OutputGuardrail = { kind: 'output', name: 'deny', check: async () => ({ action: 'block', reason: 'bad' }) };
    await expect(runOutputGuardrails(baseOutput, [g], dummyCtx, null))
      .rejects.toThrow(GuardrailBlockedError);
  });
});

describe('runToolBeforeGuardrails', () => {
  const call = { id: 'c1', name: 'echo', input: { text: 'hi' } };

  it('returns allow+call when all pass', async () => {
    const g: ToolGuardrail = {
      kind: 'tool', name: 'g', beforeTool: async () => ({ action: 'allow' }),
    };
    const outcome = await runToolBeforeGuardrails(call, [g], dummyCtx, null);
    expect(outcome.kind).toBe('allow');
    expect(outcome.kind === 'allow' && outcome.call.id).toBe('c1');
  });

  it('returns block+error tool_result without throwing', async () => {
    const g: ToolGuardrail = {
      kind: 'tool', name: 'veto', beforeTool: async () => ({ action: 'block', reason: 'path-escape' }),
    };
    const outcome = await runToolBeforeGuardrails(call, [g], dummyCtx, null);
    expect(outcome.kind).toBe('block');
    if (outcome.kind === 'block') {
      expect(outcome.result.isError).toBe(true);
      expect(outcome.result.content).toMatch(/path-escape/);
    }
  });

  it('rewrites the call for downstream guardrails + execution', async () => {
    const first: ToolGuardrail = {
      kind: 'tool',
      name: 'redact-args',
      beforeTool: async () => ({
        action: 'rewrite',
        payload: { id: 'c1', name: 'echo', input: { text: 'redacted' } },
      }),
    };
    const outcome = await runToolBeforeGuardrails(call, [first], dummyCtx, null);
    expect(outcome.kind === 'allow' && (outcome.call.input as { text: string }).text).toBe('redacted');
  });

  it('escalate still throws', async () => {
    const g: ToolGuardrail = {
      kind: 'tool', name: 'esc', beforeTool: async () => ({ action: 'escalate', reason: 'confirm' }),
    };
    await expect(runToolBeforeGuardrails(call, [g], dummyCtx, null))
      .rejects.toThrow(GuardrailEscalateError);
  });
});

describe('runToolAfterGuardrails', () => {
  const call = { id: 'c1', name: 'echo', input: {} };
  const baseResult = { content: 'raw output' };

  it('allows passthrough', async () => {
    const g: ToolGuardrail = {
      kind: 'tool', name: 'g', afterTool: async () => ({ action: 'allow' }),
    };
    const result = await runToolAfterGuardrails(call, baseResult, [g], dummyCtx, null);
    expect(result.content).toBe('raw output');
  });

  it('rewrites content and passes to downstream guardrails', async () => {
    const first: ToolGuardrail = {
      kind: 'tool',
      name: 'truncate',
      afterTool: async () => ({ action: 'rewrite', payload: { content: 'truncated...' } }),
    };
    const second: ToolGuardrail = {
      kind: 'tool',
      name: 'inspect',
      afterTool: async (_c, r) => {
        expect(r.content).toBe('truncated...');
        return { action: 'allow' };
      },
    };
    const result = await runToolAfterGuardrails(call, baseResult, [first, second], dummyCtx, null);
    expect(result.content).toBe('truncated...');
  });

  it('block replaces the result with an error tool_result (no throw)', async () => {
    const g: ToolGuardrail = {
      kind: 'tool',
      name: 'policy-violation',
      afterTool: async () => ({ action: 'block', reason: 'contains secret' }),
    };
    const result = await runToolAfterGuardrails(call, baseResult, [g], dummyCtx, null);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/contains secret/);
  });
});

describe('Runner integration — guardrails active in generic path', () => {
  afterEach(() => _resetPresetDispatchers());

  it('input rewrite shows up in the first LLM call', async () => {
    const inputGuardrail: InputGuardrail = {
      kind: 'input',
      name: 'prepend-note',
      check: async (msgs) => ({
        action: 'rewrite',
        payload: [...msgs, { role: 'user' as const, content: 'appended-note' }],
      }),
    };
    const seenMessages: string[][] = [];
    const agent = createAgent({
      name: 'g-agent-1',
      instructions: 'sys',
      guardrails: [inputGuardrail],
    });
    const llm = vi.fn(async (messages: readonly { content: unknown }[]): Promise<string> => {
      seenMessages.push(messages.map((m) => typeof m.content === 'string' ? m.content : '[blocks]'));
      return 'done';
    });
    await Runner.run(agent, 'q', { llm });
    expect(seenMessages[0]).toEqual(['sys', 'q', 'appended-note']);
  });

  it('output guardrail rewrites final assistant message', async () => {
    const outputGuardrail: OutputGuardrail = {
      kind: 'output',
      name: 'redact',
      check: async () => ({ action: 'rewrite', payload: { role: 'assistant', content: '[REDACTED]' } }),
    };
    const agent = createAgent({
      name: 'g-agent-2',
      instructions: 'sys',
      guardrails: [outputGuardrail],
    });
    const result = await Runner.run(agent, 'q', { llm: async () => 'secret' });
    expect(result.output).toBe('[REDACTED]');
  });

  it('input block aborts before any LLM call', async () => {
    const inputGuardrail: InputGuardrail = {
      kind: 'input',
      name: 'deny',
      check: async () => ({ action: 'block', reason: 'forbidden-prompt' }),
    };
    const agent = createAgent({
      name: 'g-agent-3',
      instructions: 'sys',
      guardrails: [inputGuardrail],
    });
    const llm = vi.fn(async () => 'unreached');
    await expect(Runner.run(agent, 'q', { llm })).rejects.toThrow(GuardrailBlockedError);
    expect(llm).not.toHaveBeenCalled();
  });

  it('tool-before block surfaces error tool_result to LLM without executing', async () => {
    let toolExecuted = false;
    const echoTool = {
      name: 'echo',
      description: 'echo',
      input_schema: { type: 'object' as const, properties: {} },
      execute: async () => {
        toolExecuted = true;
        return { content: 'should not happen' };
      },
    };
    const toolGuardrail: ToolGuardrail = {
      kind: 'tool',
      name: 'path-check',
      beforeTool: async () => ({ action: 'block', reason: 'disallowed' }),
    };
    const agent = createAgent({
      name: 'g-agent-4',
      instructions: 'sys',
      tools: [echoTool],
      guardrails: [toolGuardrail],
    });
    let turn = 0;
    const llm = async (messages: readonly { role: string; content: unknown }[]): Promise<RunnerLlmResult> => {
      turn += 1;
      if (turn === 1) {
        return { text: '', toolCalls: [{ id: 'c1', name: 'echo', input: {} }] };
      }
      // Second turn: LLM sees the tool_result block containing the guardrail rejection
      const last = messages[messages.length - 1]!;
      const blocks = last.content as Array<{ type: string; content: string; is_error?: boolean }>;
      expect(blocks[0]!.is_error).toBe(true);
      expect(blocks[0]!.content).toMatch(/disallowed/);
      return { text: 'adapted', toolCalls: [] };
    };
    const result = await Runner.run(agent, 'q', { llm });
    expect(toolExecuted).toBe(false);
    expect(result.output).toBe('adapted');
  });

  it('tool-after rewrite replaces result content seen by LLM', async () => {
    const echoTool = {
      name: 'echo',
      description: 'echo',
      input_schema: { type: 'object' as const, properties: {} },
      execute: async () => ({ content: 'raw-output' }),
    };
    const toolGuardrail: ToolGuardrail = {
      kind: 'tool',
      name: 'truncate',
      afterTool: async () => ({ action: 'rewrite', payload: { content: 'truncated' } }),
    };
    const agent = createAgent({
      name: 'g-agent-5',
      instructions: 'sys',
      tools: [echoTool],
      guardrails: [toolGuardrail],
    });
    let turn = 0;
    const llm = async (messages: readonly { role: string; content: unknown }[]): Promise<RunnerLlmResult> => {
      turn += 1;
      if (turn === 1) return { text: '', toolCalls: [{ id: 'c1', name: 'echo', input: {} }] };
      const last = messages[messages.length - 1]!;
      const blocks = last.content as Array<{ type: string; content: string }>;
      expect(blocks[0]!.content).toBe('truncated');
      return { text: 'final', toolCalls: [] };
    };
    const result = await Runner.run(agent, 'q', { llm });
    expect(result.output).toBe('final');
  });

  it('opts.guardrails are merged with agent.guardrails', async () => {
    const fromAgent: InputGuardrail = {
      kind: 'input',
      name: 'from-agent',
      check: async (msgs) => ({ action: 'rewrite', payload: [...msgs, { role: 'user' as const, content: 'A' }] }),
    };
    const fromOpts: InputGuardrail = {
      kind: 'input',
      name: 'from-opts',
      check: async (msgs) => ({ action: 'rewrite', payload: [...msgs, { role: 'user' as const, content: 'B' }] }),
    };
    const agent = createAgent({
      name: 'g-agent-6',
      instructions: 'sys',
      guardrails: [fromAgent],
    });
    const seen: string[][] = [];
    const llm = async (messages: readonly { content: unknown }[]): Promise<string> => {
      seen.push(messages.map((m) => typeof m.content === 'string' ? m.content : '[blocks]'));
      return 'done';
    };
    await Runner.run(agent, 'q', { llm, guardrails: [fromOpts] });
    // Both guardrails ran: agent first, opts second
    expect(seen[0]).toEqual(['sys', 'q', 'A', 'B']);
  });

  it('preset dispatcher path ignores guardrails (backward-compat)', async () => {
    const dispatcher: PresetDispatcher = vi.fn(async () => ({
      output: 'preset-result',
      messages: [{ role: 'assistant' as const, content: 'preset-result' }],
    }));
    registerPresetDispatcher('preset-g', dispatcher);
    const neverCalled: InputGuardrail = {
      kind: 'input',
      name: 'should-not-run',
      check: async () => { throw new Error('guardrail ran on preset path'); },
    };
    const agent = createAgent({ name: 'preset-g', instructions: 'sys', guardrails: [neverCalled] });
    const result = await Runner.run(agent, 'hi', { tracer: null });
    expect(result.output).toBe('preset-result');
  });
});

describe('Runner integration — GuardrailSpan emission', () => {
  it('emits a guardrail span for each check under the AgentSpan', async () => {
    const { Tracer, addTracingProcessor, setTracingProcessors } = await import('@kodax/tracing');
    setTracingProcessors([]);
    const ended: Array<{ name: string; kind: string; decision?: string; hook?: string }> = [];
    addTracingProcessor({
      onSpanStart: () => { /* noop */ },
      onSpanEnd: (span) => {
        ended.push({
          name: span.name,
          kind: span.data.kind,
          decision: (span.data as { decision?: string }).decision,
          hook: (span.data as { hookPoint?: string }).hookPoint,
        });
      },
      onTraceEnd: () => { /* noop */ },
    });

    const inputGuardrail: InputGuardrail = {
      kind: 'input',
      name: 'inp',
      check: async () => ({ action: 'allow' }),
    };
    const outputGuardrail: OutputGuardrail = {
      kind: 'output',
      name: 'outp',
      check: async () => ({ action: 'rewrite', payload: { role: 'assistant', content: 'rewritten' } }),
    };
    const agent = createAgent({
      name: 'span-agent',
      instructions: 'sys',
      guardrails: [inputGuardrail, outputGuardrail],
    });
    await Runner.run(agent, 'q', { llm: async () => 'orig', tracer: new Tracer() });
    setTracingProcessors([]);

    const inputSpan = ended.find((s) => s.hook === 'input');
    const outputSpan = ended.find((s) => s.hook === 'output');
    expect(inputSpan?.decision).toBe('pass');
    expect(outputSpan?.decision).toBe('rewrite');
  });

  it('MED-3: a thrown guardrail emits a decision:"error" span and re-throws (fail-loud)', async () => {
    const { Tracer, addTracingProcessor, setTracingProcessors } = await import('@kodax/tracing');
    setTracingProcessors([]);
    const ended: Array<{ name: string; kind: string; decision?: string; error?: string; hook?: string }> = [];
    addTracingProcessor({
      onSpanStart: () => { /* noop */ },
      onSpanEnd: (span) => {
        ended.push({
          name: span.name,
          kind: span.data.kind,
          decision: (span.data as { decision?: string }).decision,
          error: (span.data as { error?: string }).error,
          hook: (span.data as { hookPoint?: string }).hookPoint,
        });
      },
      onTraceEnd: () => { /* noop */ },
    });

    const buggy: InputGuardrail = {
      kind: 'input',
      name: 'buggy',
      check: async () => { throw new Error('kaboom'); },
    };
    const agent = createAgent({
      name: 'buggy-agent',
      instructions: 'sys',
      guardrails: [buggy],
    });
    await expect(
      Runner.run(agent, 'q', { llm: async () => 'ok', tracer: new Tracer() }),
    ).rejects.toThrow(/kaboom/);
    setTracingProcessors([]);

    const errSpan = ended.find((s) => s.hook === 'input' && s.decision === 'error');
    expect(errSpan).toBeDefined();
    expect(errSpan?.error).toMatch(/kaboom/);
  });
});
