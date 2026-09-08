import { describe, expect, it, vi } from 'vitest';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXReasoningRequest,
  KodaXProviderStreamOptions,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import { KodaXBaseProvider } from '@kodax-ai/llm';
import type { CompactionRequestMetrics } from './types.js';
import { setKodaXDiagnosticSink } from '../../diagnostics.js';
import {
  buildCompactionPromptSnapshot,
  generateSummary,
} from './summary-generator.js';

class RecordingSummaryProvider extends KodaXBaseProvider {
  readonly name = 'recording-summary';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'FAKE_SUMMARY_API_KEY',
    model: 'recording-summary-model',
    supportsThinking: false,
    contextWindow: 200000,
  };

  public prompts: string[] = [];
  public systems: string[] = [];
  public modelOverrides: Array<string | undefined> = [];
  public messageBatches: KodaXMessage[][] = [];
  public toolBatches: KodaXToolDefinition[][] = [];
  public reasoningRequests: Array<boolean | KodaXReasoningRequest | undefined> = [];
  public ephemeralSuffixes: Array<string | undefined> = [];
  public promptCacheKeys: Array<string | undefined> = [];

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    thinking?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
  ): Promise<KodaXStreamResult> {
    const prompt = messages[0];
    this.prompts.push(
      typeof prompt?.content === 'string'
        ? prompt.content
        : JSON.stringify(prompt?.content),
    );
    this.systems.push(system);
    this.modelOverrides.push(streamOptions?.modelOverride);
    this.messageBatches.push(messages);
    this.toolBatches.push(tools);
    this.reasoningRequests.push(thinking);
    this.ephemeralSuffixes.push(streamOptions?.ephemeralSuffix?.content);
    this.promptCacheKeys.push(streamOptions?.promptCacheKey);

    return {
      textBlocks: [{ type: 'text', text: '## Goal\nContinue safely.' }],
      toolBlocks: [],
      thinkingBlocks: [],
    };
  }
}

describe('buildCompactionPromptSnapshot', () => {
  it('builds a specialist prompt snapshot with ordered sections and provenance', () => {
    const snapshot = buildCompactionPromptSnapshot({
      messages: [{ role: 'user', content: 'continue the work' }],
      details: {
        readFiles: ['a.ts'],
        modifiedFiles: ['b.ts'],
      },
      customInstructions: 'Focus on risks',
      previousSummary: 'Previous summary',
      systemPrompt: 'CUSTOM SYSTEM',
    });

    expect(snapshot.variant).toBe('update-summary');
    expect(snapshot.systemPrompt).toBe('CUSTOM SYSTEM');
    expect(snapshot.hash).toHaveLength(64);
    expect(
      snapshot.sections.map(({ id, slot, feature, order }) => ({
        id,
        slot,
        feature,
        order,
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "feature": "FEATURE_050",
          "id": "conversation",
          "order": 100,
          "slot": "conversation",
        },
        {
          "feature": "FEATURE_050",
          "id": "previous-summary",
          "order": 200,
          "slot": "history",
        },
        {
          "feature": "FEATURE_044",
          "id": "update-instructions",
          "order": 300,
          "slot": "instructions",
        },
        {
          "feature": "FEATURE_050",
          "id": "custom-instructions",
          "order": 350,
          "slot": "instructions",
        },
        {
          "feature": "FEATURE_044",
          "id": "file-tracking",
          "order": 400,
          "slot": "tracking",
        },
      ]
    `);
    expect(snapshot.userPrompt).toContain('<conversation>');
    expect(snapshot.userPrompt).toContain('<previous-summary>');
    expect(snapshot.userPrompt).toContain('Additional instructions: Focus on risks');
    expect(snapshot.userPrompt).toContain('Read files: a.ts');
    expect(snapshot.userPrompt).toContain('Modified files: b.ts');
  });

  it('generateSummary uses the specialist prompt snapshot output', async () => {
    const provider = new RecordingSummaryProvider();
    const args = {
      messages: [{ role: 'user' as const, content: 'continue the work' }],
      details: {
        readFiles: ['a.ts'],
        modifiedFiles: ['b.ts'],
      },
      customInstructions: 'Focus on risks',
      systemPrompt: 'CUSTOM SYSTEM',
      previousSummary: 'Previous summary',
    };
    const snapshot = buildCompactionPromptSnapshot(args);

    await generateSummary(
      args.messages,
      provider,
      args.details,
      args.customInstructions,
      args.systemPrompt,
      args.previousSummary,
    );

    expect(provider.systems[0]).toBe(snapshot.systemPrompt);
    expect(provider.prompts[0]).toBe(snapshot.userPrompt);
  });

  it('generateSummary forwards the active model override', async () => {
    const provider = new RecordingSummaryProvider();

    await generateSummary(
      [{ role: 'user', content: 'continue the work' }],
      provider,
      { readFiles: [], modifiedFiles: [] },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'active-model',
    );

    expect(provider.modelOverrides[0]).toBe('active-model');
  });

  it('reuses the exact main-request prefix through an ephemeral summary suffix', async () => {
    const provider = new RecordingSummaryProvider();
    const onRequest = vi.fn();
    const onResponse = vi.fn();
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'first response' },
    ];
    const tools: KodaXToolDefinition[] = [{
      name: 'read',
      description: 'Read a file',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    }];
    const reasoning: KodaXReasoningRequest = { effort: 'high' };

    await generateSummary(
      messages,
      provider,
      { readFiles: [], modifiedFiles: [] },
      undefined,
      'MAIN SYSTEM',
      undefined,
      undefined,
      undefined,
      'active-model',
      {
        tools,
        reasoning,
        protectedTailMessageCount: 1,
        observer: { onRequest, onResponse },
      },
      undefined,
      { promptCacheKey: 'e'.repeat(64) },
    );

    expect(provider.messageBatches[0]).toEqual(messages);
    expect(provider.toolBatches[0]).toEqual(tools);
    expect(provider.systems[0]).toBe('MAIN SYSTEM');
    expect(provider.reasoningRequests[0]).toBe(false);
    expect(provider.ephemeralSuffixes[0]).toContain('TEXT ONLY');
    expect(provider.promptCacheKeys[0]).toBe('e'.repeat(64));
    expect(provider.ephemeralSuffixes[0]).toContain('final 1 message');
    expect(provider.ephemeralSuffixes[0]).not.toContain('<conversation>');
    expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({
      messages,
      tools,
      system: 'MAIN SYSTEM',
      reasoning: false,
      promptCacheKey: 'e'.repeat(64),
      ephemeralSuffix: expect.objectContaining({ content: expect.stringContaining('TEXT ONLY') }),
    }));
    expect(onResponse).toHaveBeenCalledWith(
      expect.objectContaining({ messages }),
      undefined,
    );
  });

  it('applies explicit summary reasoning independently of the cache envelope', async () => {
    const provider = new RecordingSummaryProvider();
    for (const cache of [undefined, { tools: [], reasoning: { effort: 'xhigh' } }]) {
      await generateSummary([{ role: 'user', content: 'continue' }], provider,
        { readFiles: [], modifiedFiles: [] }, undefined, 'SYSTEM', undefined,
        undefined, undefined, undefined, cache, undefined,
        { reasoning: { effort: 'low' } });
    }
    expect(provider.reasoningRequests).toEqual([{ effort: 'low' }, { effort: 'low' }]);
  });

  it('reports actual usage, first output and retries without exposing summary text', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const provider = new RecordingSummaryProvider();
    const onMetrics = vi.fn();
    vi.spyOn(provider, 'stream').mockImplementation(async (_messages, _tools, _system,
      _reasoning, options) => {
      now.mockReturnValue(10);
      options?.onThinkingDelta?.('private reasoning');
      options?.onRateLimit?.(1, 3, 20);
      now.mockReturnValue(70);
      options?.onTextDelta?.('summary');
      return { textBlocks: [{ type: 'text', text: 'summary' }], toolBlocks: [],
        thinkingBlocks: [], usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200,
          cachedReadTokens: 800 }, stopReason: 'stop' };
    });
    try {
      await generateSummary([{ role: 'user', content: 'continue' }], provider,
        { readFiles: [], modifiedFiles: [] }, undefined, undefined, undefined,
        undefined, undefined, 'actual-model', undefined, { onMetrics });
      expect(onMetrics).toHaveBeenCalledWith(expect.objectContaining({
        provider: provider.name, model: 'actual-model', reasoning: false,
        providerMs: 70, firstDeltaMs: 10, retryCount: 1, retryWaitMs: 20,
        usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cachedReadTokens: 800 },
        stopReason: 'stop', outcome: 'succeeded',
      }));
      expect(JSON.stringify(onMetrics.mock.calls)).not.toContain('private reasoning');
    } finally { now.mockRestore(); }
  });

  it('uses a supported low effort by default when the model cannot disable thinking', async () => {
    const provider = new RecordingSummaryProvider();
    vi.spyOn(provider, 'getReasoningProfile').mockReturnValue({
      effortStrategy: 'openai-chat-effort', supportsDisabledThinking: false,
      localRejectEfforts: ['none'], defaultEffort: 'high',
      supportedEfforts: [{ value: 'low' }, { value: 'high', isDefault: true }],
    });
    await generateSummary([{ role: 'user', content: 'continue' }], provider,
      { readFiles: [], modifiedFiles: [] });
    expect(provider.reasoningRequests).toEqual([{ effort: 'low' }]);
  });

  it('preserves a provider failure when a metrics observer also throws', async () => {
    const provider = new RecordingSummaryProvider();
    const failure = new Error('provider unavailable');
    vi.spyOn(provider, 'stream').mockRejectedValue(failure);
    const onMetrics = vi.fn((_metrics: CompactionRequestMetrics) => { throw new Error('observer failure'); });
    const diagnostic = vi.fn();
    const restore = setKodaXDiagnosticSink(diagnostic);
    try {
      await expect(generateSummary([{ role: 'user', content: 'continue' }], provider,
        { readFiles: [], modifiedFiles: [] }, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, { onMetrics })).rejects.toBe(failure);
      expect(onMetrics).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
      expect(onMetrics.mock.calls[0]?.[0]).not.toHaveProperty('firstDeltaMs');
      expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({
        level: 'warn', message: 'Compaction metrics observer failed',
      }));
    } finally { restore(); }
  });

  it('rejects tool use even when the provider also returns text', async () => {
    class ToolUsingProvider extends RecordingSummaryProvider {
      override async stream(): Promise<KodaXStreamResult> {
        return {
          textBlocks: [{ type: 'text', text: 'A plausible summary' }],
          toolBlocks: [{ type: 'tool_use', id: 'tool-1', name: 'read', input: {} }],
          thinkingBlocks: [],
        };
      }
    }

    await expect(generateSummary(
      [{ role: 'user', content: 'continue' }],
      new ToolUsingProvider(),
      { readFiles: [], modifiedFiles: [] },
    )).rejects.toThrow(/tool_use/i);
  });

  it('generateSummary throws when the provider returns no usable text', async () => {
    class EmptyTextProvider extends KodaXBaseProvider {
      readonly name = 'empty-summary';
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'FAKE_SUMMARY_API_KEY',
        model: 'empty-summary-model',
        supportsThinking: false,
        contextWindow: 200000,
      };

      async stream(): Promise<KodaXStreamResult> {
        // Simulate provider returning only whitespace / analysis block — the
        // case where a tool-calling-heavy model emits no real summary text.
        return {
          textBlocks: [{ type: 'text', text: '<analysis>thinking only</analysis>' }],
          toolBlocks: [],
          thinkingBlocks: [],
        };
      }
    }

    const provider = new EmptyTextProvider();

    await expect(
      generateSummary(
        [{ role: 'user', content: 'continue' }],
        provider,
        { readFiles: [], modifiedFiles: [] },
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/did not contain valid text/i);
  });
});
