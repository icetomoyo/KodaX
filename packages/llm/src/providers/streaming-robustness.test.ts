import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import { KodaXOpenAICompatProvider } from './openai.js';
import type { KodaXMessage, KodaXProviderConfig, KodaXToolDefinition } from '../types.js';

class TestAnthropicProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'test-anthropic';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_API_KEY',
    model: 'test-model',
    supportsThinking: true,
    contextWindow: 200000,
  };

  constructor(client: unknown) {
    super();
    this.client = client as any;
  }
}

class TestOpenAIProvider extends KodaXOpenAICompatProvider {
  readonly name = 'test-openai';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_API_KEY',
    model: 'test-model',
    supportsThinking: false,
    contextWindow: 200000,
  };

  constructor(client: unknown) {
    super();
    this.client = client as any;
  }
}

const MESSAGES: KodaXMessage[] = [{ role: 'user', content: 'hello' }];
const TOOLS: KodaXToolDefinition[] = [];

function createAsyncIterable<T>(
  items: T[],
  options?: {
    delaysMs?: number[];
    onDone?: () => void;
  },
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;

      return {
        next: async () => {
          if (index < items.length) {
            const delayMs = options?.delaysMs?.[index] ?? 0;
            if (delayMs > 0) {
              await new Promise(resolve => setTimeout(resolve, delayMs));
            }

            const value = items[index];
            index += 1;
            return { done: false, value: value as T };
          }

          options?.onDone?.();
          return { done: true, value: undefined as T };
        },
      };
    },
  };
}

async function captureError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
    throw new Error('Expected promise to reject');
  } catch (error) {
    return error as Error;
  }
}

afterEach(() => {
  delete process.env.KODAX_DEBUG_STREAM;
  vi.restoreAllMocks();
});

describe('streaming robustness', () => {
  beforeEach(() => {
    delete process.env.KODAX_DEBUG_STREAM;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('tracks the last Anthropic delta activity when an incomplete stream ends', async () => {
    const provider = new TestAnthropicProvider({
      messages: {
        create: vi.fn().mockResolvedValue(
          createAsyncIterable(
            [
              { type: 'content_block_start', content_block: { type: 'text' } },
              { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
            ],
            { delaysMs: [0, 80] },
          ),
        ),
      },
    });

    const error = await captureError(() => provider.stream(MESSAGES, TOOLS, 'system'));
    const lastEventAge = /Last event: (\d+)ms ago/.exec(error.message);

    expect(error.name).toBe('KodaXProviderError');
    expect(error.message).toContain('Stream incomplete: message_stop event not received');
    expect(lastEventAge).not.toBeNull();
    expect(Number(lastEventAge?.[1])).toBeLessThan(50);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('returns the partial response when stop_reason arrived but message_stop did not (no wasteful retry)', async () => {
    // Anthropic sends stop_reason in message_delta, which precedes message_stop.
    // If the stream cuts in that narrow window, the content is already complete —
    // we must return it (not throw StreamIncompleteError and re-bill the turn).
    const provider = new TestAnthropicProvider({
      messages: {
        create: vi.fn().mockResolvedValue(
          createAsyncIterable([
            { type: 'content_block_start', content_block: { type: 'text' } },
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello world' } },
            { type: 'content_block_stop' },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
            // NOTE: no message_stop event
          ]),
        ),
      },
    });

    const result = await provider.stream(MESSAGES, TOOLS, 'system');
    expect(result.stopReason).toBe('end_turn');
    expect(result.textBlocks.map((b) => b.text).join('')).toContain('Hello world');
  });

  it('treats an Anthropic abort as AbortError instead of Stream incomplete', async () => {
    const controller = new AbortController();
    const provider = new TestAnthropicProvider({
      messages: {
        create: vi.fn().mockResolvedValue(
          createAsyncIterable(
            [
              { type: 'content_block_start', content_block: { type: 'text' } },
              { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
            ],
            {
              onDone: () => {
                controller.abort(new Error('Stream stalled or delayed response (60s idle)'));
              },
            },
          ),
        ),
      },
    });

    const error = await captureError(() =>
      provider.stream(MESSAGES, TOOLS, 'system', false, undefined, controller.signal),
    );

    expect(error.name).toBe('AbortError');
    expect(error.message).toContain('Stream stalled or delayed response (60s idle)');
    expect(console.error).not.toHaveBeenCalled();
  });

  it('treats an OpenAI-compatible abort as AbortError instead of Stream incomplete', async () => {
    const controller = new AbortController();
    const provider = new TestOpenAIProvider({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(
            createAsyncIterable(
              [
                {
                  choices: [
                    {
                      delta: { content: 'Hello' },
                      finish_reason: null,
                    },
                  ],
                },
              ],
              {
                onDone: () => {
                  controller.abort(new Error('Stream stalled or delayed response (60s idle)'));
                },
              },
            ),
          ),
        },
      },
    });

    const error = await captureError(() =>
      provider.stream(MESSAGES, TOOLS, 'system', false, undefined, controller.signal),
    );

    expect(error.name).toBe('AbortError');
    expect(error.message).toContain('Stream stalled or delayed response (60s idle)');
    expect(console.error).not.toHaveBeenCalled();
  });

  it('still reports genuine OpenAI-compatible truncation as an incomplete stream', async () => {
    const provider = new TestOpenAIProvider({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(
            createAsyncIterable([
              {
                choices: [
                  {
                    delta: { content: 'Hello' },
                    finish_reason: null,
                  },
                ],
              },
            ]),
          ),
        },
      },
    });

    const error = await captureError(() => provider.stream(MESSAGES, TOOLS, 'system'));

    expect(error.name).toBe('KodaXProviderError');
    expect(error.message).toContain('Stream incomplete: finish_reason not received');
    expect(console.error).not.toHaveBeenCalled();
  });

  it('reports finish_reason "error" as an incomplete stream instead of a finished reply', async () => {
    const provider = new TestOpenAIProvider({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(
            createAsyncIterable([
              { choices: [{ delta: { content: 'Hel' }, finish_reason: null }] },
              { choices: [{ delta: {}, finish_reason: 'error' }] },
            ]),
          ),
        },
      },
    });

    const error = await captureError(() => provider.stream(MESSAGES, TOOLS, 'system'));

    expect(error.name).toBe('KodaXProviderError');
    expect(error.message).toContain('Stream incomplete: the provider ended the stream with finish_reason "error"');
  });

  it('emits stream diagnostics only when KODAX_DEBUG_STREAM is enabled', async () => {
    process.env.KODAX_DEBUG_STREAM = '1';
    const controller = new AbortController();
    const provider = new TestAnthropicProvider({
      messages: {
        create: vi.fn().mockResolvedValue(
          createAsyncIterable(
            [
              { type: 'content_block_start', content_block: { type: 'text' } },
              { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
            ],
            {
              onDone: () => {
                controller.abort(new Error('Stream stalled or delayed response (60s idle)'));
              },
            },
          ),
        ),
      },
    });

    const error = await captureError(() =>
      provider.stream(MESSAGES, TOOLS, 'system', false, undefined, controller.signal),
    );

    expect(error.name).toBe('AbortError');
    expect(console.error).toHaveBeenCalledWith(
      '[Stream] Stream ended after abort before message_stop:',
      expect.objectContaining({
        reason: 'Stream stalled or delayed response (60s idle)',
      }),
    );
  });
});
