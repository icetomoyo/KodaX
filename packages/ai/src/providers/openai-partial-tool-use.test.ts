/**
 * Integration tests for partial tool_use input salvage in the
 * OpenAI-compat path.
 *
 * Mirrors `anthropic-partial-tool-use.test.ts` so both transports have
 * symmetric regression coverage. Covers two call sites in openai.ts:
 *
 *  - Streaming path (`stream()`) — `delta.tool_calls[].function.arguments`
 *    chunks accumulate across SSE events. On `finish_reason: length`
 *    the last event leaves the buffer truncated mid-string.
 *  - Non-streaming path (`complete()`) — `message.tool_calls[].function.arguments`
 *    arrives as a single string. When the upstream model hit max_tokens
 *    in non-streaming mode the string is also truncated.
 *
 * Both paths must run through the shared `parseToolInputWithSalvage`
 * helper rather than the legacy `JSON.parse` → `input: {}` fallback,
 * which silently dropped useful work.
 */

import { describe, expect, it, vi } from 'vitest';
import { KodaXOpenAICompatProvider } from './openai.js';
import type { KodaXMessage, KodaXProviderConfig, KodaXToolDefinition } from '../types.js';

const TOOLS: KodaXToolDefinition[] = [];

class TestOpenAIProvider extends KodaXOpenAICompatProvider {
  readonly name = 'test-openai-partial';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_API_KEY',
    model: 'test-model',
    supportsThinking: false,
    baseUrl: 'https://example.invalid',
  };

  constructor(client: unknown) {
    super();
    (this as any).client = client;
  }

  protected override getApiKey(): string {
    return 'test-key';
  }
}

function streamFromChunks(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => {
          if (i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[i++] };
        },
      };
    },
  };
}

/**
 * Build a sequence of OpenAI streaming SSE chunks that reconstruct a
 * single tool call whose `arguments` field accumulates as the given
 * `argumentsStr`. Splits the string into 3-char chunks to mirror
 * DeepSeek SSE granularity observed in the bench.
 */
function buildToolUseChunks(toolId: string, toolName: string, argumentsStr: string, finishReason: string) {
  const chunks: any[] = [];
  // First chunk introduces the tool_call shell with id/name and (optional) first slice of args
  chunks.push({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: toolId, type: 'function', function: { name: toolName, arguments: '' } },
          ],
        },
      },
    ],
  });
  // Stream args in small slices
  const sliceLen = 8;
  for (let i = 0; i < argumentsStr.length; i += sliceLen) {
    chunks.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: argumentsStr.slice(i, i + sliceLen) } },
            ],
          },
        },
      ],
    });
  }
  // Final chunk with finish_reason
  chunks.push({
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  });
  return chunks;
}

describe('openai partial tool_use salvage (streaming path)', () => {
  it('parses complete JSON via helper strict path', async () => {
    const fullJson = '{"path":"/tmp/x.html","content":"<html></html>"}';
    const create = vi
      .fn()
      .mockResolvedValue(streamFromChunks(buildToolUseChunks('call_1', 'write', fullJson, 'tool_calls')));
    const provider = new TestOpenAIProvider({ chat: { completions: { create } } });
    const messages: KodaXMessage[] = [{ role: 'user', content: 'write file' }];

    const result = await provider.stream(messages, TOOLS, 'sys');
    expect(result.toolBlocks).toHaveLength(1);
    expect(result.toolBlocks[0].name).toBe('write');
    expect(result.toolBlocks[0].input).toEqual({ path: '/tmp/x.html', content: '<html></html>' });
  });

  it('salvages truncated tool_call arguments on finish_reason=length (real DeepSeek V4 truncation shape)', async () => {
    // Shape captured 2026-04-25 from deepseek-v4-flash at max_tokens=4000:
    // strict JSON.parse fails with "Unterminated string in JSON at position N",
    // partial-json closes the open string and recovers `path` + the leading
    // portion of `content`.
    const truncated =
      '{"path":"slides/agent-membase-bizagentos-fusion.html","content":"<!DOCTYPE html>\\n<html lang=\\"en\\">\\n<head><meta charset=\\"UTF-8\\">';
    const create = vi
      .fn()
      .mockResolvedValue(streamFromChunks(buildToolUseChunks('call_1', 'write', truncated, 'length')));
    const provider = new TestOpenAIProvider({ chat: { completions: { create } } });
    const messages: KodaXMessage[] = [{ role: 'user', content: 'write slides' }];

    const result = await provider.stream(messages, TOOLS, 'sys');
    expect(result.toolBlocks).toHaveLength(1);
    expect(result.toolBlocks[0].name).toBe('write');
    const input = result.toolBlocks[0].input as Record<string, unknown>;
    expect(input.path).toBe('slides/agent-membase-bizagentos-fusion.html');
    expect(typeof input.content).toBe('string');
    expect((input.content as string)).toContain('<!DOCTYPE html>');
    // Critical: NOT the legacy `input: {}` failure mode
    expect(input).not.toEqual({});
    // stopReason propagates so the agent loop can take the L5 continuation path
    expect(result.stopReason).toBe('length');
  });

  it('falls back to {} for unparseable garbage tool_call arguments', async () => {
    const garbage = 'not even json at all }}}';
    const create = vi
      .fn()
      .mockResolvedValue(streamFromChunks(buildToolUseChunks('call_1', 'write', garbage, 'length')));
    const provider = new TestOpenAIProvider({ chat: { completions: { create } } });
    const messages: KodaXMessage[] = [{ role: 'user', content: 'x' }];

    const result = await provider.stream(messages, TOOLS, 'sys');
    expect(result.toolBlocks).toHaveLength(1);
    expect(result.toolBlocks[0].input).toEqual({});
  });

  it('handles empty arguments string by pushing empty object', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(streamFromChunks(buildToolUseChunks('call_1', 'write', '', 'length')));
    const provider = new TestOpenAIProvider({ chat: { completions: { create } } });
    const messages: KodaXMessage[] = [{ role: 'user', content: 'x' }];

    const result = await provider.stream(messages, TOOLS, 'sys');
    expect(result.toolBlocks).toHaveLength(1);
    expect(result.toolBlocks[0].input).toEqual({});
  });
});

describe('openai partial tool_use salvage (non-streaming complete path)', () => {
  it('parses complete JSON via helper strict path', async () => {
    const fullJson = '{"path":"/tmp/x.html","content":"<html></html>"}';
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'write', arguments: fullJson } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const provider = new TestOpenAIProvider({ chat: { completions: { create } } });
    const messages: KodaXMessage[] = [{ role: 'user', content: 'x' }];

    const result = await provider.complete(messages, TOOLS, 'sys');
    expect(result.toolBlocks).toHaveLength(1);
    expect(result.toolBlocks[0].input).toEqual({ path: '/tmp/x.html', content: '<html></html>' });
  });

  it('salvages truncated tool_call arguments returned by non-streaming endpoint', async () => {
    const truncated = '{"path":"/tmp/x.html","content":"<html><body><h1>partial';
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'write', arguments: truncated } },
            ],
          },
          finish_reason: 'length',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 },
    });
    const provider = new TestOpenAIProvider({ chat: { completions: { create } } });
    const messages: KodaXMessage[] = [{ role: 'user', content: 'x' }];

    const result = await provider.complete(messages, TOOLS, 'sys');
    expect(result.toolBlocks).toHaveLength(1);
    const input = result.toolBlocks[0].input as Record<string, unknown>;
    expect(input.path).toBe('/tmp/x.html');
    expect((input.content as string)).toContain('<html><body><h1>partial');
    expect(input).not.toEqual({});
  });
});
