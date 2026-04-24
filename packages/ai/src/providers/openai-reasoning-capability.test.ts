import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KodaXOpenAICompatProvider } from './openai.js';
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
  `kodax-openai-reasoning-${Date.now()}.json`,
);

function createCompletedOpenAIStream(usage?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      const chunks = [
        {
          choices: [
            {
              delta: { content: 'ok' },
              finish_reason: null,
            },
          ],
        },
        {
          usage,
          choices: [
            {
              delta: {},
              finish_reason: 'stop',
            },
          ],
        },
      ];
      return {
        next: async () => {
          if (index >= chunks.length) {
            return { done: true, value: undefined };
          }
          const value = chunks[index];
          index += 1;
          return { done: false, value };
        },
      };
    },
  };
}

function createDeepSeekToolStream(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      const chunks = [
        {
          choices: [
            {
              delta: { reasoning_content: 'Need to inspect the file first.' },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    function: {
                      name: 'read',
                      arguments: '{"path":"package.json"}',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {},
              finish_reason: 'tool_calls',
            },
          ],
        },
      ];
      return {
        next: async () => {
          if (index >= chunks.length) {
            return { done: true, value: undefined };
          }
          const value = chunks[index];
          index += 1;
          return { done: false, value };
        },
      };
    },
  };
}

class TestOpenAIProvider extends KodaXOpenAICompatProvider {
  readonly name: string;
  protected readonly config: KodaXProviderConfig;

  constructor(
    name: string,
    capability: KodaXReasoningCapability,
    client: unknown,
    configOverrides: Partial<KodaXProviderConfig> = {},
  ) {
    super();
    this.name = name;
    this.config = {
      apiKeyEnv: 'TEST_API_KEY',
      model: 'test-model',
      supportsThinking: capability !== 'none' && capability !== 'prompt-only',
      reasoningCapability: capability,
      maxOutputTokens: 32768,
      ...configOverrides,
    };
    this.client = client as any;
  }

  protected override getApiKey(): string {
    return 'test-key';
  }
}

describe('openai reasoning capability', () => {
  const reasoning: KodaXReasoningRequest = {
    enabled: true,
    mode: 'balanced',
    depth: 'medium',
    taskType: 'review',
    executionMode: 'pr-review',
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

  it('sends reasoning_effort for native-effort providers', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('openai', 'native-effort', {
      chat: { completions: { create } },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    expect(create.mock.calls[0]?.[0].reasoning_effort).toBe('medium');
  });

  it('requests stream usage and prefers returned usage totals when available', async () => {
    const create = vi.fn().mockResolvedValue(
      createCompletedOpenAIStream({
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
      }),
    );
    const provider = new TestOpenAIProvider('openai', 'native-effort', {
      chat: { completions: { create } },
    });

    const result = await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    expect(create.mock.calls[0]?.[0].stream_options).toEqual({ include_usage: true });
    expect(result.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    });
  });

  it('falls back cleanly when include_usage is not supported by the provider', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('unknown parameter: include_usage'))
      .mockResolvedValueOnce(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('openai', 'native-effort', {
      chat: { completions: { create } },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0].stream_options).toEqual({ include_usage: true });
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('stream_options');
  });

  it('sends budget controls for qwen-style providers', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('qwen', 'native-budget', {
      chat: { completions: { create } },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      extra_body: {
        enable_thinking: true,
        thinking_budget: 10000,
      },
    });
  });

  it('enables native thinking toggle for deepseek-chat', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('deepseek', 'native-toggle', {
      chat: { completions: { create } },
    }, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      models: [
        {
          id: 'deepseek-reasoner',
          displayName: 'DeepSeek Reasoner',
          reasoningCapability: 'none',
        },
      ],
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      extra_body: {
        thinking: {
          type: 'enabled',
        },
      },
    });
  });

  it('treats deepseek-reasoner as model-selected reasoning and skips toggle params', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('deepseek', 'native-toggle', {
      chat: { completions: { create } },
    }, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      models: [
        {
          id: 'deepseek-reasoner',
          displayName: 'DeepSeek Reasoner',
          reasoningCapability: 'none',
        },
      ],
    });

    expect(provider.getReasoningCapability('deepseek-reasoner')).toBe('none');

    await provider.stream(
      MESSAGES,
      TOOLS,
      'system',
      reasoning,
      { modelOverride: 'deepseek-reasoner' },
    );

    expect(create.mock.calls[0]?.[0].model).toBe('deepseek-reasoner');
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('extra_body');
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('reasoning_effort');
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('thinking');
  });

  it('falls back from budget to toggle and persists the override', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('unknown parameter: budget_tokens'))
      .mockResolvedValueOnce(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('zhipu', 'native-budget', {
      chat: { completions: { create } },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0].thinking).toMatchObject({
      type: 'enabled',
      budget_tokens: 10000,
    });
    expect(create.mock.calls[1]?.[0].thinking).toMatchObject({
      type: 'enabled',
    });
    expect(create.mock.calls[1]?.[0].thinking).not.toHaveProperty('budget_tokens');
    expect(
      loadReasoningOverride('zhipu', {
        baseUrl: undefined,
        model: 'test-model',
      }),
    ).toBe('toggle');
  });

  it('replays tool history and reasoning_content for deepseek tool turns', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('deepseek', 'native-toggle', {
      chat: { completions: { create } },
    }, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    });

    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Inspect package.json' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Need the file contents.' },
          { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'package.json' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: '{"name":"kodax"}' },
        ],
      },
    ];

    await provider.stream(messages, TOOLS, 'system', reasoning);

    const requestMessages = create.mock.calls[0]?.[0].messages as Array<Record<string, unknown>>;
    expect(requestMessages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'Inspect package.json' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'Need the file contents.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'read',
              arguments: '{"path":"package.json"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: '{"name":"kodax"}',
      },
    ]);
  });

  it('captures reasoning_content deltas as thinking blocks', async () => {
    const create = vi.fn().mockResolvedValue(createDeepSeekToolStream());
    const onThinkingDelta = vi.fn();
    const onThinkingEnd = vi.fn();
    const provider = new TestOpenAIProvider('deepseek', 'native-toggle', {
      chat: { completions: { create } },
    }, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    });

    const result = await provider.stream(MESSAGES, TOOLS, 'system', reasoning, {
      onThinkingDelta,
      onThinkingEnd,
    });

    expect(result.thinkingBlocks).toEqual([
      { type: 'thinking', thinking: 'Need to inspect the file first.' },
    ]);
    expect(result.toolBlocks).toEqual([
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'read',
        input: { path: 'package.json' },
      },
    ]);
    expect(onThinkingDelta).toHaveBeenCalledWith('Need to inspect the file first.');
    expect(onThinkingEnd).toHaveBeenCalledWith('Need to inspect the file first.');
  });

  it('emits tool input deltas with tool ids for concurrent-safe consumers', async () => {
    const create = vi.fn().mockResolvedValue(createDeepSeekToolStream());
    const onToolInputDelta = vi.fn();
    const provider = new TestOpenAIProvider('deepseek', 'native-toggle', {
      chat: { completions: { create } },
    }, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning, {
      onToolInputDelta,
    });

    expect(onToolInputDelta).toHaveBeenCalledWith(
      'read',
      '{"path":"package.json"}',
      { toolId: 'call_1' },
    );
  });

  it('preserves historical system summary content by merging it into the single wire system message', async () => {
    // Third-party OpenAI-compat proxies (notably Qwen) reject any
    // role:'system' that is not at position 0 ("System message must at the
    // begin"). The provider therefore collapses the system parameter and
    // every embedded system message into a single wire system entry while
    // keeping the historical summary content intact — the previous behaviour
    // of forwarding multiple separate system messages is what triggered the
    // 400s in the first place.
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('deepseek', 'native-toggle', {
      chat: { completions: { create } },
    }, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    });

    const messages: KodaXMessage[] = [
      { role: 'system', content: '[Conversation Summary]\\n\\nPrior tool results...' },
      { role: 'user', content: 'Continue the task' },
    ];

    await provider.stream(messages, TOOLS, 'system', reasoning);

    const requestMessages = create.mock.calls[0]?.[0].messages as Array<Record<string, unknown>>;
    expect(requestMessages).toEqual([
      {
        role: 'system',
        content: 'system\n\n[Conversation Summary]\\n\\nPrior tool results...',
      },
      { role: 'user', content: 'Continue the task' },
    ]);
    // Invariant: exactly one wire system message, at position 0.
    const systemCount = requestMessages.filter((m) => m.role === 'system').length;
    expect(systemCount).toBe(1);
  });

  it('preserves array-based non-streaming assistant content during fallback completion', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: [
              { type: 'text', text: 'Recovered ' },
              { type: 'text', text: 'response' },
            ],
            tool_calls: [],
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
      },
    });
    const onTextDelta = vi.fn();
    const provider = new TestOpenAIProvider('deepseek', 'native-toggle', {
      chat: { completions: { create } },
    }, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    });

    const result = await provider.complete(MESSAGES, TOOLS, 'system', reasoning, {
      onTextDelta,
    });

    expect(result.textBlocks).toEqual([
      { type: 'text', text: 'Recovered response' },
    ]);
    expect(onTextDelta).toHaveBeenCalledWith('Recovered response');
  });
});
