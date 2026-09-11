import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createCustomProvider, KODAX_PROVIDERS, KodaXAnthropicCompatProvider,
  KodaXOpenAICompatProvider, runWithScopedConfig,
  type KodaXBaseProvider, type KodaXMessage,
} from '@kodax-ai/llm';
import { hashProviderVisibleMessages } from './prompt-cache-diagnostics.js';

const providers = [
  ...Object.entries(KODAX_PROVIDERS).filter(([, factory]) => {
    const provider = factory();
    return provider instanceof KodaXAnthropicCompatProvider || provider instanceof KodaXOpenAICompatProvider;
  }),
  ...(['anthropic', 'openai'] as const).map((protocol) => [
    `custom-${protocol}`, () => createCustomProvider({
      name: `custom-${protocol}`, protocol, model: 'test-model',
      baseUrl: 'https://provider.invalid', apiKeyEnv: 'UNUSED_TEST_KEY',
    }),
  ] as const),
];

async function captureMessages(provider: KodaXBaseProvider, messages: KodaXMessage[], method: 'stream' | 'complete') {
  const anthropic = provider instanceof KodaXAnthropicCompatProvider;
  const create = vi.fn(async (request: { messages: { role: string }[]; stream?: boolean }) => {
    if (request.stream) return (async function* () {
      if (anthropic) {
        yield { type: 'message_start' };
        yield { type: 'message_stop' };
      } else yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    })();
    return anthropic
      ? { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }
      : { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
  });
  Reflect.set(provider, '_client', anthropic
    ? { messages: { create } } : { chat: { completions: { create } } });
  await runWithScopedConfig({ disablePromptCache: true }, () => provider[method](messages, [], 'system'));
  expect(create).toHaveBeenCalledOnce();
  // System is hashed separately by normalizeDiagnosticEnvelope; cache controls
  // are disabled above, so this is the actual message body without projection.
  return create.mock.calls[0]![0].messages.filter((message) => message.role !== 'system');
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const call = (id: string) => ({ type: 'tool_use' as const, id, name: 'read', input: { path: id } });
const result = (id: string, content = `result:${id}`) => ({ type: 'tool_result' as const, tool_use_id: id, content });
const histories: Record<string, KodaXMessage[]> = {
  'ordered calls with reversed, duplicate and foreign answers': [
    { role: 'assistant', content: [{ type: 'text', text: 'reading' }, call('a'), call('b')] },
    { role: 'user', content: [{ type: 'text', text: 'continue' }, result('b'), result('a'), result('a', 'duplicate'), result('foreign')] },
  ],
  'non-adjacent partial answers and next assistant boundary': [
    { role: 'assistant', content: [call('a'), call('b')] },
    { role: 'user', content: 'new instruction' },
    { role: 'user', content: [result('b')] },
    { role: 'assistant', content: 'next turn' },
    { role: 'user', content: [result('a', 'too late')] },
  ],
  'assistant text, unsigned thinking and calls in mixed order': [
    { role: 'assistant', content: [
      { type: 'text', text: 'first' }, { type: 'thinking', thinking: 'reason one' },
      call('a'), { type: 'thinking', thinking: 'reason two' }, { type: 'text', text: 'last' },
    ] },
    { role: 'user', content: [result('a')] },
  ],
  'empty ID with a valid sibling': [
    { role: 'assistant', content: [call(''), call('a')] },
    { role: 'user', content: [result(''), result('a')] },
  ],
  'only empty IDs': [{ role: 'assistant', content: [call('')] }],
  'only foreign answers': [{ role: 'user', content: [result('foreign')] }],
};

describe.each(providers)('%s diagnostic wire parity', (_name, factory) => {
  describe.each(['stream', 'complete'] as const)('%s', (method) => {
    it.each(Object.entries(histories))('matches the actual request for %s', async (_label, history) => {
      const provider = factory();
      const original = structuredClone(history);
      const wire = await captureMessages(provider, history, method);
      expect(hashProviderVisibleMessages(history, provider)).toBe(hash(wire));
      expect(history).toEqual(original);
    });

    it('tracks orphan tool inputs retained in the actual request', async () => {
      const provider = factory();
      const history = (path: string): KodaXMessage[] => [{ role: 'assistant', content: [
        { type: 'tool_use', id: 'call-a', name: 'read', input: { path } },
      ] }];
      const first = history('a');
      const second = history('b');
      const original = structuredClone(first);
      const firstWire = await captureMessages(provider, first, method);
      const secondWire = await captureMessages(provider, second, method);
      expect(hash(firstWire)).not.toBe(hash(secondWire));
      expect(hashProviderVisibleMessages(first, provider)).toBe(hash(firstWire));
      expect(hashProviderVisibleMessages(second, provider)).toBe(hash(secondWire));
      expect(first).toEqual(original);
    });
  });
});
