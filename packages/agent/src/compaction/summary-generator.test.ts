import { describe, expect, it } from 'vitest';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax/ai';
import { KodaXBaseProvider } from '@kodax/ai';
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

  async stream(
    messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    system: string,
    _thinking?: boolean,
    _streamOptions?: KodaXProviderStreamOptions,
  ): Promise<KodaXStreamResult> {
    const prompt = messages[0];
    this.prompts.push(
      typeof prompt?.content === 'string'
        ? prompt.content
        : JSON.stringify(prompt?.content),
    );
    this.systems.push(system);

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
