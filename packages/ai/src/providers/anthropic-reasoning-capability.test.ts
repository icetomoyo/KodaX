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
});
