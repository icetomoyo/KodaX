import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import { KODAX_PROVIDERS } from './registry.js';
import { sideQuery } from '../side-query.js';
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
    configOverrides: Partial<KodaXProviderConfig> = {},
  ) {
    super();
    this.config = {
      apiKeyEnv: 'TEST_API_KEY',
      model: 'test-model',
      supportsThinking: capability !== 'prompt-only',
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

describe('anthropic reasoning capability', () => {
  const reasoning: KodaXReasoningRequest = {
    enabled: true,
    effort: 'high',
    taskType: 'plan',
    executionMode: 'planning',
  };

  beforeEach(() => {
    process.env.KODAX_CONFIG_FILE = TEST_CONFIG_FILE;
    fs.rmSync(TEST_CONFIG_FILE, { force: true });
  });

  afterEach(() => {
    delete process.env.KODAX_CONFIG_FILE;
    fs.rmSync(TEST_CONFIG_FILE, { force: true });
  });

  it('falls back from budget to toggle within the request (in-memory capability fallback)', async () => {
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

  it('normalizes Qwen cache creation tokens into total input usage', async () => {
    const create = vi.fn().mockResolvedValue(
      createCompletedAnthropicStream({
        startUsage: {
          input_tokens: 6,
          cache_creation_input_tokens: 25_408,
          cache_read_input_tokens: 0,
        },
        deltaUsage: {
          output_tokens: 4_683,
        },
      }),
    );
    const provider = new TestAnthropicProvider('native-budget', {
      messages: { create },
    });

    const result = await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    expect(result.usage).toEqual({
      inputTokens: 25_414,
      outputTokens: 4_683,
      totalTokens: 30_097,
      cachedReadTokens: 0,
      cachedWriteTokens: 25_408,
    });
  });

  it('preserves provider-reported zero cache usage distinctly from missing fields', async () => {
    const create = vi.fn().mockResolvedValue(
      createCompletedAnthropicStream({
        startUsage: {
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
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

    expect(result.usage).toMatchObject({
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    });
  });

  it('keeps absent provider cache usage fields undefined', async () => {
    const create = vi.fn().mockResolvedValue(
      createCompletedAnthropicStream({
        startUsage: { input_tokens: 100 },
        deltaUsage: { output_tokens: 40 },
      }),
    );
    const provider = new TestAnthropicProvider('native-budget', {
      messages: { create },
    });

    const result = await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    expect(result.usage).not.toHaveProperty('cachedReadTokens');
    expect(result.usage).not.toHaveProperty('cachedWriteTokens');
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

  it('Part 2: a rejected profile wire shape degrades to a param-free retry (no hard fail)', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('unsupported parameter: thinking'))
      .mockResolvedValueOnce(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-toggle', {
      messages: { create },
    }, {
      reasoningProfile: {
        effortStrategy: 'anthropic-reasoning-effort',
        thinkingStrategy: 'provider-toggle',
        defaultEffort: 'high',
        supportedEfforts: [{ value: 'high', isDefault: true }],
        supportsReasoningEffort: true,
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    expect(create).toHaveBeenCalledTimes(2);
    // Primary attempt applies the profile shape (enabled + reasoning_effort).
    expect(create.mock.calls[0]?.[0].thinking).toEqual({ type: 'enabled' });
    expect(create.mock.calls[0]?.[0].reasoning_effort).toBe('high');
    // Degradation rung drops ALL reasoning params — the turn completes instead of 400.
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('thinking');
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('reasoning_effort');
  });

  it('B1: anthropic-reasoning-effort sends {type:enabled} + reasoning_effort, not adaptive', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-effort', {
      messages: { create },
    }, {
      reasoningProfile: {
        effortStrategy: 'anthropic-reasoning-effort',
        thinkingStrategy: 'provider-toggle',
        defaultEffort: 'high',
        supportedEfforts: [{ value: 'low' }, { value: 'high', isDefault: true }],
        supportsReasoningEffort: true,
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', reasoning);

    const kwargs = create.mock.calls[0]?.[0];
    // Non-Claude shape: enabled + reasoning_effort, never adaptive / budget_tokens.
    expect(kwargs.thinking).toEqual({ type: 'enabled' });
    expect(kwargs.thinking).not.toHaveProperty('budget_tokens');
    expect(kwargs).not.toHaveProperty('output_config');
    expect(kwargs.reasoning_effort).toBe('high');
  });

  it('B1: anthropic-reasoning-effort disables via {type:disabled} for the off rung', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-effort', {
      messages: { create },
    }, {
      reasoningProfile: {
        effortStrategy: 'anthropic-reasoning-effort',
        thinkingStrategy: 'provider-toggle',
        supportedEfforts: [{ value: 'none' }, { value: 'high', isDefault: true }],
        disabledEfforts: ['none'],
        supportsDisabledThinking: true,
        supportsReasoningEffort: true,
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', {
      enabled: true,
      effort: 'none',
      taskType: 'plan',
      executionMode: 'planning',
    });

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.thinking).toEqual({ type: 'disabled' });
    expect(kwargs).not.toHaveProperty('reasoning_effort');
  });

  it('disables provider-budget thinking when the capability explicitly supports it', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-budget', {
      messages: { create },
    }, {
      reasoningProfile: {
        reasoningPreset: 'qwen-hybrid-thinking',
        effortStrategy: 'provider-budget',
        thinkingStrategy: 'provider-budget',
        supportedEfforts: [{ value: 'none' }, { value: 'low' }],
        budgetByEffort: { low: 6000 },
        disabledEfforts: ['none'],
        supportsManualThinkingBudget: true,
        supportsDisabledThinking: true,
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', {
      enabled: true,
      effort: 'none',
      taskType: 'plan',
      executionMode: 'planning',
    });

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.thinking).toEqual({ type: 'disabled' });
    expect(kwargs.thinking).not.toHaveProperty('budget_tokens');
  });

  it('caps reasoning profile budgetByEffort values with thinkingBudgetCap for native-budget providers', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-budget', {
      messages: { create },
    }, {
      thinkingBudgetCap: 8000,
      reasoningProfile: {
        reasoningPreset: 'anthropic-budget',
        effortStrategy: 'provider-budget',
        thinkingStrategy: 'anthropic-budget',
        supportedEfforts: [{ value: 'high' }],
        budgetByEffort: { high: 16000 },
        supportsManualThinkingBudget: true,
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', {
      ...reasoning,
      effort: 'high',
    });

    expect(create.mock.calls[0]?.[0].thinking).toMatchObject({
      type: 'enabled',
      budget_tokens: 8000,
    });
  });

  it('keeps an always-on budgeted side query request internally consistent', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-budget', {
      messages: { create },
    }, {
      reasoningProfile: {
        reasoningPreset: 'qwen-hybrid-thinking',
        effortStrategy: 'provider-budget',
        thinkingStrategy: 'provider-budget',
        defaultEffort: 'medium',
        supportedEfforts: [
          { value: 'low' },
          { value: 'medium', isDefault: true },
        ],
        budgetByEffort: { low: 6000, medium: 10000 },
        localRejectEfforts: ['none', 'minimal'],
        supportsManualThinkingBudget: true,
        supportsDisabledThinking: false,
      },
    });

    await sideQuery({
      provider,
      model: 'test-model',
      system: 'Return only OK.',
      messages: MESSAGES,
      querySource: 'auto_mode',
      maxOutputTokens: 256,
    });

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.max_tokens).toBe(1280);
    expect(kwargs.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 1024,
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

  it('sends adaptive thinking plus output effort for native-adaptive providers', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-adaptive', {
      messages: { create },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', {
      ...reasoning,
      effort: 'high',
    });

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.thinking).toMatchObject({
      type: 'adaptive',
    });
    expect(kwargs.thinking).not.toHaveProperty('budget_tokens');
    expect(kwargs.output_config).toEqual({ effort: 'high' });
  });

  it('omits output effort for native-adaptive providers when effort is explicit auto', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-adaptive', {
      messages: { create },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', {
      ...reasoning,
      effort: 'auto',
    });

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.thinking).toMatchObject({
      type: 'adaptive',
    });
    expect(kwargs).not.toHaveProperty('output_config');
  });

  it('adds the effort beta header only when a reasoning profile explicitly requires it', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-adaptive', {
      messages: { create },
    }, {
      reasoningProfile: {
        reasoningPreset: 'claude-adaptive-max',
        effortStrategy: 'anthropic-output-effort',
        thinkingStrategy: 'anthropic-adaptive',
        supportedEfforts: [
          { value: 'high', isDefault: true },
          { value: 'max' },
        ],
        requiresEffortBetaHeader: true,
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', {
      ...reasoning,
      effort: 'high',
    });

    expect(create.mock.calls[0]?.[0].output_config).toEqual({ effort: 'high' });
    expect(create.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'anthropic-beta': 'effort-2025-11-24' },
    });
  });

  it('routes the built-in deepseek provider through the Anthropic output_config dialect', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key');
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = KODAX_PROVIDERS.deepseek();
    Reflect.set(provider, '_client', { messages: { create } });

    await provider.stream(MESSAGES, TOOLS, 'system', { ...reasoning, effort: 'xhigh' });

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.model).toBe('deepseek-flash');
    // deepseek-v4-anthropic preset shape: thinking enabled + Claude's
    // output_config.effort. Official endpoint parses output_config.effort
    // with a typed enum (verified live 2026-09-10); xhigh aliases to max.
    expect(kwargs.thinking).toMatchObject({ type: 'enabled' });
    expect(kwargs.output_config).toEqual({ effort: 'max' });
  });

  it('lowers built-in deepseek auto effort to the ladder default', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key');
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = KODAX_PROVIDERS.deepseek();
    Reflect.set(provider, '_client', { messages: { create } });

    await provider.stream(MESSAGES, TOOLS, 'system', { ...reasoning, effort: 'auto' });

    expect(create.mock.calls[0]?.[0].output_config).toEqual({ effort: 'high' });
  });

  it('sends GLM-5.2 top-level reasoning_effort with aliases through reasoning metadata', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-effort', {
      messages: { create },
    }, {
      reasoningProfile: {
        reasoningPreset: 'zai-glm-5.2',
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

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.thinking).toEqual({ type: 'enabled' });
    expect(kwargs.reasoning_effort).toBe('max');
  });

  it('sends GLM-5.3 effort through the Anthropic output_config contract', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-effort', {
      messages: { create },
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

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.thinking).toEqual({ type: 'adaptive' });
    expect(kwargs.output_config).toEqual({ effort: 'high' });
    expect(kwargs).not.toHaveProperty('reasoning_effort');
  });

  it('maps GLM-5.3 none to low instead of sending unsupported disabled thinking', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-effort', {
      messages: { create },
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

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.thinking).toEqual({ type: 'adaptive' });
    expect(kwargs.output_config).toEqual({ effort: 'low' });
    expect(kwargs).not.toHaveProperty('reasoning_effort');
  });

  it('enables thinking for the always-on Kimi K2.7 Code preset (v0.7.57 regression fix)', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-toggle', {
      messages: { create },
    }, {
      reasoningProfile: {
        reasoningPreset: 'kimi-k2.7-code',
        effortStrategy: 'prompt-only',
        defaultEffort: 'high',
        localRejectEfforts: ['none', 'minimal'],
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', { ...reasoning, effort: 'high' });

    // Must send the enable param — without it kimi-for-coding emits no reasoning_content.
    expect(create.mock.calls[0]?.[0].thinking).toEqual({ type: 'enabled' });
  });

  it('sends Kimi K3 effort inside thinking and defaults omitted reasoning to high', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-effort', {
      messages: { create },
    }, {
      model: 'k3',
      reasoningProfile: {
        reasoningPreset: 'kimi-k3',
        effortStrategy: 'anthropic-reasoning-effort',
        thinkingStrategy: 'provider-toggle',
        defaultEffort: 'high',
        supportedEfforts: [
          { value: 'none' },
          { value: 'low' },
          { value: 'high', isDefault: true },
          { value: 'max' },
        ],
        disabledEfforts: ['none'],
        supportsReasoningEffort: true,
        supportsDisabledThinking: true,
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system');

    expect(create.mock.calls[0]?.[0].thinking).toEqual({
      type: 'enabled',
      effort: 'high',
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('reasoning_effort');
  });

  it('sends the direct K3 256K model id with the K3 reasoning profile', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const k3Profile = {
      reasoningPreset: 'kimi-k3' as const,
      effortStrategy: 'provider-toggle' as const,
      thinkingStrategy: 'provider-toggle' as const,
      defaultEffort: 'high',
      supportedEfforts: [{ value: 'none' }, { value: 'high' }, { value: 'max' }],
      disabledEfforts: ['none'],
      supportsReasoningEffort: true,
      supportsDisabledThinking: true,
    };
    const provider = new TestAnthropicProvider('native-toggle', {
      messages: { create },
    }, {
      model: 'k3-256k',
      models: [
        {
          id: 'k3',
          reasoningCapability: 'native-effort',
          reasoningProfile: k3Profile,
        },
        {
          id: 'k3-256k',
          contextWindow: 262_144,
          reasoningCapability: 'native-effort',
          reasoningProfile: k3Profile,
        },
      ],
    });

    await provider.stream(MESSAGES, TOOLS, 'system', undefined, {
      modelOverride: 'k3-256k',
    });

    expect(provider.getEffectiveContextWindow('k3-256k')).toBe(262_144);
    expect(provider.getReasoningProfile('k3-256k')).toMatchObject({
      reasoningPreset: 'kimi-k3',
    });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: 'k3-256k',
      thinking: { type: 'enabled', effort: 'high' },
    });
  });

  it('sends explicit Kimi K3 effort aliases and disabled thinking on the K3 wire', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-effort', {
      messages: { create },
    }, {
      model: 'k3',
      reasoningProfile: {
        reasoningPreset: 'kimi-k3',
        effortStrategy: 'anthropic-reasoning-effort',
        thinkingStrategy: 'provider-toggle',
        defaultEffort: 'max',
        supportedEfforts: [{ value: 'none' }, { value: 'low' }, { value: 'high' }, { value: 'max' }],
        effortAliases: { medium: 'high', xhigh: 'max' },
        disabledEfforts: ['none'],
        supportsReasoningEffort: true,
        supportsDisabledThinking: true,
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', { ...reasoning, effort: 'xhigh' });
    await provider.stream(MESSAGES, TOOLS, 'system', { ...reasoning, effort: 'none' });

    expect(create.mock.calls[0]?.[0].thinking).toEqual({ type: 'enabled', effort: 'max' });
    expect(create.mock.calls[1]?.[0].thinking).toEqual({ type: 'disabled' });
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('reasoning_effort');
  });

  it('honors legacy Kimi K3 reasoning-off controls instead of treating them as omitted', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-effort', {
      messages: { create },
    }, {
      model: 'k3',
      reasoningProfile: {
        reasoningPreset: 'kimi-k3',
        effortStrategy: 'provider-toggle',
        thinkingStrategy: 'provider-toggle',
        defaultEffort: 'max',
        supportedEfforts: [{ value: 'none' }, { value: 'max' }],
        disabledEfforts: ['none'],
        supportsReasoningEffort: true,
        supportsDisabledThinking: true,
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', false);
    await provider.stream(MESSAGES, TOOLS, 'system', { enabled: false });

    expect(create.mock.calls[0]?.[0].thinking).toEqual({ type: 'disabled' });
    expect(create.mock.calls[1]?.[0].thinking).toEqual({ type: 'disabled' });
  });

  it('enables thinking for the always-on MiniMax M2.7 preset (v0.7.57 regression fix)', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-toggle', {
      messages: { create },
    }, {
      reasoningProfile: {
        reasoningPreset: 'minimax-m2-always',
        effortStrategy: 'prompt-only',
        defaultEffort: 'high',
        localRejectEfforts: ['none', 'minimal'],
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', { ...reasoning, effort: 'high' });

    expect(create.mock.calls[0]?.[0].thinking).toEqual({ type: 'enabled' });
  });

  it('rejects impossible Kimi K2.7 Code disabling efforts locally', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-toggle', {
      messages: { create },
    }, {
      reasoningProfile: {
        reasoningPreset: 'kimi-k2.7-code',
        effortStrategy: 'prompt-only',
        localRejectEfforts: ['none', 'minimal'],
      },
    });

    await expect(provider.stream(MESSAGES, TOOLS, 'system', {
      ...reasoning,
      effort: 'none',
    })).rejects.toThrow(/does not support reasoning effort "none"/);
    expect(create).not.toHaveBeenCalled();
  });

  it('sends disabled thinking for MiniMax M3 disabling efforts', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider('native-adaptive', {
      messages: { create },
    }, {
      reasoningProfile: {
        reasoningPreset: 'minimax-m3',
        effortStrategy: 'provider-toggle',
        thinkingStrategy: 'anthropic-adaptive',
        disabledEfforts: ['none', 'minimal'],
        supportedEfforts: [
          { value: 'none' },
          { value: 'minimal' },
          { value: 'medium' },
        ],
      },
    });

    await provider.stream(MESSAGES, TOOLS, 'system', {
      ...reasoning,
      effort: 'minimal',
    });

    expect(create.mock.calls[0]?.[0].thinking).toEqual({ type: 'disabled' });
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
    // Two redacted_thinking blocks back-to-back must not bleed state —    // the second block's data must not leak into the first, and an empty
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
