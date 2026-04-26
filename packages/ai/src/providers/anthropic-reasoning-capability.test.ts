import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXReasoningCapability,
  KodaXReasoningRequest,
  KodaXToolDefinition,
} from '../types.js';
import { loadReasoningOverride, resetReasoningOverrideCache } from '../reasoning-overrides.js';

const MESSAGES: KodaXMessage[] = [{ role: 'user', content: 'hello' }];
const TOOLS: KodaXToolDefinition[] = [];
const TEST_CONFIG_FILE = path.join(
  os.tmpdir(),
  `kodax-reasoning-override-${Date.now()}.json`,
);

function createCompletedAnthropicStream(options?: {
  startUsage?: {
    input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  deltaUsage?: {
    output_tokens?: number | null;
  };
}): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      const events = [
        {
          type: 'message_start',
          message: {
            usage: options?.startUsage,
          },
        },
        {
          type: 'message_delta',
          usage: options?.deltaUsage,
        },
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

function createToolUseAnthropicStream(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      const events = [
        { type: 'message_start', message: { usage: {} } },
        {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: 'tool_1',
            name: 'read',
          },
        },
        {
          type: 'content_block_delta',
          delta: {
            type: 'input_json_delta',
            partial_json: '{"path":"README.md"}',
          },
        },
        { type: 'content_block_stop' },
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
  protected readonly config: KodaXProviderConfig;

  constructor(
    capability: KodaXReasoningCapability,
    client: unknown,
  ) {
    super();
    this.config = {
      apiKeyEnv: 'TEST_API_KEY',
      model: 'test-model',
      supportsThinking: capability !== 'prompt-only',
      reasoningCapability: capability,
      maxOutputTokens: 32768,
    };
    this.client = client as any;
  }

  protected override getApiKey(): string {
    return 'test-key';
  }
}

describe('anthropic reasoning capability', () => {
  const reasoning: KodaXReasoningRequest = {
    enabled: true,
    mode: 'deep',
    depth: 'high',
    taskType: 'plan',
    executionMode: 'planning',
  };

  beforeEach(() => {
    process.env.KODAX_CONFIG_FILE = TEST_CONFIG_FILE;
    fs.rmSync(TEST_CONFIG_FILE, { force: true });
    resetReasoningOverrideCache();
  });

  afterEach(() => {
    delete process.env.KODAX_CONFIG_FILE;
    fs.rmSync(TEST_CONFIG_FILE, { force: true });
    resetReasoningOverrideCache();
  });

  it('falls back from budget to toggle and persists the override', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('unsupported parameter: budget_tokens'))
      .mockResolvedValueOnce(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-budget', {
      messages: { create },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0].thinking).toMatchObject({
      type: 'enabled',
      budget_tokens: 20000,
    });
    expect(create.mock.calls[1]?.[0].thinking).toMatchObject({
      type: 'enabled',
    });
    expect(create.mock.calls[1]?.[0].thinking).not.toHaveProperty('budget_tokens');
    expect(
      loadReasoningOverride('test-anthropic', {
        baseUrl: undefined,
        model: 'test-model',
      }),
    ).toBe('toggle');
  });

  it('merges input and output usage events into a single token snapshot', async () => {
    const create = vi.fn().mockResolvedValue(
      createCompletedAnthropicStream({
        startUsage: {
          input_tokens: 100,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 20,
        },
        deltaUsage: {
          output_tokens: 40,
        },
      }),
    );
    const provider = new TestAnthropicProvider('native-budget', {
      messages: { create },
    });

    const result = await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    expect(result.usage).toEqual({
      inputTokens: 125,
      outputTokens: 40,
      totalTokens: 165,
      cachedReadTokens: 20,
      cachedWriteTokens: 5,
    });
  });

  it('sends budget_tokens only for native-budget providers', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-budget', {
      messages: { create },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.thinking).toMatchObject({
      type: 'enabled',
      budget_tokens: 20000,
    });
  });

  it('sends only enabled thinking for native-toggle providers', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-toggle', {
      messages: { create },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.thinking).toMatchObject({
      type: 'enabled',
    });
    expect(kwargs.thinking).not.toHaveProperty('budget_tokens');
  });

  it('does not send native thinking config for prompt-only providers', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('prompt-only', {
      messages: { create },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs).not.toHaveProperty('thinking');
  });

  it('emits tool input deltas with tool ids for concurrent-safe consumers', async () => {
    const create = vi.fn().mockResolvedValue(createToolUseAnthropicStream());
    const onToolInputDelta = vi.fn();
    const provider = new TestAnthropicProvider('native-budget', {
      messages: { create },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning, {
      onToolInputDelta,
    });

    expect(onToolInputDelta).toHaveBeenCalledWith(
      'read',
      '{"path":"README.md"}',
      { toolId: 'tool_1' },
    );
  });

  // v0.7.28: Anthropic streams the redacted_thinking payload's `data`
  // field on `content_block_start` itself (no deltas, no `data` on the
  // stop event). Earlier code captured nothing at start and tried to
  // read `event.content_block.data` at stop — which is always undefined,
  // silently dropping the redacted reasoning. Verify the data reaches
  // thinkingBlocks intact.
  it('preserves redacted_thinking data captured at content_block_start', async () => {
    const REDACTED_PAYLOAD = 'opaque-server-encoded-thinking-blob-XYZ';
    const stream: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        let i = 0;
        const events = [
          { type: 'message_start', message: { usage: {} } },
          {
            type: 'content_block_start',
            content_block: {
              type: 'redacted_thinking',
              data: REDACTED_PAYLOAD,
            },
          },
          // No deltas — redacted_thinking arrives as a single payload on start.
          { type: 'content_block_stop' },
          { type: 'message_stop' },
        ];
        return {
          next: async () => {
            if (i >= events.length) return { done: true, value: undefined };
            const value = events[i];
            i += 1;
            return { done: false, value };
          },
        };
      },
    };

    const create = vi.fn().mockResolvedValue(stream);
    const provider = new TestAnthropicProvider('native-budget', {
      messages: { create },
    });
    const result = await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    expect(result.thinkingBlocks).toEqual([
      { type: 'redacted_thinking', data: REDACTED_PAYLOAD },
    ]);
  });

  it('skips redacted_thinking blocks with empty payload (server quirk)', async () => {
    // Defensive: if the server emits redacted_thinking with no `data`,
    // there's nothing meaningful to replay. Skip the empty block rather
    // than push one — keeps wire-format invariants clean.
    const stream: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        let i = 0;
        const events = [
          { type: 'message_start', message: { usage: {} } },
          { type: 'content_block_start', content_block: { type: 'redacted_thinking' } },
          { type: 'content_block_stop' },
          { type: 'message_stop' },
        ];
        return {
          next: async () => {
            if (i >= events.length) return { done: true, value: undefined };
            const value = events[i];
            i += 1;
            return { done: false, value };
          },
        };
      },
    };

    const create = vi.fn().mockResolvedValue(stream);
    const provider = new TestAnthropicProvider('native-budget', {
      messages: { create },
    });
    const result = await provider.stream(MESSAGES, TOOLS, 'system', reasoning);
    expect(result.thinkingBlocks).toEqual([]);
  });

  it('isolates redacted_thinking state across consecutive blocks', async () => {
    // Two redacted_thinking blocks back-to-back must not bleed state —
    // the second block's data must not leak into the first, and an empty
    // second block must not duplicate the first.
    const stream: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        let i = 0;
        const events = [
          { type: 'message_start', message: { usage: {} } },
          { type: 'content_block_start', content_block: { type: 'redacted_thinking', data: 'first' } },
          { type: 'content_block_stop' },
          { type: 'content_block_start', content_block: { type: 'redacted_thinking', data: 'second' } },
          { type: 'content_block_stop' },
          { type: 'message_stop' },
        ];
        return {
          next: async () => {
            if (i >= events.length) return { done: true, value: undefined };
            const value = events[i];
            i += 1;
            return { done: false, value };
          },
        };
      },
    };

    const create = vi.fn().mockResolvedValue(stream);
    const provider = new TestAnthropicProvider('native-budget', {
      messages: { create },
    });
    const result = await provider.stream(MESSAGES, TOOLS, 'system', reasoning);
    expect(result.thinkingBlocks).toEqual([
      { type: 'redacted_thinking', data: 'first' },
      { type: 'redacted_thinking', data: 'second' },
    ]);
  });
});
