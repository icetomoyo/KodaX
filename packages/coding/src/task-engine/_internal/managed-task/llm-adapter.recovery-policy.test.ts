import { afterEach, expect, it, vi } from 'vitest';
import { clearRuntimeModelProviders, KodaXBaseProvider, registerModelProvider,
  type KodaXMessage, type KodaXStreamResult, type KodaXToolDefinition } from '@kodax-ai/llm';
import { cleanupUserInputDegradationCache, createUserInputDegradationCache } from '../../../capacity-recovery.js';
import { buildRunnerLlmAdapter } from './llm-adapter.js';

afterEach(() => {
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
});

it('keeps oversized input intact at the actual Provider when Skill policy forbids paging recovery', async () => {
  const requests: KodaXMessage[][] = [];
  const name = 'managed-skill-recovery';
  vi.stubEnv('KODAX_MANAGED_RECOVERY_KEY', 'offline-fixture');
  class Provider extends KodaXBaseProvider {
    readonly name = name;
    readonly config = { apiKeyEnv: 'KODAX_MANAGED_RECOVERY_KEY', model: 'fixture',
      contextWindow: 8_192, maxOutputTokens: 1_000 };
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[]): Promise<KodaXStreamResult> {
      if (tools.length > 0) requests.push(messages);
      return { textBlocks: [{ type: 'text', text: tools.length > 0 ? 'Done.' : '[]' }],
        toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
    }
  }
  registerModelProvider(name, () => new Provider());
  const cache = createUserInputDegradationCache();
  const policy = vi.fn(() => false);
  const parameters: Parameters<typeof buildRunnerLlmAdapter> = [{
    provider: name, effort: 'none', context: { isPagedContentRecoveryAllowed: policy },
  }];
  parameters[4] = { current: undefined, contextWindow: 8_192 };
  parameters[11] = cache;
  const adapter = buildRunnerLlmAdapter(...parameters);
  const original = 'Complete original user evidence. '.repeat(4_000);
  try {
    await adapter([{ role: 'system', content: 'Inspect the evidence.' },
      { role: 'user', content: original }], {
      name: 'worker', instructions: 'Inspect', reasoning: { default: 'none', max: 'none' },
      tools: [{ name: 'read', description: 'Read stored text.',
        input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.some(message => message.content === original)).toBe(true);
    expect(cache.activePaths.size).toBe(0);
    expect(policy).toHaveBeenCalled();
  } finally { await cleanupUserInputDegradationCache(cache); }
});
