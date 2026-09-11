import { describe, expect, it, vi } from 'vitest';
import type { KodaXMessage } from '../types.js';
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import { KodaXOpenAICompatProvider } from './openai.js';
import { createCustomProvider } from './custom-provider.js';
import { KODAX_PROVIDERS } from './registry.js';

// Exercise the public request boundary for every shared-channel provider.
// CLI transports delegate conversation serialization to their external CLI.
const factories = [
  ...Object.entries(KODAX_PROVIDERS).filter(([, factory]) => {
    const provider = factory();
    return provider instanceof KodaXAnthropicCompatProvider
      || provider instanceof KodaXOpenAICompatProvider;
  }),
  ...(['anthropic', 'openai'] as const).map((protocol) => [
    `custom-${protocol}`,
    () => createCustomProvider({
      name: `custom-${protocol}`, protocol, model: 'test-model',
      baseUrl: 'https://provider.invalid', apiKeyEnv: 'UNUSED_TEST_KEY',
    }),
  ] as const),
];

describe.each(factories)('%s history repair', (_name, factory) => {
  it.each(['stream', 'complete'] as const)(
    '%s removes foreign tool results while preserving real results and user text',
    async (method) => {
      const provider = factory();
      const anthropic = provider instanceof KodaXAnthropicCompatProvider;
      const create = vi.fn(async (_params: { messages: unknown[]; stream?: boolean }) => {
        if (_params.stream) {
          return (async function* () {
            if (anthropic) {
              yield { type: 'message_start' };
              yield { type: 'message_stop' };
            } else {
              yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
            }
          })();
        }
        return anthropic
          ? { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }
          : { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
      });
      Reflect.set(provider, '_client', anthropic
        ? { messages: { create } } : { chat: { completions: { create } } });
      const history: KodaXMessage[] = [
        { role: 'user', content: 'read a file' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_a', name: 'read', input: {} }] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'call_a', content: 'real result' },
          { type: 'tool_result', tool_use_id: 'orphan_x', content: 'foreign result' },
          { type: 'text', text: 'keep this user instruction' },
        ] },
      ];
      const original = structuredClone(history);
      await provider[method](history, [], 'system');
      expect(create).toHaveBeenCalledTimes(1);
      const wire = JSON.stringify(create.mock.calls[0]![0].messages);
      expect(wire).not.toContain('orphan_x');
      expect(wire).not.toContain('foreign result');
      expect(wire).toContain('real result');
      expect(wire).toContain('keep this user instruction');
      expect(history).toEqual(original);
    },
  );
});

describe.each(factories.filter(([, factory]) => factory() instanceof KodaXOpenAICompatProvider))(
  '%s invalid call IDs', (_name, factory) => {
    it.each([
      ['stream', false], ['stream', true], ['complete', false], ['complete', true],
    ] as const)('%s filters invalid calls (valid sibling: %s)', async (method, validSibling) => {
      const provider = factory();
      const create = vi.fn(async (_params: { messages: unknown[]; stream?: boolean }) => (
        _params.stream
          ? (async function* () { yield { choices: [{ delta: {}, finish_reason: 'stop' }] }; })()
          : { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }
      ));
      Reflect.set(provider, '_client', { chat: { completions: { create } } });
      const history: KodaXMessage[] = [{ role: 'assistant', content: [
        { type: 'text', text: 'preserve assistant text' },
        { type: 'tool_use', id: '', name: 'invalid_empty', input: {} },
        { type: 'tool_use', id: '  ', name: 'invalid_blank', input: {} },
        ...(validSibling ? [{ type: 'tool_use' as const, id: 'valid_id', name: 'read', input: {} }] : []),
      ] }];
      const original = structuredClone(history);
      await provider[method](history, [], 'system');
      const wire = JSON.stringify(create.mock.calls[0]![0].messages);
      expect(wire).not.toContain('invalid_empty');
      expect(wire).not.toContain('invalid_blank');
      expect(wire).toContain('preserve assistant text');
      if (validSibling) {
        expect(wire.match(/valid_id/g)).toHaveLength(2);
        expect(wire).toContain('execution status is unknown');
      } else {
        expect(wire).not.toContain('tool_calls');
      }
      expect(history).toEqual(original);
    });
  },
);
