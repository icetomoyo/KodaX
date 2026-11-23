import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXStreamResult, type KodaXTokenUsage,
} from '@kodax-ai/llm';
import { buildRunnerLlmAdapter, type RunnerAdapterTokenState } from './llm-adapter.js';

afterEach(() => { clearRuntimeModelProviders(); vi.unstubAllEnvs(); });

/** Asks a model once per entry; each entry is what that call reports it used. */
async function runUsage(reported: readonly (KodaXTokenUsage | undefined)[]): Promise<RunnerAdapterTokenState> {
  let calls = 0;
  class Scripted extends KodaXBaseProvider {
    readonly name = 'run-usage-contract';
    readonly supportsThinking = false;
    protected readonly config = {
      apiKeyEnv: 'KODAX_RUN_USAGE_TEST_KEY', model: 'scripted', supportsThinking: false,
      reasoningCapability: 'prompt-only' as const, maxOutputTokens: 32000,
    };
    async stream(): Promise<KodaXStreamResult> {
      const usage = reported[calls++];
      return { textBlocks: [{ type: 'text', text: 'done' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn',
        ...(usage ? { usage } : {}) };
    }
  }
  vi.stubEnv('KODAX_RUN_USAGE_TEST_KEY', 'scripted-test-key');
  registerModelProvider('run-usage-contract', () => new Scripted());
  const tokenState: { current: RunnerAdapterTokenState } = { current: { totalTokens: 0, source: 'estimate' } };
  const adapter = buildRunnerLlmAdapter({ provider: 'run-usage-contract',
    context: { gitRoot: tmpdir(), executionCwd: tmpdir(), repoIntelligenceMode: 'off' } }, undefined, tokenState);
  for (const _ of reported) {
    await adapter([{ role: 'user', content: 'Answer.' }], { name: 'kodax/role/worker', instructions: '' });
  }
  return tokenState.current;
}

describe('what a managed Run used', () => {
  it('adds up every model call of the Run', async () => {
    const state = await runUsage([
      { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedReadTokens: 4 },
      { inputTokens: 20, outputTokens: 7, totalTokens: 27 },
    ]);
    expect(state.runUsage).toEqual({ inputTokens: 30, outputTokens: 12, totalTokens: 42, cachedReadTokens: 4 });
  });

  it('reports nothing once a call did not say what it used', async () => {
    const state = await runUsage([{ inputTokens: 10, outputTokens: 5, totalTokens: 15 }, undefined, { inputTokens: 1, outputTokens: 1, totalTokens: 2 }]);
    expect(state.runUsage).toBeUndefined();
    expect(state.runUsageIncomplete).toBe(true);
  });
});
