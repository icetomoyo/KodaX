import { beforeEach, describe, expect, it, vi } from 'vitest';

const stream = vi.fn();

vi.mock('@kodax-ai/llm', async (importOriginal) => ({
  reconcileAssistantContent: (await importOriginal<typeof import('@kodax-ai/llm')>()).reconcileAssistantContent,
  getProvider: () => ({ stream }),
}));

import { runBenchmark, runOneShot } from './harness.js';

describe('runOneShot alias fidelity', () => {
  beforeEach(() => {
    stream.mockReset();
    stream.mockResolvedValue({
      textBlocks: [{ type: 'text', text: 'ok' }],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });
  });

  it('passes the alias model to the provider and preserves token usage', async () => {
    const result = await runOneShot('ark/v4flash', {
      systemPrompt: 'system',
      userMessage: 'user',
      maxOutputTokens: 2_048,
    });

    expect(stream).toHaveBeenCalledWith(
      [{ role: 'user', content: 'user' }],
      [],
      'system',
      undefined,
      { modelOverride: 'deepseek-v4-flash', maxOutputTokensOverride: 2_048 },
    );
    expect(result.target.model).toBe('deepseek-v4-flash');
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  });

  it('continues a prior conversation without a new user message and returns the assistant turn', async () => {
    stream.mockResolvedValue({
      textBlocks: [{ type: 'text', text: 'looking' }],
      toolBlocks: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } }],
      thinkingBlocks: [],
    });
    const prior = [
      { role: 'user' as const, content: 'task' },
      { role: 'assistant' as const, content: 'ok' },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 't0', content: 'done' }] },
    ];
    const result = await runOneShot('ark/v4flash', { systemPrompt: 'system', priorMessages: prior });

    expect(stream.mock.calls[0]![0]).toEqual(prior);
    expect(result.assistantContent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'looking' }),
      expect.objectContaining({ type: 'tool_use', id: 't1', name: 'read' }),
    ]));
  });

  it('passes an explicit forced report tool through for production-aligned judges', async () => {
    await runOneShot('ark/v4flash', {
      systemPrompt: 'system',
      userMessage: 'user',
      tools: [{
        name: 'commit_review',
        description: 'Commit the structured review.',
        input_schema: { type: 'object', properties: {}, required: [] },
      }],
      forcedToolName: 'commit_review',
      maxOutputTokens: 1_200,
    });

    expect(stream).toHaveBeenCalledWith(
      [{ role: 'user', content: 'user' }],
      [expect.objectContaining({ name: 'commit_review' })],
      'system',
      undefined,
      {
        modelOverride: 'deepseek-v4-flash',
        forcedToolName: 'commit_review',
        maxOutputTokensOverride: 1_200,
      },
    );
  });

  it('rescored resumed raw output without another provider call', async () => {
    const result = await runBenchmark({
      variants: [{ id: 'proposed', systemPrompt: 'system', userMessage: 'user' }],
      models: ['ark/v4flash'],
      judges: [{ name: 'current-contract', judge: (output) => ({ passed: output === 'current' }) }],
      runs: 1,
      resumeRun: () => ({
        variantId: 'proposed', alias: 'ark/v4flash', runIndex: 0,
        text: 'current', toolCalls: [], durationMs: 10,
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        judges: [],
        judgeAggregate: { passed: false, results: [], byCategory: {}, formatPassed: true },
        passed: false,
      }),
    });

    expect(stream).not.toHaveBeenCalled();
    expect(result.cells[0]?.passRate).toBe(100);
  });

  it('invalidates a resumed run that exceeded the frozen timeout', async () => {
    const result = await runBenchmark({
      variants: [{ id: 'proposed', systemPrompt: 'system', userMessage: 'user' }],
      models: ['ark/v4flash'],
      judges: [{ name: 'always', judge: () => ({ passed: true }) }],
      runs: 1,
      timeoutMs: 120_000,
      resumeRun: () => ({
        variantId: 'proposed', alias: 'ark/v4flash', runIndex: 0,
        text: 'current', toolCalls: [], durationMs: 120_001,
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        judges: [],
        judgeAggregate: { passed: true, results: [], byCategory: {}, formatPassed: true },
        passed: true,
      }),
    });

    expect(result.cells[0]?.completed).toBe(0);
    expect(result.cells[0]?.runsRaw[0]?.error).toContain('exceeded frozen timeout');
  });

  it('runs three Ark models concurrently, serializes each model, and caps Ark at three', async () => {
    type ResolveStream = (value: {
      textBlocks: Array<{ type: 'text'; text: string }>;
      toolBlocks: never[];
      thinkingBlocks: never[];
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    }) => void;
    const pending = new Map<string, ResolveStream[]>();
    stream.mockImplementation((
      _messages: unknown,
      _tools: unknown,
      _system: unknown,
      _reasoning: unknown,
      options: { modelOverride: string },
    ) => new Promise((resolve) => {
      const resolvers = pending.get(options.modelOverride) ?? [];
      resolvers.push(resolve);
      pending.set(options.modelOverride, resolvers);
    }));
    const resultPromise = runBenchmark({
      variants: [{ id: 'candidate', systemPrompt: 'system', userMessage: 'user' }],
      models: ['ark/v4pro', 'ark/v4flash', 'ark/k27', 'ark/glm51'],
      judges: [{ name: 'ok', judge: () => ({ passed: true }) }],
      runs: 1,
    });

    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(3));
    expect(pending.has('deepseek-v4-pro')).toBe(true);
    expect(pending.has('deepseek-v4-flash')).toBe(true);
    expect(pending.has('kimi-k2.7-code')).toBe(true);
    expect(pending.has('glm-5.1')).toBe(false);

    const output = {
      textBlocks: [{ type: 'text' as const, text: 'ok' }],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
    pending.get('deepseek-v4-pro')![0]!(output);
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(4));
    pending.get('deepseek-v4-flash')![0]!(output);
    pending.get('kimi-k2.7-code')![0]!(output);
    pending.get('glm-5.1')![0]!(output);

    const result = await resultPromise;
    expect(result.cells).toHaveLength(4);
    expect(result.models).toEqual(['ark/v4pro', 'ark/v4flash', 'ark/k27', 'ark/glm51']);
  });

  it('does not overlap repeated calls to the same Ark model', async () => {
    let active = 0;
    let maxActive = 0;
    stream.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return {
        textBlocks: [{ type: 'text', text: 'ok' }],
        toolBlocks: [],
        thinkingBlocks: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    });
    await Promise.all([1, 2, 3].map(() => runOneShot('ark/k27', {
      systemPrompt: 'system', userMessage: 'user',
    })));
    expect(maxActive).toBe(1);
  });
});
