/**
 * Issue 441 — replayed reasoning never becomes reply text.
 *
 * One mixed-source history goes through every serializer. Readable reasoning
 * from another model may only reach the target's own reasoning channel, opaque
 * reasoning data only replays to its source, no '...' thinking is invented,
 * and a polluted leading `<prior_reasoning>` segment in assistant text is
 * stripped on replay.
 */
import { describe, expect, it, vi } from 'vitest';
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import { KodaXOpenAICompatProvider } from './openai.js';
import { projectResponsesMessages } from './responses-messages.js';
import { projectBedrockMessages } from './bedrock-messages.js';
import { projectGoogleMessages } from './google-messages.js';
import { projectMistralMessages } from './mistral-messages.js';
import { projectPiMessages } from './pi-messages-history.js';
import type { KodaXGenerationSource, KodaXMessage, KodaXProviderConfig } from '../types.js';

const FOREIGN_SOURCE: KodaXGenerationSource = {
  provider: 'zhipu-coding', api: 'anthropic-messages', model: 'glm-5.3', baseUrl: 'https://open.bigmodel.cn/api/anthropic',
};
const FOREIGN_REASONING = 'FOREIGN_REASONING_TEXT';
const FOREIGN_SIGNATURE = 'FOREIGN_SIGNATURE_VALUE';
const GATEWAY_REASONING = 'GATEWAY_REASONING_TEXT';
const GATEWAY_DETAIL = 'GATEWAY_DETAIL_VALUE';
const POLLUTED = 'POLLUTED_REASONING_TEXT';
const ANSWER = 'The code is 7319.';

/** A session that switched models twice and already holds one polluted reply. */
const HISTORY: KodaXMessage[] = [
  { role: 'user', content: 'Find the code for alpha.' },
  { role: 'assistant', content: [
    { type: 'thinking', thinking: FOREIGN_REASONING, signature: FOREIGN_SIGNATURE, source: FOREIGN_SOURCE },
    { type: 'tool_use', id: 'call_1', name: 'lookup', input: { item: 'alpha' } },
  ] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'alpha => 7319' }] },
  { role: 'assistant', content: [{ type: 'text', text: `<prior_reasoning>\n${POLLUTED}\n</prior_reasoning>\n\n${ANSWER}` }] },
  { role: 'user', content: 'Now beta.' },
  { role: 'assistant', content: [
    { type: 'thinking', thinking: GATEWAY_REASONING, openaiReasoning: {
      provider: 'openrouter', model: 'qwen/qwen3.8-flash', baseUrl: 'https://openrouter.ai/api/v1',
      details: [{ type: 'reasoning.text', text: GATEWAY_REASONING, signature: GATEWAY_DETAIL }],
    } },
    { type: 'tool_use', id: 'call_2', name: 'lookup', input: { item: 'beta' } },
  ] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_2', content: 'beta => 1150' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'call_3', name: 'lookup', input: { item: 'gamma' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_3', content: 'gamma => 42' }] },
];

/** Every string the model reads as reply/message text, i.e. not a reasoning or tool-argument field. */
function visibleTexts(value: unknown, key = ''): string[] {
  if (typeof value === 'string') return ['text', 'content'].includes(key) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(item => visibleTexts(item, key));
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  // Google marks reasoning parts with thought: true; Mistral nests reasoning under a thinking block.
  if (record.thought === true || record.type === 'thinking') return [];
  return Object.entries(record).flatMap(([k, v]) => visibleTexts(v, k));
}

function expectReplayInvariants(wire: unknown, options: { readableReasoning: boolean; pairsById?: boolean }): void {
  const json = JSON.stringify(wire);
  const visible = visibleTexts(wire).join('\n');
  expect(visible).not.toContain(FOREIGN_REASONING);
  expect(visible).not.toContain(GATEWAY_REASONING);
  expect(visible).not.toContain('<prior_reasoning>');
  expect(json).not.toContain(POLLUTED);
  expect(json).toContain(ANSWER);
  expect(json).not.toContain(FOREIGN_SIGNATURE);
  expect(json).not.toContain(GATEWAY_DETAIL);
  expect(json).not.toMatch(/"thinking":"\.\.\."/);
  expect(json.includes(FOREIGN_REASONING)).toBe(options.readableReasoning);
  // Some targets re-key or textualize tool calls; their pairing is covered by their own tests.
  if (options.pairsById === false) return;
  for (const id of ['call_1', 'call_2', 'call_3']) expect(json.split(id).length).toBeGreaterThanOrEqual(3);
}

function emptyAnthropicStream(): AsyncIterable<unknown> {
  return (async function* () { yield { type: 'message_start' }; yield { type: 'message_stop' }; })();
}

function anthropicProvider(name: string, config: Partial<KodaXProviderConfig>) {
  const create = vi.fn().mockImplementation(() => Promise.resolve(emptyAnthropicStream()));
  const provider = new (class extends KodaXAnthropicCompatProvider {
    readonly name = name;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'TEST_API_KEY', model: 'test-model', supportsThinking: true, ...config };
    constructor() { super(); this.client = { messages: { create } } as never; }
    protected override getApiKey(): string { return 'test-key'; }
  })();
  return { provider, create };
}

async function anthropicWire(name: string, config: Partial<KodaXProviderConfig>): Promise<unknown> {
  const { provider, create } = anthropicProvider(name, config);
  await provider.stream(HISTORY, [], 'system', { enabled: true });
  return (create.mock.calls[0]?.[0] as { messages: unknown }).messages;
}

async function openAIWire(replayReasoningContent: boolean, history: KodaXMessage[] = HISTORY): Promise<unknown> {
  async function* chunks() { yield { choices: [{ delta: {}, finish_reason: 'stop' }] }; }
  const create = vi.fn().mockImplementation(() => Promise.resolve(chunks()));
  const provider = new (class extends KodaXOpenAICompatProvider {
    readonly name = 'test-openai';
    protected readonly config: KodaXProviderConfig = {
      apiKeyEnv: 'TEST_API_KEY', model: 'test-model', supportsThinking: true, replayReasoningContent,
    };
    constructor() { super(); this.client = { chat: { completions: { create } } } as never; }
    protected override getApiKey(): string { return 'test-key'; }
  })();
  await provider.stream(history, [], 'system', { enabled: true });
  return (create.mock.calls[0]?.[0] as { messages: unknown }).messages;
}

function cloudSource(api: KodaXGenerationSource['api']): KodaXGenerationSource {
  return { provider: 'target', api, model: 'target-model' };
}

describe('replayed reasoning never becomes reply text (Issue 441)', () => {
  it('lenient Anthropic-compatible targets receive foreign reasoning as unsigned thinking', async () => {
    const wire = await anthropicWire('kimi-code', {});
    expectReplayInvariants(wire, { readableReasoning: true });
    expect(JSON.stringify(wire)).toContain(JSON.stringify({ type: 'thinking', thinking: FOREIGN_REASONING, signature: '' }));
  });

  it('lenient Anthropic-compatible targets give a tool turn without reasoning an empty thinking block', async () => {
    // DeepSeek rejects an in-loop tool turn without thinking; an empty block carries nothing to imitate.
    const wire = await anthropicWire('kimi-code', {}) as { role: string; content: { type: string }[] }[];
    const gammaTurn = wire.find(m => m.role === 'assistant' && JSON.stringify(m).includes('call_3'));
    expect(gammaTurn?.content[0]).toEqual({ type: 'thinking', thinking: '', signature: '' });
  });

  it('strict Anthropic targets drop foreign reasoning', async () => {
    const wire = await anthropicWire('strict-anthropic', { strictThinkingSignature: true });
    expectReplayInvariants(wire, { readableReasoning: false });
    expect(JSON.stringify(wire)).not.toContain('"type":"thinking"');
  });

  it("replays '...'-only reasoning as empty on lenient channels", async () => {
    // A polluted session stores the model's own '...' thinking.
    const { provider, create } = anthropicProvider('kimi-code', {});
    const history: KodaXMessage[] = [
      { role: 'user', content: 'Find alpha.' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: '...', signature: '', source: provider.getGenerationSource() },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { item: 'alpha' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'alpha => 7319' }] },
    ];
    await provider.stream(history, [], 'system', { enabled: true });
    const anthropic = JSON.stringify((create.mock.calls[0]?.[0] as { messages: unknown }).messages);
    expect(anthropic).toContain(JSON.stringify({ type: 'thinking', thinking: '', signature: '' }));
    expect(anthropic).not.toContain('"thinking":"..."');
    const openai = JSON.stringify(await openAIWire(true, history));
    expect(openai).toContain('"reasoning_content":""');
    expect(openai).not.toContain('"reasoning_content":"..."');
  });

  it('native Claude history drops foreign reasoning', async () => {
    const wire = await anthropicWire('anthropic', { model: 'claude-opus-5-5', strictThinkingSignature: true });
    expectReplayInvariants(wire, { readableReasoning: false });
  });

  it('OpenAI-compatible targets carry readable reasoning only in reasoning_content', async () => {
    const wire = await openAIWire(true);
    expectReplayInvariants(wire, { readableReasoning: true });
    expect(JSON.stringify(wire)).toContain(`"reasoning_content":"${FOREIGN_REASONING}"`);
  });

  it('OpenAI-compatible targets without a reasoning channel drop it', async () => {
    expectReplayInvariants(await openAIWire(false), { readableReasoning: false });
  });

  it('Responses, Bedrock, Google, Mistral and pi targets drop foreign reasoning', async () => {
    expectReplayInvariants(projectResponsesMessages(HISTORY, cloudSource('openai-responses'), () => []), { readableReasoning: false });
    expectReplayInvariants(await projectBedrockMessages(HISTORY, cloudSource('bedrock-converse'), false), { readableReasoning: false });
    // Mistral re-keys call ids to its 9-character format.
    expectReplayInvariants(await projectMistralMessages(HISTORY, cloudSource('mistral-chat'), false), { readableReasoning: false, pairsById: false });
    expectReplayInvariants(await projectGoogleMessages(HISTORY, cloudSource('google-generate-content')), { readableReasoning: false, pairsById: false });
    expectReplayInvariants(await projectPiMessages(HISTORY, cloudSource('pi-messages'), false), { readableReasoning: false });
  });

  it('drops empty text beside other content, which Kimi rejects as empty', async () => {
    const history: KodaXMessage[] = [
      { role: 'user', content: 'Find the code for alpha.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { item: 'alpha' } }, { type: 'text', text: '' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'alpha => 7319' }] },
    ];
    const { provider, create } = anthropicProvider('kimi-code', {});
    await provider.stream(history, [], 'system', { enabled: true });
    const assistant = (create.mock.calls[0]?.[0] as { messages: { content: { type: string; text?: string }[] }[] }).messages[1]!;
    expect(assistant.content.filter(b => b.type === 'text')).toEqual([]);
    expect(assistant.content.some(b => b.type === 'tool_use')).toBe(true);
  });

  it('keeps a <prior_reasoning> tag that is not at the start of the reply', async () => {
    const quoted = 'Use the <prior_reasoning> tag carefully.';
    const history: KodaXMessage[] = [
      { role: 'user', content: 'Explain the tag.' },
      { role: 'assistant', content: [{ type: 'text', text: quoted }] },
      { role: 'user', content: 'Thanks.' },
    ];
    const { provider, create } = anthropicProvider('kimi-code', {});
    await provider.stream(history, [], 'system');
    expect(JSON.stringify(create.mock.calls[0]?.[0])).toContain(quoted);
  });
});
