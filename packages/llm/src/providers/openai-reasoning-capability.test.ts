import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KodaXOpenAICompatProvider } from './openai.js';
import { runWithScopedConfig } from '../run-scoped-config.js';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXReasoningCapability,
  KodaXReasoningRequest,
  KodaXToolDefinition,
} from '../types.js';

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
      ...(capability === 'native-effort'
        ? {
            reasoningProfile: {
              effortStrategy: 'openai-chat-effort',
              supportedEfforts: [
                { value: 'low' },
                { value: 'medium' },
                { value: 'high' },
                { value: 'xhigh' },
              ],
              supportsReasoningEffort: true,
            },
          }
        : {}),
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
    effort: 'medium',
    taskType: 'review',
    executionMode: 'pr-review',
  };

  beforeEach(() => {
    process.env.KODAX_CONFIG_FILE = TEST_CONFIG_FILE;
    fs.rmSync(TEST_CONFIG_FILE, { force: true });
  });

  afterEach(() => {
    delete process.env.KODAX_CONFIG_FILE;
    delete process.env.KODAX_DISABLE_PROMPT_CACHE;
    fs.rmSync(TEST_CONFIG_FILE, { force: true });
  });

  it('lowers a verified provider cache affinity key to prompt_cache_key for stream and complete', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(createCompletedOpenAIStream())
      .mockResolvedValueOnce({
        choices: [{
          message: { role: 'assistant', content: 'done', tool_calls: [] },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      });
    const provider = new TestOpenAIProvider(
      'kimi',
      'none',
      { chat: { completions: { create } } },
      { promptCacheAffinity: true },
    );
    const streamOptions = {
      promptCacheKey: 'c'.repeat(64),
    };

    process.env.KODAX_DISABLE_PROMPT_CACHE = '1';
    await runWithScopedConfig({ disablePromptCache: false }, async () => {
      await provider.stream(MESSAGES, TOOLS, 'system', false, streamOptions);
      await provider.complete(MESSAGES, TOOLS, 'system', false, streamOptions);
    });

    expect(create.mock.calls[0]?.[0].prompt_cache_key).toBe('c'.repeat(64));
    expect(create.mock.calls[1]?.[0].prompt_cache_key).toBe('c'.repeat(64));
  });

  it('omits prompt_cache_key when prompt caching is disabled for the run', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(createCompletedOpenAIStream())
      .mockResolvedValueOnce({
        choices: [{
          message: { role: 'assistant', content: 'done', tool_calls: [] },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      });
    const provider = new TestOpenAIProvider(
      'kimi',
      'none',
      { chat: { completions: { create } } },
      { promptCacheAffinity: true },
    );
    const streamOptions = { promptCacheKey: 'c'.repeat(64) };

    await runWithScopedConfig({ disablePromptCache: true }, async () => {
      await provider.stream(MESSAGES, TOOLS, 'system', false, streamOptions);
      await provider.complete(MESSAGES, TOOLS, 'system', false, streamOptions);
    });

    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('prompt_cache_key');
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('prompt_cache_key');
  });

  it('does not send prompt_cache_key to an unverified OpenAI-compatible endpoint', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider(
      'custom-openai-compatible',
      'none',
      { chat: { completions: { create } } },
      { baseUrl: 'https://strict-compatible.example.test/v1' },
    );

    await provider.stream(MESSAGES, TOOLS, 'system', false, {
      promptCacheKey: 'd'.repeat(64),
    });

    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('prompt_cache_key');
  });

  it('sends reasoning_effort for native-effort providers', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('openai', 'native-effort', {
      chat: { completions: { create } },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    expect(create.mock.calls[0]?.[0].reasoning_effort).toBe('medium');
  });

  it('Part 2: a rejected profile shape degrades to a param-free retry (openai-compat)', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('unsupported parameter: reasoning_effort'))
      .mockResolvedValueOnce(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('my-relay', 'native-effort', {
      chat: { completions: { create } },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    expect(create).toHaveBeenCalledTimes(2);
    // Primary attempt applies the profile (reasoning_effort).
    expect(create.mock.calls[0]?.[0].reasoning_effort).toBe('medium');
    // 'none' degradation rung drops the reasoning param — the turn completes instead of
    // re-applying the rejected shape and hard-failing.
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('reasoning_effort');
  });

  it('Part 2: degrades to a param-free retry when a relay rejects the thinking field (DeepSeek dual shape)', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('unknown parameter: thinking'))
      .mockResolvedValueOnce(createCompletedOpenAIStream());
    // DeepSeek's openai-compat reasoning shape sends BOTH thinking and reasoning_effort,
    // so a relay may reject the thinking field rather than reasoning_effort. The fallback
    // must still degrade — the generic "unknown/invalid/unsupported parameter" keywords
    // carry it even though getFallbackTerms('native-effort') only lists reasoning_effort.
    const provider = new TestOpenAIProvider('my-relay', 'native-effort', {
      chat: { completions: { create } },
    }, {
      reasoningProfile: {
        reasoningPreset: 'deepseek-v4-openai',
        effortStrategy: 'openai-chat-effort',
        thinkingStrategy: 'provider-toggle',
        supportedEfforts: [{ value: 'medium', isDefault: true }],
        supportsReasoningEffort: true,
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0].thinking).toEqual({ type: 'enabled' });
    expect(create.mock.calls[0]?.[0].reasoning_effort).toBe('medium');
    // A relay rejecting the thinking field still degrades to a param-free retry.
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('thinking');
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('reasoning_effort');
  });

  it('F3: a passive openai-compat provider (native-toggle, no profile, non-qwen/zhipu) sends NO thinking param on the wire', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    // Mirrors a custom openai-compat provider after F3: native-toggle but no reasoningProfile.
    // The name-gated switch only fires for this.name === 'qwen'/'zhipu', so a relay-named
    // provider must send NOTHING — no Anthropic-shaped thinking field, no reasoning_effort,
    // no enable_thinking. reasoning_content is still parsed (covered elsewhere).
    const provider = new TestOpenAIProvider('my-relay', 'native-toggle', {
      chat: { completions: { create } },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    const params = create.mock.calls[0]?.[0];
    expect(params).not.toHaveProperty('thinking');
    expect(params).not.toHaveProperty('reasoning_effort');
    expect((params.extra_body ?? {}).enable_thinking).toBeUndefined();
  });

  it('passes explicit provider effort values through for native-effort providers', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('openai', 'native-effort', {
      chat: { completions: { create } },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', {
      ...reasoning,
      effort: 'xhigh',
    });

    expect(create.mock.calls[0]?.[0].reasoning_effort).toBe('xhigh');
  });

  it('omits reasoning_effort when explicit effort auto clears the provider field', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('openai', 'native-effort', {
      chat: { completions: { create } },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', {
      ...reasoning,
      effort: 'auto',
    });

    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('reasoning_effort');
  });

  it('enables thinking for the always-on Kimi K2.7 Code preset (v0.7.57 regression fix)', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('kimi', 'native-toggle', {
      chat: { completions: { create } },
    }, {
      reasoningProfile: {
        reasoningPreset: 'kimi-k2.7-code',
        effortStrategy: 'prompt-only',
        defaultEffort: 'high',
        localRejectEfforts: ['none', 'minimal'],
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', { ...reasoning, effort: 'high' });

    expect(create.mock.calls[0]?.[0].thinking).toEqual({ type: 'enabled' });
  });

  it('preserves K3 default and explicit reasoning controls on the OpenAI-compatible wire', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('kimi', 'native-effort', {
      chat: { completions: { create } },
    }, {
      model: 'k3',
      reasoningProfile: {
        reasoningPreset: 'kimi-k3',
        effortStrategy: 'provider-toggle',
        thinkingStrategy: 'provider-toggle',
        defaultEffort: 'max',
        supportedEfforts: [{ value: 'none' }, { value: 'max', isDefault: true }],
        disabledEfforts: ['none'],
        supportsReasoningEffort: true,
        supportsDisabledThinking: true,
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system');
    await provider.stream(MESSAGES, TOOLS, 'system', false);
    await provider.stream(MESSAGES, TOOLS, 'system', { ...reasoning, effort: 'max' });

    expect(create.mock.calls[0]?.[0].thinking).toEqual({ type: 'enabled', effort: 'max' });
    expect(create.mock.calls[1]?.[0].thinking).toEqual({ type: 'disabled' });
    expect(create.mock.calls[2]?.[0].thinking).toEqual({ type: 'enabled', effort: 'max' });
  });

  it('rejects explicit attempts to disable Kimi K2.7 Code before stream or complete hits the wire', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('kimi', 'native-toggle', {
      chat: { completions: { create } },
    }, {
      reasoningProfile: {
        reasoningPreset: 'kimi-k2.7-code',
        effortStrategy: 'prompt-only',
        defaultEffort: 'high',
        localRejectEfforts: ['none', 'minimal'],
      },
    });
    const disabled: KodaXReasoningRequest = {
      ...reasoning,
      enabled: false,
      effort: 'none',
    };

    await expect(provider.stream(MESSAGES, TOOLS, 'system', disabled)).rejects.toThrow(
      'does not support reasoning effort "none"',
    );
    await expect(provider.complete(MESSAGES, TOOLS, 'system', disabled)).rejects.toThrow(
      'does not support reasoning effort "none"',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('sends the Kimi K2.6 disabled-thinking profile when reasoning is explicitly off', async () => {
    const create = vi.fn().mockImplementation((params: { stream?: boolean }) => (
      params.stream
        ? Promise.resolve(createCompletedOpenAIStream())
        : Promise.resolve({
            choices: [
              {
                message: { role: 'assistant', content: 'ok', tool_calls: [] },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
    ));
    const provider = new TestOpenAIProvider('kimi', 'native-toggle', {
      chat: { completions: { create } },
    }, {
      model: 'kimi-k2.6',
      reasoningProfile: {
        reasoningPreset: 'kimi-hybrid-toggle',
        effortStrategy: 'provider-toggle',
        thinkingStrategy: 'provider-toggle',
        supportedEfforts: [
          { value: 'none' },
          { value: 'medium', isDefault: true },
        ],
        disabledEfforts: ['none'],
        supportsDisabledThinking: true,
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', {
      enabled: false,
      effort: 'none',
    });
    await provider.complete(MESSAGES, TOOLS, 'system', {
      enabled: false,
      effort: 'none',
    });

    expect(create.mock.calls[0]?.[0].thinking).toEqual({ type: 'disabled' });
    expect(create.mock.calls[1]?.[0].thinking).toEqual({ type: 'disabled' });
  });

  it('degrades a provider-budget profile when an upstream rejects budget_tokens', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('budget_tokens is unsupported'))
      .mockResolvedValueOnce(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('my-relay', 'native-budget', {
      chat: { completions: { create } },
    }, {
      reasoningProfile: {
        reasoningPreset: 'generic-thinking-toggle',
        effortStrategy: 'provider-budget',
        thinkingStrategy: 'provider-budget',
        supportedEfforts: [{ value: 'medium', isDefault: true }],
        supportsManualThinkingBudget: true,
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0].thinking).toMatchObject({
      type: 'enabled',
      budget_tokens: expect.any(Number),
    });
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('thinking');
  });

  it('sends DeepSeek V4 thinking plus aliased reasoning_effort through reasoning metadata', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('deepseek', 'native-effort', {
      chat: { completions: { create } },
    }, {
      reasoningProfile: {
        reasoningPreset: 'deepseek-v4-openai',
        effortStrategy: 'openai-chat-effort',
        thinkingStrategy: 'provider-toggle',
        supportedEfforts: [
          { value: 'none' },
          { value: 'minimal' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
        effortAliases: { xhigh: 'max' },
        disabledEfforts: ['none', 'minimal'],
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', {
      ...reasoning,
      effort: 'xhigh',
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
  });

  it('resolves GLM-5.2 auto effort to the reasoning model default before lowering', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('zhipu', 'native-effort', {
      chat: { completions: { create } },
    }, {
      reasoningProfile: {
        reasoningPreset: 'zai-glm-5.2',
        effortStrategy: 'openai-chat-effort',
        thinkingStrategy: 'provider-toggle',
        defaultEffort: 'max',
        supportedEfforts: [
          { value: 'high' },
          { value: 'max', isDefault: true },
        ],
        effortAliases: { low: 'high', medium: 'high', xhigh: 'max' },
        disabledEfforts: ['none', 'minimal'],
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', {
      ...reasoning,
      effort: 'auto',
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
  });

  it('sends GLM-5.3 OpenAI-compatible effort using its documented buckets', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('zhipu', 'native-effort', {
      chat: { completions: { create } },
    }, {
      model: 'glm-5.3',
      reasoningProfile: {
        reasoningPreset: 'zai-glm-5.3',
        effortStrategy: 'openai-chat-effort',
        thinkingStrategy: 'provider-toggle',
        defaultEffort: 'max',
        supportedEfforts: [
          { value: 'low' },
          { value: 'high' },
          { value: 'max', isDefault: true },
        ],
        effortAliases: { medium: 'high', xhigh: 'max' },
        disabledEfforts: ['none'],
        supportsReasoningEffort: true,
        supportsDisabledThinking: false,
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', {
      ...reasoning,
      effort: 'medium',
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
  });

  it('maps GLM-5.3 none to low instead of sending unsupported disabled thinking', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('zhipu', 'native-effort', {
      chat: { completions: { create } },
    }, {
      model: 'glm-5.3',
      reasoningProfile: {
        reasoningPreset: 'zai-glm-5.3',
        effortStrategy: 'openai-chat-effort',
        thinkingStrategy: 'provider-toggle',
        defaultEffort: 'max',
        supportedEfforts: [{ value: 'none' }, { value: 'low' }, { value: 'high' }, { value: 'max' }],
        disabledEfforts: ['none'],
        supportsReasoningEffort: true,
        supportsDisabledThinking: false,
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', {
      ...reasoning,
      effort: 'none',
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
    });
  });

  it('sends disabled thinking for OpenAI-compatible disabled efforts through reasoning metadata', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('zhipu', 'native-effort', {
      chat: { completions: { create } },
    }, {
      reasoningProfile: {
        reasoningPreset: 'zai-glm-5.2',
        effortStrategy: 'openai-chat-effort',
        thinkingStrategy: 'provider-toggle',
        supportedEfforts: [
          { value: 'none' },
          { value: 'minimal' },
          { value: 'high' },
          { value: 'max' },
        ],
        disabledEfforts: ['none', 'minimal'],
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', {
      ...reasoning,
      effort: 'minimal',
    });

    expect(create.mock.calls[0]?.[0].thinking).toEqual({ type: 'disabled' });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('reasoning_effort');
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

  it('caps reasoning profile budgetByEffort values with thinkingBudgetCap for qwen-style providers', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('qwen', 'native-budget', {
      chat: { completions: { create } },
    }, {
      thinkingBudgetCap: 12000,
      reasoningProfile: {
        reasoningPreset: 'qwen-hybrid-thinking',
        effortStrategy: 'provider-budget',
        thinkingStrategy: 'provider-budget',
        supportedEfforts: [{ value: 'max' }],
        budgetByEffort: { max: 32000 },
        supportsManualThinkingBudget: true,
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', {
      ...reasoning,
      effort: 'max',
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      extra_body: {
        enable_thinking: true,
        thinking_budget: 12000,
      },
    });
  });

  it('falls back from budget to toggle within the request (in-memory capability fallback)', async () => {
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
  // also keep its slot on the wire. Since v0.7.28 wire-level fix:
  // reasoning_content is *always* attached (default '') when the flag is
  // set, so DeepSeek's strict "every assistant turn must carry the
  // field" contract is satisfied even on turns that contribute no
  // thinking text. Earlier behaviour ('not toHaveProperty') 400-rejected
  // such turns and was the root cause of the cross-provider switch bug.
  it('attaches empty reasoning_content for assistant turn carrying only redacted_thinking', async () => {
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
    // Field must be present (even empty) so DeepSeek thinking-mode
    // accepts the replay; redacted blocks contribute no thinking text
    // so the value collapses to ''.
    expect(assistantWire).toHaveProperty('reasoning_content', '');
    expect(typeof assistantWire.content).toBe('string');
    expect((assistantWire.content as string).length).toBeGreaterThan(0);
  });

  // Cross-provider switch scenario: user runs N turns on an
  // Anthropic-compat provider (e.g., kimi-code, ark-coding) where some
  // assistant turns produce no thinking blocks at all (continuation
  // rounds, short text replies, pre-thinking history). They then /model
  // switch to deepseek. Without the wire-level always-attach, those
  // thinking-less turns would lack reasoning_content and DeepSeek
  // thinking-mode would 400 on the first request. This test locks the
  // contract: every assistant turn gets the field, defaulting to ''.
  it('attaches empty reasoning_content for assistant turn with no thinking blocks', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('deepseek', 'native-effort', {
      chat: { completions: { create } },
    }, {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      replayReasoningContent: true,
    });

    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Run grep for OAuth scopes.' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'grep', input: { pattern: 'oauth' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'no matches' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Got it — no OAuth references in the codebase.' },
        ],
      },
      { role: 'user', content: 'Now check for JWT.' },
    ];

    await provider.stream(messages, TOOLS, 'system', reasoning);

    const requestMessages = create.mock.calls[0]?.[0].messages as Array<Record<string, unknown>>;
    const assistantWires = requestMessages.filter((m) => m.role === 'assistant');
    expect(assistantWires).toHaveLength(2);
    // Both assistant turns — tool-only and text-only — must carry the
    // field. Empty string is fine; what matters is field presence.
    for (const wire of assistantWires) {
      expect(wire).toHaveProperty('reasoning_content', '');
    }
  });

  // Sibling guard: when the flag is unset (e.g., openai proper, qwen
  // before opt-in verification), reasoning_content must NOT be attached
  // even with empty thinking. Sending it as an unknown field could be
  // rejected by strict gateways.
  it('does not attach reasoning_content when flag unset, even on thinking-less turns', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedOpenAIStream());
    const provider = new TestOpenAIProvider('openai', 'native-effort', {
      chat: { completions: { create } },
    }, {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
      // replayReasoningContent: undefined (default off)
    });

    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Hi' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
      },
      { role: 'user', content: 'Continue.' },
    ];

    await provider.stream(messages, TOOLS, 'system', reasoning);

    const requestMessages = create.mock.calls[0]?.[0].messages as Array<Record<string, unknown>>;
    const assistantWire = requestMessages.find((m) => m.role === 'assistant') as Record<string, unknown>;
    expect(assistantWire).not.toHaveProperty('reasoning_content');
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
