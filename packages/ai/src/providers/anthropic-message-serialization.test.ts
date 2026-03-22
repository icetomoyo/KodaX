import { describe, expect, it, vi } from 'vitest';
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXToolDefinition,
} from '../types.js';

const TOOLS: KodaXToolDefinition[] = [];

function createCompletedAnthropicStream(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      const events = [
        { type: 'message_start' },
        { type: 'message_stop' },
      ];
      return {
        next: async () => {
          if (index >= events.length) {
            return { done: true, value: undefined };
          }
          const value = events[index];
          index += 1;
          return { done: false, value };
        },
      };
    },
  };
}

class TestAnthropicProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'test-anthropic';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_API_KEY',
    model: 'test-model',
    supportsThinking: false,
  };

  constructor(client: unknown) {
    super();
    this.client = client as any;
  }

  protected override getApiKey(): string {
    return 'test-key';
  }
}

describe('anthropic message serialization', () => {
  it('preserves inline system summaries and tool_result error flags', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider({
      messages: { create },
    });
    const messages: KodaXMessage[] = [
      { role: 'system', content: '[对话历史摘要]\n\nImportant summary' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'read', input: { path: 'README.md' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: '[Tool Error] read: failed', is_error: true }],
      },
    ];

    await provider.stream(messages, TOOLS, 'Base system prompt');

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.system).toContain('Base system prompt');
    expect(kwargs.system).toContain('[对话历史摘要]');
    expect(kwargs.messages).toHaveLength(2);
    expect(kwargs.messages[1]?.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tool_1',
      is_error: true,
    });
  });
});
