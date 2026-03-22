import { describe, it, expect } from 'vitest';
import type {
  KodaXContentBlock,
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXToolResultBlock,
} from '@kodax/ai';
import { KodaXBaseProvider } from '@kodax/ai';
import { compact, needsCompaction } from './compaction.js';
import { generateSummary } from './summary-generator.js';

class FakeSummaryProvider extends KodaXBaseProvider {
  readonly name = 'fake-summary';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'FAKE_SUMMARY_API_KEY',
    model: 'fake-summary-model',
    supportsThinking: false,
    contextWindow: 200000,
  };

  public prompts: string[] = [];
  public systems: string[] = [];
  public callCount = 0;

  constructor(
    private readonly summaryText: string = [
    '## Goal',
    'Continue the current task.',
    '',
    '## Constraints & Preferences',
    '- None',
    '',
    '## Progress',
    '### Completed',
    '- [x] Captured the important history',
    '',
    '### In Progress',
    '- [ ] Continue implementation',
    '',
    '### Blockers',
    '- None',
    '',
    '## Key Decisions',
    '- **Compaction**: Keep the summary concise',
    '',
    '## Next Steps',
    '1. Continue from the latest code state',
    '',
    '## Key Context',
    '- packages/agent/src/compaction/compaction.ts',
  ].join('\n'),
    private readonly failOnCall?: number,
  ) {
    super();
  }

  async stream(
    messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    system: string,
    _thinking?: boolean,
    _streamOptions?: KodaXProviderStreamOptions
  ): Promise<KodaXStreamResult> {
    this.callCount += 1;
    if (this.failOnCall && this.callCount === this.failOnCall) {
      throw new Error('summary failed');
    }

    const prompt = messages[0];
    this.prompts.push(typeof prompt?.content === 'string' ? prompt.content : JSON.stringify(prompt?.content));
    this.systems.push(system);

    return {
      textBlocks: [{ type: 'text', text: this.summaryText }],
      toolBlocks: [],
      thinkingBlocks: [],
    };
  }
}

function makeLongText(word: string, count: number): string {
  return Array.from({ length: count }, () => word).join(' ');
}

function buildLongConversation(turns: number, wordsPerMessage: number): KodaXMessage[] {
  return Array.from({ length: turns * 2 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: makeLongText(index % 2 === 0 ? 'user' : 'assistant', wordsPerMessage),
  }));
}

function buildToolPair(index: number, outputWords: number): KodaXMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: `tool-${index}`,
          name: 'bash',
          input: { command: `cat output-${index}.txt` },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `tool-${index}`,
          content: makeLongText('x', outputWords),
        },
      ],
    },
  ];
}

describe('compaction', () => {
  it('compacts down to the internal low-water mark and avoids immediate re-compaction', async () => {
    const provider = new FakeSummaryProvider();
    const contextWindow = 4000;
    const config = {
      enabled: true,
      triggerPercent: 60,
      protectionPercent: 20,
      rollingSummaryPercent: 10,
      pruningThresholdTokens: 500,
    };

    const messages = buildLongConversation(10, 220);
    const result = await compact(messages, config, provider, contextWindow);

    const targetTokens = Math.floor(
      contextWindow * ((config.protectionPercent + 0.4 * (config.triggerPercent - config.protectionPercent)) / 100)
    );

    expect(result.compacted).toBe(true);
    expect(result.tokensBefore).toBeGreaterThan(contextWindow * (config.triggerPercent / 100));
    expect(result.tokensAfter).toBeLessThanOrEqual(targetTokens);

    const modestGrowth = [
      ...result.messages,
      { role: 'user' as const, content: makeLongText('follow-up', 40) },
      { role: 'assistant' as const, content: makeLongText('reply', 40) },
    ];
    expect(needsCompaction(modestGrowth, config, contextWindow)).toBe(false);

    const largeGrowth = [
      ...result.messages,
      ...buildLongConversation(4, 220),
    ];
    expect(needsCompaction(largeGrowth, config, contextWindow)).toBe(true);
  });

  it('prunes older tool results while keeping recent tool context and normal messages', async () => {
    const provider = new FakeSummaryProvider();
    const contextWindow = 120000;
    const config = {
      enabled: true,
      triggerPercent: 70,
      protectionPercent: 1,
      rollingSummaryPercent: 10,
      pruningThresholdTokens: 50000,
    };

    const messages: KodaXMessage[] = [
      { role: 'assistant', content: 'retain assistant note' },
      ...buildToolPair(1, 6500),
      ...buildToolPair(2, 6500),
      ...buildToolPair(3, 6500),
      ...buildToolPair(4, 6500),
      ...buildToolPair(5, 6500),
      ...buildToolPair(6, 6500),
      ...buildToolPair(7, 6500),
      ...buildToolPair(8, 6500),
      ...buildToolPair(9, 6500),
      ...buildToolPair(10, 6500),
      ...buildToolPair(11, 6500),
      ...buildToolPair(12, 6500),
      ...buildToolPair(13, 6500),
      ...buildToolPair(14, 6500),
    ];

    const result = await compact(messages, config, provider, contextWindow);
    const toolResults = result.messages
      .filter((msg): msg is KodaXMessage & { role: 'user'; content: NonNullable<KodaXMessage['content']> } =>
        msg.role === 'user' && Array.isArray(msg.content)
      )
      .flatMap(msg => msg.content as KodaXContentBlock[])
      .filter((block): block is KodaXToolResultBlock => block.type === 'tool_result');

    expect(result.compacted).toBe(true);
    expect(toolResults.some(block => typeof block.content === 'string' && block.content.startsWith('[Pruned: bash cat]'))).toBe(true);
    expect(toolResults.some(block => typeof block.content === 'string' && block.content.startsWith('x x x x'))).toBe(true);
    expect(result.messages.some(msg => msg.role === 'assistant' && msg.content === 'retain assistant note')).toBe(true);
  });

  it('keeps partial summary progress when a later summary attempt fails', async () => {
    const provider = new FakeSummaryProvider('partial summary', 2);
    const contextWindow = 200000;
    const config = {
      enabled: true,
      triggerPercent: 10,
      protectionPercent: 0,
      rollingSummaryPercent: 100,
      pruningThresholdTokens: 50000,
    };

    const messages = buildLongConversation(3, 30000);
    const result = await compact(messages, config, provider, contextWindow);

    expect(provider.callCount).toBe(2);
    expect(result.compacted).toBe(true);
    expect(result.summary).toBe('partial summary');
    expect(result.entriesRemoved).toBeGreaterThan(0);
    expect(result.messages[0]).toEqual({
      role: 'system',
      content: '[对话历史摘要]\n\npartial summary',
    });
  });
});

describe('summary generator', () => {
  it('uses continuation-focused update instructions instead of preserving all history', async () => {
    const provider = new FakeSummaryProvider('summary');

    await generateSummary(
      [{ role: 'user', content: 'continue the work' }],
      provider,
      { readFiles: ['a.ts'], modifiedFiles: ['b.ts'] },
      'Focus on risks',
      'CUSTOM SYSTEM',
      'Previous summary'
    );

    expect(provider.systems[0]).toBe('CUSTOM SYSTEM');
    expect(provider.prompts[0]).toContain('Keep only the information needed to continue the work.');
    expect(provider.prompts[0]).toContain('You may remove:');
    expect(provider.prompts[0]).toContain('Additional instructions: Focus on risks');
    expect(provider.prompts[0]).not.toContain('Preserve all existing information');
  });
});
