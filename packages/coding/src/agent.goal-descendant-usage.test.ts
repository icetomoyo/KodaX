import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KodaXProviderConfig, KodaXStreamResult } from '@kodax-ai/llm';
import { clearRuntimeModelProviders, KodaXBaseProvider, registerModelProvider } from '@kodax-ai/llm';
import { appendGoalEntry, readLatestGoalState, type KodaXSessionLineage } from '@kodax-ai/agent';
import { runKodaX } from './agent.js';
import { buildGoalRuntimeBinding } from './goal/runtime-wiring.js';
import { buildCreatedGoal } from './goal/state.js';

const PROVIDER_NAME = 'goal-descendant-usage-provider';
const PROVIDER_API_KEY_ENV = 'GOAL_DESCENDANT_USAGE_PROVIDER_API_KEY';
const CALL_USAGE = { inputTokens: 42, outputTokens: 3, totalTokens: 45, cachedReadTokens: 21 };
let reportUsage = true;
let beforeResponse: (() => void) | undefined;

class UsageProvider extends KodaXBaseProvider {
  readonly name = PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: PROVIDER_API_KEY_ENV,
    model: 'usage-model',
    supportsThinking: false,
    contextWindow: 32_000,
    maxOutputTokens: 1_000,
  };

  async stream(): Promise<KodaXStreamResult> {
    beforeResponse?.();
    return { textBlocks: [{ type: 'text', text: 'done' }], toolBlocks: [], thinkingBlocks: [],
      ...(reportUsage ? { usage: CALL_USAGE } : {}) };
  }
}

function lineageWithGoal(tokenBudget: number): KodaXSessionLineage {
  const lineage: KodaXSessionLineage = { version: 2, activeEntryId: 'm1', entries: [{
    type: 'message', id: 'm1', parentId: null, timestamp: '2026-10-31T00:00:00.000Z',
    message: { role: 'user', content: 'start' },
  }] };
  return appendGoalEntry(lineage, buildCreatedGoal('finish the work', tokenBudget), 'created');
}

describe('descendant goal usage on the direct substrate', () => {
  beforeEach(() => {
    reportUsage = true;
    beforeResponse = undefined;
    process.env[PROVIDER_API_KEY_ENV] = 'test-key';
    registerModelProvider(PROVIDER_NAME, () => new UsageProvider());
  });

  afterEach(() => {
    clearRuntimeModelProviders();
    delete process.env[PROVIDER_API_KEY_ENV];
  });

  it('reports each child provider call to the inherited goal sink', async () => {
    const goalUsageSink = vi.fn();
    await runKodaX({ provider: PROVIDER_NAME, reasoningMode: 'off', maxIter: 1,
      context: { repoIntelligenceMode: 'off', currentAgentId: '/root/child', goalUsageSink } }, 'inspect');
    expect(goalUsageSink).toHaveBeenCalledExactlyOnceWith(CALL_USAGE);
  });

  it('settles pending descendant tokens with the root call that follows them', async () => {
    let lineage = lineageWithGoal(10_000);
    const binding = buildGoalRuntimeBinding({
      getLineage: () => lineage,
      setLineage: next => { lineage = next; },
      saveSession: async () => undefined,
      getLatestUsage: () => undefined,
      getTurnStartMs: () => undefined,
      hasPendingUserInput: () => false,
    });
    binding.lifecycleCtx.chargeDescendantUsage?.({ inputTokens: 1500, outputTokens: 100, totalTokens: 1600, cachedReadTokens: 200 });

    await runKodaX({ provider: PROVIDER_NAME, reasoningMode: 'off', maxIter: 1,
      context: { repoIntelligenceMode: 'off', goalRuntime: binding } }, 'continue');

    expect(readLatestGoalState(lineage)?.tokensUsed).toBe(24 + 1400);
    expect(binding.lifecycleCtx.getDescendantTokens?.(readLatestGoalState(lineage)!.id)).toBe(0);
  });

  it('settles known descendant usage when the root response has no usage', async () => {
    reportUsage = false;
    let lineage = lineageWithGoal(1000);
    const binding = buildGoalRuntimeBinding({ getLineage: () => lineage,
      setLineage: next => { lineage = next; }, saveSession: async () => undefined,
      getLatestUsage: () => undefined, getTurnStartMs: () => undefined,
      hasPendingUserInput: () => false });
    binding.lifecycleCtx.chargeDescendantUsage?.({ inputTokens: 1500, outputTokens: 0, totalTokens: 1500 });

    await runKodaX({ provider: PROVIDER_NAME, reasoningMode: 'off', maxIter: 1,
      context: { repoIntelligenceMode: 'off', goalRuntime: binding } }, 'continue');

    expect(readLatestGoalState(lineage)).toMatchObject({ status: 'budget_limited', tokensUsed: 1500 });
  });

  it('does not charge a replacement goal for an already-running child request', async () => {
    let lineage = lineageWithGoal(1000);
    const binding = buildGoalRuntimeBinding({ getLineage: () => lineage,
      setLineage: next => { lineage = next; }, saveSession: async () => undefined,
      getLatestUsage: () => undefined, getTurnStartMs: () => undefined,
      hasPendingUserInput: () => false });
    const replacement = buildCreatedGoal('replacement work', 1000);
    beforeResponse = () => { lineage = appendGoalEntry(appendGoalEntry(lineage, null, 'cleared'), replacement, 'created'); };

    await runKodaX({ provider: PROVIDER_NAME, reasoningMode: 'off', maxIter: 1,
      context: { repoIntelligenceMode: 'off', currentAgentId: '/root/child',
        goalUsageSink: binding.lifecycleCtx.chargeDescendantUsage } }, 'inspect');

    expect(binding.lifecycleCtx.getDescendantTokens?.(replacement.id)).toBe(0);
  });

  it('flushes a child response arriving after the last root settlement without another provider turn', async () => {
    let lineage = lineageWithGoal(10000);
    let saved = 0;
    let calls = 0;
    beforeResponse = () => { calls++; };
    const binding = buildGoalRuntimeBinding({ getLineage: () => lineage,
      setLineage: next => { lineage = next; }, saveSession: async () => {
        if (saved++ === 0) binding.lifecycleCtx.chargeDescendantUsage?.({ inputTokens: 1500, outputTokens: 0, totalTokens: 1500 });
      }, getLatestUsage: () => undefined, getTurnStartMs: () => undefined, hasPendingUserInput: () => false });
    binding.lifecycleCtx.chargeDescendantUsage!({ inputTokens: 500, outputTokens: 0, totalTokens: 500 });

    await runKodaX({ provider: PROVIDER_NAME, reasoningMode: 'off', maxIter: 1,
      context: { repoIntelligenceMode: 'off', goalRuntime: binding } }, 'continue');

    expect(readLatestGoalState(lineage)?.tokensUsed).toBe(2024);
    expect(calls).toBe(1);
  });

  it('preserves descendant usage when the direct root journal write fails', async () => {
    let lineage = lineageWithGoal(10000);
    let failWrite = true;
    const pendingDescendantUsage = new Map<string, number>();
    const bind = () => buildGoalRuntimeBinding({ getLineage: () => lineage, pendingDescendantUsage,
      setLineage: next => { lineage = next; }, saveSession: async () => {
        if (failWrite) throw new Error('Journal unavailable');
      }, getLatestUsage: () => undefined, getTurnStartMs: () => undefined, hasPendingUserInput: () => false });
    const first = bind();
    first.lifecycleCtx.chargeDescendantUsage!({ inputTokens: 1500, outputTokens: 0, totalTokens: 1500 });

    const result = await runKodaX({ provider: PROVIDER_NAME, reasoningMode: 'off', maxIter: 1,
      context: { repoIntelligenceMode: 'off', goalRuntime: first } }, 'continue');
    expect(result.success).toBe(false);
    failWrite = false;
    const second = bind();
    await second.flushDescendantUsage!();
    await second.flushDescendantUsage!();

    expect(readLatestGoalState(lineage)?.tokensUsed).toBe(1500);
  });
});
