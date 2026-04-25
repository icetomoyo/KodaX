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
    const provider = new TestOpenAIProvider('deepseek', 'native-effort', {
      chat: { completions: { create } },
    }, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      replayReasoningContent: true,
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

  // DeepSeek V4 thinking mode rejects replay turns that strip reasoning_content
  // ("400 The reasoning_content in the thinking mode must be passed back to
  // the API"). Pure conversational follow-ups produce thinking + text but no
  // tool_calls, so reasoning_content must travel even when tool_calls are
  // absent.
  it('replays reasoning_content for deepseek text-only assistant turns', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('deepseek', 'native-effort', {
      chat: { completions: { create } },
    }, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      replayReasoningContent: true,
    });

    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Explain what you found.' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Walking through the analysis.' },
          { type: 'text', text: 'Here is the full analysis...' },
        ],
      },
      { role: 'user', content: 'Now propose a fix.' },
    ];

    await provider.stream(messages, TOOLS, 'system', reasoning);

    const requestMessages = create.mock.calls[0]?.[0].messages as Array<Record<string, unknown>>;
    expect(requestMessages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'Explain what you found.' },
      {
        role: 'assistant',
        content: 'Here is the full analysis...',
        reasoning_content: 'Walking through the analysis.',
      },
      { role: 'user', content: 'Now propose a fix.' },
    ]);
  });

  // Sibling guard: providers without the replayReasoningContent flag must
  // NOT have reasoning_content attached even when the conversation history
  // carries thinking blocks. The field is a Chinese OpenAI-compat extension;
  // sending it to OpenAI proper or to providers that don't use the
  // convention could be rejected as an unknown parameter.
  it('does not attach reasoning_content when replayReasoningContent is unset', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('qwen', 'native-toggle', {
      chat: { completions: { create } },
    }, {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-max',
    });

    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal monologue' },
          { type: 'text', text: 'Hello!' },
        ],
      },
      { role: 'user', content: 'Continue.' },
    ];

    await provider.stream(messages, TOOLS, 'system', reasoning);

    const requestMessages = create.mock.calls[0]?.[0].messages as Array<Record<string, unknown>>;
    const assistantWire = requestMessages.find((m) => m.role === 'assistant');
    expect(assistantWire).toBeDefined();
    expect(assistantWire).not.toHaveProperty('reasoning_content');
  });

  // Lock the new contract: behavior follows the explicit replayReasoningContent
  // flag, not the provider name. A deepseek-named provider with the flag
  // forced false must not echo; a non-deepseek-named provider with the flag
  // forced true must echo. Required so future Qwen/Zhipu/Kimi/MiniMax opt-in
  // works purely by registry edit, no openai.ts patch needed.
  it('honours replayReasoningContent flag regardless of provider name', async () => {
    const createWithoutFlag = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const deepseekWithoutFlag = new TestOpenAIProvider('deepseek', 'native-effort', {
      chat: { completions: { create: createWithoutFlag } },
    }, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      replayReasoningContent: false,
    });

    const createWithFlag = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const qwenWithFlag = new TestOpenAIProvider('qwen', 'native-toggle', {
      chat: { completions: { create: createWithFlag } },
    }, {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-max',
      replayReasoningContent: true,
    });

    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'monologue' },
          { type: 'text', text: 'Hello!' },
        ],
      },
      { role: 'user', content: 'Continue.' },
    ];

    await deepseekWithoutFlag.stream(messages, TOOLS, 'system', reasoning);
    await qwenWithFlag.stream(messages, TOOLS, 'system', reasoning);

    const deepseekAssistantWire = (createWithoutFlag.mock.calls[0]?.[0].messages as Array<Record<string, unknown>>)
      .find((m) => m.role === 'assistant');
    const qwenAssistantWire = (createWithFlag.mock.calls[0]?.[0].messages as Array<Record<string, unknown>>)
      .find((m) => m.role === 'assistant');

    expect(deepseekAssistantWire).not.toHaveProperty('reasoning_content');
    expect(qwenAssistantWire).toMatchObject({ reasoning_content: 'monologue' });
  });

  // Edge case (Hidden bug B): a model can finish a turn having emitted only
  // thinking — no visible text, no tool calls. The early `return []` in
  // serializeAssistantMessage used to drop the entire assistant turn from
  // the wire, breaking the user/assistant alternation contract some
  // OpenAI-compat gateways enforce, AND erasing the reasoning_content the
  // next-turn replay needs (DeepSeek V4 then 400s on the missing field).
  // Inject a minimal placeholder text so the turn survives the wire and
  // reasoning_content can ride along.
  it('preserves deepseek assistant turn that emitted only thinking', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('deepseek', 'native-effort', {
      chat: { completions: { create } },
    }, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      replayReasoningContent: true,
    });

    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Quick check.' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'no public output, just internal reasoning' },
        ],
      },
      { role: 'user', content: 'Continue.' },
    ];

    await provider.stream(messages, TOOLS, 'system', reasoning);

    const requestMessages = create.mock.calls[0]?.[0].messages as Array<Record<string, unknown>>;
    // Critical: the assistant turn must NOT vanish from the wire — that
    // would break user/assistant alternation and discard the thinking
    // payload DeepSeek requires.
    const roles = requestMessages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
    const assistantWire = requestMessages.find((m) => m.role === 'assistant') as Record<string, unknown>;
    expect(assistantWire).toBeDefined();
    expect(assistantWire.reasoning_content).toBe('no public output, just internal reasoning');
    // Placeholder content must be a non-empty string (gateways reject
    // null content on assistant turns without tool_calls).
    expect(typeof assistantWire.content).toBe('string');
    expect((assistantWire.content as string).length).toBeGreaterThan(0);
  });

  // Sibling case to the thinking-only test: an assistant turn with only a
  // redacted_thinking block (cross-provider history replay scenario) must
  // also keep its slot on the wire, even though it contributes no
  // serializable thinking string and no reasoning_content can be echoed.
  it('preserves assistant turn that carries only redacted_thinking', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('deepseek', 'native-effort', {
      chat: { completions: { create } },
    }, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      replayReasoningContent: true,
    });

    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Earlier turn from another provider.' },
      {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'opaque-blob' },
        ],
      },
      { role: 'user', content: 'Continue.' },
    ];

    await provider.stream(messages, TOOLS, 'system', reasoning);

    const requestMessages = create.mock.calls[0]?.[0].messages as Array<Record<string, unknown>>;
    const roles = requestMessages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
    const assistantWire = requestMessages.find((m) => m.role === 'assistant') as Record<string, unknown>;
    // No reasoning_content because redacted blocks contribute no thinking string,
    // but the turn slot itself must be preserved.
    expect(assistantWire).not.toHaveProperty('reasoning_content');
    expect(typeof assistantWire.content).toBe('string');
    expect((assistantWire.content as string).length).toBeGreaterThan(0);
  });

  // The non-streaming complete() fallback used to discard reasoning_content
  // entirely (hardcoded ''). When streaming fails and the fallback fires
  // against DeepSeek V4 thinking mode, the lost thinking would then be
  // missing from history, causing the next replayed turn to 400. Mirror the
  // streaming-side capture so the inbound paths stay symmetric.
  it('captures reasoning_content from non-streaming complete() responses', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'final answer',
            reasoning_content: 'walked through the analysis offline',
            tool_calls: [],
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    });
    const provider = new TestOpenAIProvider('deepseek', 'native-effort', {
      chat: { completions: { create } },
    }, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    });

    const result = await provider.complete(MESSAGES, TOOLS, 'system', reasoning);

    expect(result.thinkingBlocks).toEqual([
      { type: 'thinking', thinking: 'walked through the analysis offline' },
    ]);
    expect(result.textBlocks).toEqual([
      { type: 'text', text: 'final answer' },
    ]);
  });

  it('captures reasoning_content deltas as thinking blocks', async () => {
    const create = vi.fn().mockResolvedValue(createDeepSeekToolStream());
    const onThinkingDelta = vi.fn();
    const onThinkingEnd = vi.fn();
    const provider = new TestOpenAIProvider('deepseek', 'native-effort', {
      chat: { completions: { create } },
    }, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
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
    const provider = new TestOpenAIProvider('deepseek', 'native-effort', {
      chat: { completions: { create } },
    }, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
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
    const provider = new TestOpenAIProvider('deepseek', 'native-effort', {
      chat: { completions: { create } },
    }, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
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
    const provider = new TestOpenAIProvider('deepseek', 'native-effort', {
      chat: { completions: { create } },
    }, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
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
