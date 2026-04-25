/**
 * Tests for partial tool_use input salvage on `stop_reason: max_tokens`.
 *
 * Regression coverage:
 *  - Truncated JSON during tool_use streaming (mid-string cut from
 *    max_tokens) must NOT push an empty `input: {}` block. Pushing an
 *    empty input was the previous behavior and silently discarded all
 *    streamed work, polluting history with an unusable tool call.
 *  - The `partial-json` salvage must produce a usable partial object so
 *    the agent loop's L5 continuation path can pick up the partial state
 *    and prompt the model to continue.
 */
import { describe, expect, it, vi } from 'vitest';
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import type { KodaXMessage, KodaXProviderConfig, KodaXToolDefinition } from '../types.js';

const TOOLS: KodaXToolDefinition[] = [];

class TestAnthropicProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'test-anthropic-partial';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_API_KEY',
    model: 'test-model',
    supportsThinking: false,
  };

  constructor(client: unknown) {
    super();
    (this as any).client = client;
  }

  protected override getApiKey(): string {
    return 'test-key';
  }
}

function streamFromEvents(events: unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => {
          if (i >= events.length) return { done: true, value: undefined };
          return { done: false, value: events[i++] };
        },
      };
    },
  };
}

function buildToolUseEvents(partialJson: string, sendStop: boolean) {
  const events: any[] = [
    { type: 'message_start', message: { usage: { input_tokens: 100 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tool_1', name: 'write_file' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: partialJson },
    },
  ];
  if (sendStop) events.push({ type: 'content_block_stop', index: 0 });
  events.push(
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 16000 } },
    { type: 'message_stop' },
  );
  return events;
}

describe('anthropic partial tool_use salvage', () => {
  it('parses complete JSON with standard JSON.parse', async () => {
    const fullJson = '{"path":"/tmp/x.html","content":"<html></html>"}';
    const create = vi.fn().mockResolvedValue(streamFromEvents(buildToolUseEvents(fullJson, true)));
    const provider = new TestAnthropicProvider({ messages: { create } });
    const messages: KodaXMessage[] = [{ role: 'user', content: 'write file' }];

    const result = await provider.stream(messages, TOOLS, 'sys');
    expect(result.toolBlocks).toHaveLength(1);
    expect(result.toolBlocks[0].name).toBe('write_file');
    expect(result.toolBlocks[0].input).toEqual({ path: '/tmp/x.html', content: '<html></html>' });
  });

  it('salvages partial JSON when truncated mid-string (max_tokens scenario)', async () => {
    // Truncated mid-content string — what GLM emits at stop_reason=max_tokens.
    const partialJson = '{"path":"/tmp/slides.html","content":"<html><body><h1>hello';
    const create = vi.fn().mockResolvedValue(streamFromEvents(buildToolUseEvents(partialJson, true)));
    const provider = new TestAnthropicProvider({ messages: { create } });
    const messages: KodaXMessage[] = [{ role: 'user', content: 'write' }];

    const result = await provider.stream(messages, TOOLS, 'sys');
    expect(result.toolBlocks).toHaveLength(1);
    expect(result.toolBlocks[0].name).toBe('write_file');
    const input = result.toolBlocks[0].input as Record<string, unknown>;
    // partial-json closes the open string; salvage preserves the parsable prefix
    expect(input.path).toBe('/tmp/slides.html');
    expect(typeof input.content).toBe('string');
    expect((input.content as string).startsWith('<html><body><h1>hello')).toBe(true);
    // Critical: NOT the legacy `input: {}` failure mode
    expect(input).not.toEqual({});
  });

  it('falls back to empty object when partial-json also fails on garbage input', async () => {
    // Completely unparseable: no opening brace at all.
    const garbage = 'not even json at all }}}';
    const create = vi.fn().mockResolvedValue(streamFromEvents(buildToolUseEvents(garbage, true)));
    const provider = new TestAnthropicProvider({ messages: { create } });
    const messages: KodaXMessage[] = [{ role: 'user', content: 'x' }];

    const result = await provider.stream(messages, TOOLS, 'sys');
    expect(result.toolBlocks).toHaveLength(1);
    expect(result.toolBlocks[0].input).toEqual({});
  });

  it('handles empty input string by pushing empty object', async () => {
    const create = vi.fn().mockResolvedValue(streamFromEvents(buildToolUseEvents('', true)));
    const provider = new TestAnthropicProvider({ messages: { create } });
    const messages: KodaXMessage[] = [{ role: 'user', content: 'x' }];

    const result = await provider.stream(messages, TOOLS, 'sys');
    expect(result.toolBlocks).toHaveLength(1);
    expect(result.toolBlocks[0].input).toEqual({});
  });
});
