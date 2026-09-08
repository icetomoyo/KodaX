import { afterEach, expect, it, vi } from 'vitest';
import { KodaXBaseProvider, type KodaXProviderConfig, type KodaXMessage,
  type KodaXReasoningRequest, type KodaXProviderStreamOptions,
  type KodaXToolDefinition } from '@kodax-ai/llm';
import { resolveProvider } from '@kodax-ai/coding';
import { compact } from '@kodax-ai/agent';
import { compactSession } from './compact-session.js';
import { FileSessionStorage } from '../interactive/storage.js';

vi.mock('@kodax-ai/coding', async (original) => ({
  ...await original<typeof import('@kodax-ai/coding')>(), resolveProvider: vi.fn(),
}));
vi.mock('../common/compaction-config.js', () => ({
  loadCompactionConfig: async () => ({ enabled: true, triggerPercent: 75 }),
}));

afterEach(() => vi.restoreAllMocks());

class RecordingProvider extends KodaXBaseProvider {
  readonly name = 'compaction-parity';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'COMPACTION_PARITY_UNUSED', model: 'provider-default',
    supportsThinking: false, contextWindow: 8_000, maxOutputTokens: 512,
  };
  requests: { reasoning?: boolean | KodaXReasoningRequest;
    options?: KodaXProviderStreamOptions; messages: KodaXMessage[] }[] = [];
  async stream(messages: KodaXMessage[], _tools: KodaXToolDefinition[],
    _system: string, reasoning?: boolean | KodaXReasoningRequest,
    options?: KodaXProviderStreamOptions) {
    this.requests.push({ messages, reasoning, options });
    return { textBlocks: [{ type: 'text' as const, text:
      '## Goal\nContinue implementing the requested changes, preserve all user constraints, verify the relevant behavior and report outstanding work.' }],
      toolBlocks: [], thinkingBlocks: [] };
  }
}

function setup() {
  const provider = new RecordingProvider();
  vi.mocked(resolveProvider).mockReturnValue(provider);
  const storage = new FileSessionStorage();
  vi.spyOn(storage, 'load').mockResolvedValue({
    messages: [{ role: 'user', content: 'Keep the behavior correct.' },
      { role: 'assistant', content: 'Original historical evidence. '.repeat(150) },
      { role: 'user', content: 'Continue.' }],
    title: 'Parity', gitRoot: '',
    runtimeInfo: { provider: provider.name, model: 'session-model', reasoningMode: 'xhigh' },
  });
  const save = vi.spyOn(storage, 'save').mockResolvedValue(undefined);
  return { provider, storage, save };
}

it('records manual lineage even when the shared core supplies the anchor', async () => {
  const { storage, save } = setup();
  const result = await compactSession('parity', { storage, contextWindow: 8_000, triggerPercent: 15 });
  expect(result.compacted, result.reason).toBe(true);
  expect(result.report?.summaryRequests).toEqual([expect.objectContaining({
    provider: 'compaction-parity', model: 'session-model', reasoning: false, outcome: 'succeeded',
  })]);
  expect(result.report?.commitMs).toBeGreaterThanOrEqual(0);
  const anchor = save.mock.calls[0]?.[1].lineage?.entries.find(entry => entry.type === 'compaction');
  expect(anchor?.type === 'compaction' && anchor.reason).toBe('manual');
});

it('inherits the saved model only while using the saved provider', async () => {
  const { storage, provider } = setup();
  await compactSession('parity', { storage, contextWindow: 8_000, triggerPercent: 15 });
  expect(provider.requests[0]?.options?.modelOverride).toBe('session-model');
  await compactSession('parity', { storage, provider: 'different-provider',
    contextWindow: 8_000, triggerPercent: 15 });
  expect(provider.requests[1]?.options?.modelOverride).toBeUndefined();
  await compactSession('parity', { storage, model: 'explicit-model',
    contextWindow: 8_000, triggerPercent: 15 });
  expect(provider.requests[2]?.options?.modelOverride).toBe('explicit-model');
});

it('uses the same summary reasoning with and without an automatic cache context', async () => {
  const { storage, provider } = setup();
  const data = await storage.load('parity');
  for (const cache of [undefined, { tools: [], reasoning: { effort: 'xhigh' } }]) {
    const result = await compact(data!.messages,
      { enabled: true, triggerPercent: 15, reasoning: { effort: 'low' } },
      provider, 8_000, undefined, 'SYSTEM', undefined, undefined, undefined,
      undefined, true, 512, cache);
    expect(result.compacted).toBe(true);
  }
  expect(provider.requests.map(request => request.reasoning)).toEqual([
    { effort: 'low' }, { effort: 'low' },
  ]);
});
