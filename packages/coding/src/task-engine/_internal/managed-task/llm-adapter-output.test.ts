import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXToolDefinition, type KodaXReasoningRequest,
  type KodaXProviderStreamOptions, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { buildRunnerLlmAdapter } from './llm-adapter.js';

afterEach(() => { clearRuntimeModelProviders(); vi.unstubAllEnvs(); });

async function generate(turns: readonly (readonly string[])[], abortAfterText = false, truncatedReason = 'max_tokens',
  inspectStreaming?: (text: string) => void) {
  let calls = 0;
  const controller = new AbortController();
  const visible: string[] = [];
  class Scripted extends KodaXBaseProvider {
    readonly name = 'output-text-contract';
    readonly supportsThinking = false;
    protected readonly config = {
      apiKeyEnv: 'KODAX_OUTPUT_TEXT_TEST_KEY', model: 'scripted', supportsThinking: false,
      reasoningCapability: 'prompt-only' as const, maxOutputTokens: 32000,
    };
    async stream(_messages: KodaXMessage[], _tools: KodaXToolDefinition[], _system: string,
      _reasoning?: boolean | KodaXReasoningRequest, options?: KodaXProviderStreamOptions): Promise<KodaXStreamResult> {
      const chunks = turns[calls++];
      if (!chunks) throw new Error('Unexpected extra provider request');
      for (const chunk of chunks) options?.onTextDelta?.(chunk);
      inspectStreaming?.(visible.join(''));
      if (abortAfterText) { controller.abort(); throw controller.signal.reason; }
      return { textBlocks: [{ type: 'text', text: chunks.join('') }], toolBlocks: [], thinkingBlocks: [],
        stopReason: calls < turns.length ? truncatedReason : 'end_turn' };
    }
  }
  vi.stubEnv('KODAX_OUTPUT_TEXT_TEST_KEY', 'scripted-test-key');
  vi.stubEnv('KODAX_MAX_OUTPUT_TOKENS', '32000');
  registerModelProvider('output-text-contract', () => new Scripted());
  const adapter = buildRunnerLlmAdapter({ provider: 'output-text-contract', abortSignal: controller.signal,
    context: { gitRoot: tmpdir(), executionCwd: tmpdir(), repoIntelligenceMode: 'off' },
    events: { onTextDelta: text => { visible.push(text); } } });
  try {
    const result = await adapter([{ role: 'user', content: 'Return the scripted answer.' }],
      { name: 'kodax/role/worker', instructions: '' });
    return { live: visible.join(''), final: result.text, calls };
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    return { live: visible.join(''), aborted: true, calls };
  }
}

describe('managed output text through the real provider adapter', () => {
  it('emits an ordinary identifier suffix before the provider finishes', async () => {
    const text = 'BEGIN_ACCEPT_HOLD_AMA';
    await generate([[text]], false, 'max_tokens', live => expect(live).toBe(text));
  });
  it.each(['MyAssigned native agent identity: example', 'MYTool policy: example'])
    ('preserves marker-like text inside an identifier at every chunk split: %s', async raw => {
      for (let split = 0; split <= raw.length; split++) {
        expect(await generate([[raw.slice(0, split), raw.slice(split)]]))
          .toEqual({ live: raw, final: raw, calls: 1 });
      }
    });
  it('preserves ordinary Markdown and whitespace in both live and committed output', async () => {
    const result = await generate([['  Report\n\n', '```\n', 'example\n', '```\n\n', 'End  ']]);
    expect(result).toEqual({ live: '  Report\n\n```\nexample\n```\n\nEnd  ',
      final: '  Report\n\n```\nexample\n```\n\nEnd  ', calls: 1 });
  });
  it.each([
    ['Answer\nTool policy: internal details', 'Answer\n'],
    ['MyTool policy: example\n- Tool policy: internal', 'MyTool policy: example\n- '],
    ['Answer\n```kodax-task-verdict\nstatus: accept\n```', 'Answer\n'],
    ['Example\n```kotlin\nval x = 1\n```\nTool pol', 'Example\n```kotlin\nval x = 1\n```\nTool pol'],
  ])('uses the same public text for every split of %s', async (raw, visible) => {
    for (let split = 0; split <= raw.length; split++) {
      const result = await generate([[raw.slice(0, split), raw.slice(split)]]);
      expect(result, `split at ${split}`).toEqual({ live: visible, final: visible, calls: 1 });
    }
  });
  it('continues one answer across physical requests without losing code-block newlines', async () => {
    expect(await generate([['First\n'], ['```js\n', 'example\n', '```\n', 'Last']])).toEqual({
      live: 'First\n```js\nexample\n```\nLast', final: 'First\n```js\nexample\n```\nLast', calls: 2,
    });
  });
  it('continues one answer when the provider reports OpenAI finish_reason=length', async () => {
    expect(await generate([['First\n'], ['```js\n', 'example\n', '```\n', 'Last']], false, 'length')).toEqual({
      live: 'First\n```js\nexample\n```\nLast', final: 'First\n```js\nexample\n```\nLast', calls: 2,
    });
  });
  it('keeps a split internal marker hidden across continuation requests', async () => {
    expect(await generate([['Answer\nTool pol'], ['icy: internal', ' details']])).toEqual({
      live: 'Answer\n', final: 'Answer\n', calls: 2,
    });
  });
  it('retains ordinary pending text when generation is interrupted before commit', async () => {
    expect(await generate([['Answer ', 'Tool pol']], true)).toEqual({
      live: 'Answer Tool pol', aborted: true, calls: 1,
    });
  });
});
