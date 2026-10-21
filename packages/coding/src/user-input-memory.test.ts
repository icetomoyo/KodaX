import { describe, expect, it, vi } from 'vitest';
import { prepareUserInputMemory, retainUserInput } from './user-input-memory.js';
import { buildCreatedGoal } from './goal/state.js';

describe('paged original user memory', () => {
  it('retains normal memory with usage, model selection and a bounded signal; rejects partial or tool-bearing extraction', async () => {
    const onUsage = vi.fn();
    const stream = vi.fn(async () => ({ textBlocks: [{ type: 'text' as const, text: '["Never deploy."]' }], toolBlocks: [],
      thinkingBlocks: [], stopReason: 'end_turn' as const, usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } }));
    const provider = { name: 'memory-local-fixture', stream, getReasoningProfile: () => undefined };
    expect(await prepareUserInputMemory({ original: 'Never deploy.', contextWindow: 8192, provider, model: 'local', timeoutMs: 1000, onUsage }))
      .toEqual(['Never deploy.']);
    expect(stream).toHaveBeenCalledWith(expect.any(Array), [], expect.any(String), expect.anything(),
      expect.objectContaining({ modelOverride: 'local', singleAttempt: true }), expect.any(AbortSignal));
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 5, outputTokens: 5, totalTokens: 10 });
    for (const partial of [
      { textBlocks: [], toolBlocks: [], thinkingBlocks: [], stopReason: 'max_tokens' as const },
      { textBlocks: [], toolBlocks: [{ type: 'tool_use' as const, id: 'forbidden', name: 'bash', input: {} }], thinkingBlocks: [] },
    ]) await expect(prepareUserInputMemory({ original: 'Never deploy.', contextWindow: 8192,
      provider: { name: provider.name, stream: async () => partial, getReasoningProfile: () => undefined } })).rejects.toThrow(/Incomplete/);
    await expect(prepareUserInputMemory({ original: 'Never deploy.', contextWindow: 100, provider })).rejects.toThrow(/cannot fit/);
    const controller = new AbortController(); controller.abort(new Error('Stopped'));
    await expect(prepareUserInputMemory({ original: 'Never deploy.', contextWindow: 8192, provider, signal: controller.signal })).rejects.toThrow('Stopped');
  });
  it('charges extraction to the Goal and stops before issuing another chunk when its budget is exhausted', async () => {
    let goal = buildCreatedGoal('Preserve requirements', 10);
    const stream = vi.fn(async () => ({ textBlocks: [{ type: 'text' as const, text: '[]' }], toolBlocks: [],
      thinkingBlocks: [], usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }));
    await expect(prepareUserInputMemory({ original: 'background '.repeat(12000), contextWindow: 8192,
      provider: { name: 'memory-budget-fixture', stream, getReasoningProfile: () => undefined },
      goalRuntime: { lifecycleCtx: { getGoal: () => goal, persistEvent: async next => { if (next) goal = next; },
        buildContinuationPrompt: () => 'continue' } },
    })).rejects.toThrow(/Goal token budget/);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(goal).toMatchObject({ status: 'budget_limited', tokensUsed: 120 });
  });
  it('collects exact constraints across chunks without allowing later chunks to erase earlier ones', async () => {
    const original = 'Never rerun EDIT-019.\n' + 'ordinary evidence '.repeat(3000) + '\nReturn JSON only.';
    const generate = vi.fn(async (chunk: string) => JSON.stringify([
      ...['Never rerun EDIT-019.', 'Return JSON only.'].filter(quote => chunk.includes(quote)),
    ]));
    const retained = await retainUserInput(original, 8192, generate);
    expect(retained).toEqual(['Never rerun EDIT-019.', 'Return JSON only.']);
    expect(generate.mock.calls.length).toBeGreaterThan(2);
    expect(generate.mock.calls.map(([chunk]) => chunk).join('')).toBe(original);
  });

  it('rejects invented, malformed, or oversized memory instead of silently discarding constraints', async () => {
    await expect(retainUserInput('Never deploy.', 8192, async () => '["Deploy now."]')).rejects.toThrow('verbatim');
    await expect(retainUserInput('Never deploy.', 8192, async () => 'done')).rejects.toThrow('JSON');
    const original = 'Binding constraint '.repeat(2000);
    await expect(retainUserInput(original, 4096, async chunk => JSON.stringify([chunk]))).rejects.toThrow('capacity');
  });
});
