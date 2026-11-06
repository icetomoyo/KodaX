import { describe, expect, it } from 'vitest';
import { KodaXBaseProvider } from '@kodax-ai/llm';
import type { KodaXMessage, KodaXProviderConfig, KodaXProviderStreamOptions, KodaXReasoningRequest, KodaXStreamResult, KodaXToolDefinition } from '@kodax-ai/llm';
import { ContextCapacityError, exceedsContextCapacity } from '../../context-capacity.js';
import { countTokens, estimateTokens } from '../../tokenizer.js';
import { compact, COMPACTION_SUMMARY_PREFIX } from './compaction.js';
import { generateSummary } from './summary-generator.js';

class CapacityProvider extends KodaXBaseProvider {
  readonly name = 'summary-capacity-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    model: 'small-summary', apiKeyEnv: 'UNUSED', supportsThinking: false,
    contextWindow: 16_384, maxOutputTokens: 16_000,
  };
  readonly calls: Array<{ prompt: string; output: number | undefined; suffix?: string }> = [];
  failOnReduction = false;
  expandReduction = false;
  async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string,
    _reasoning?: boolean | KodaXReasoningRequest, options?: KodaXProviderStreamOptions): Promise<KodaXStreamResult> {
    const prompt = messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
    this.calls.push({ prompt, output: options?.maxOutputTokensOverride, suffix: options?.ephemeralSuffix?.content });
    if (this.failOnReduction && prompt.includes('<compaction-part')) throw new Error('late summary failure');
    const input = estimateTokens(messages) + countTokens(system) + countTokens(JSON.stringify(tools))
      + countTokens(options?.ephemeralSuffix?.content ?? '');
    if (exceedsContextCapacity({ contextWindow: 16_384, currentTokens: input,
      reservedResponseTokens: this.getEffectiveMaxOutputTokens(undefined, options?.maxOutputTokensOverride) })) {
      throw new Error('wire request overflow');
    }
    const summary = this.expandReduction && prompt.includes('<compaction-part') ? prompt : '## Goal\nFinish reviewing the document.\n## Evidence\n'
      + 'Exact preserved document fact. '.repeat(210)
      + '\n## Next Steps\nInspect the remaining sections and preserve exceptions.';
    return { textBlocks: [{ type: 'text', text: `<summary>${summary}</summary>` }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
  }
}

function documentHistory(): KodaXMessage[] {
  return Array.from({ length: 24 }, (_, index) => [
    { role: 'user' as const, content: `Review document section ${index}; preserve exception-${index}.` },
    { role: 'assistant' as const, content: 'Detailed document evidence. '.repeat(1100) },
  ]).flat();
}

describe('bounded summary requests', () => {
  it('sends a side-query output cap instead of the provider main-turn maximum', async () => {
    const provider = new CapacityProvider();
    await generateSummary([{ role: 'user', content: 'Review the document.' }], provider, { readFiles: [], modifiedFiles: [] });
    expect(provider.calls[0]?.output).toBeGreaterThan(0);
    expect(provider.calls[0]?.output).toBeLessThan(4000);
  });

  it('reduces many map summaries in bounded groups on a 16K model', async () => {
    const provider = new CapacityProvider();
    const messages = documentHistory();
    const original = structuredClone(messages);
    const result = await compact(messages, { enabled: true, triggerPercent: 75 }, provider,
      16_384, undefined, undefined, undefined, undefined, undefined, undefined, true, 16_000);
    expect(result.compacted).toBe(true);
    expect(result.report?.strategy).toBe('map_reduce');
    expect(provider.calls.filter(call => call.prompt.includes('<compaction-part')).length).toBeGreaterThan(1);
    expect(provider.calls.length).toBeLessThan(48);
    expect(messages).toEqual(original);
    expect(result.summary).toContain('exception-0');
  });

  it('includes the old checkpoint as a budgeted source and preserves it on a late failure', async () => {
    const provider = new CapacityProvider();
    provider.failOnReduction = true;
    const messages: KodaXMessage[] = [{ role: 'user', _synthetic: true, _source: 'compaction-checkpoint',
      content: COMPACTION_SUMMARY_PREFIX + 'Keep OLD-CONSTRAINT. '.repeat(700) }, ...documentHistory()];
    const original = structuredClone(messages);
    await expect(compact(messages, { enabled: true, triggerPercent: 75 }, provider,
      16_384, undefined, undefined, undefined, undefined, undefined, undefined, true)).rejects.toThrow('late summary failure');
    expect(provider.calls[0]?.prompt).toContain('OLD-CONSTRAINT');
    expect(messages).toEqual(original);
  });

  it('fails without a request or history mutation when an old checkpoint cannot fit alone', async () => {
    const provider = new CapacityProvider();
    const messages: KodaXMessage[] = [{ role: 'user', _synthetic: true, _source: 'compaction-checkpoint',
      content: COMPACTION_SUMMARY_PREFIX + 'Unshrinkable previous evidence. '.repeat(3000) }, ...documentHistory()];
    const original = structuredClone(messages);
    await expect(compact(messages, { enabled: true, triggerPercent: 75 }, provider,
      16_384, undefined, undefined, undefined, undefined, undefined, undefined, true)).rejects.toBeInstanceOf(ContextCapacityError);
    expect(provider.calls).toHaveLength(0);
    expect(messages).toEqual(original);
  });

  it('rejects an expanding reducer without looping or committing partial maps', async () => {
    const provider = new CapacityProvider();
    provider.expandReduction = true;
    const messages = documentHistory();
    const original = structuredClone(messages);
    await expect(compact(messages, { enabled: true, triggerPercent: 75 }, provider,
      16_384, undefined, undefined, undefined, undefined, undefined, undefined, true)).rejects.toThrow('no token progress');
    expect(provider.calls.filter(call => call.prompt.includes('<compaction-part'))).toHaveLength(1);
    expect(messages).toEqual(original);
  });

  it('uses the recoverable capacity operation when no pair of mapped summaries fits', async () => {
    const provider = new CapacityProvider();
    const messages = documentHistory().map(message => message.role === 'assistant'
      ? { ...message, content: 'Fact '.repeat(1600) } : message);
    const original = structuredClone(messages);
    await expect(compact(messages, { enabled: true, triggerPercent: 75 }, provider,
      16_384, undefined, 'Mandatory policy. '.repeat(1700), undefined, undefined,
      undefined, undefined, true)).rejects.toMatchObject({
        name: 'ContextCapacityError', operation: 'Compaction summary request',
      });
    expect(provider.calls.length).toBeGreaterThan(1);
    expect(provider.calls.some(call => call.prompt.includes('<compaction-part'))).toBe(false);
    expect(messages).toEqual(original);
  });

  it('falls back from cached tools that cannot fit the summary envelope', async () => {
    const provider = new CapacityProvider();
    const messages = documentHistory().slice(0, 2);
    await compact(messages, { enabled: true, triggerPercent: 15 }, provider,
      16_384, undefined, 'SYSTEM', undefined, undefined, undefined, undefined, true, 0,
      { tools: [{ name: 'huge_schema', description: 'A lengthy schema. '.repeat(5000), input_schema: { type: 'object', properties: {} } }] });
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(provider.calls.every(call => call.suffix === undefined)).toBe(true);
  });

  it('rejects an oversized specialist system before making a provider call', async () => {
    const provider = new CapacityProvider();
    await expect(generateSummary([{ role: 'user', content: 'Read.' }], provider,
      { readFiles: [], modifiedFiles: [] }, undefined, 'Mandatory instructions. '.repeat(4000)))
      .rejects.toBeInstanceOf(ContextCapacityError);
    expect(provider.calls).toHaveLength(0);
  });
});
