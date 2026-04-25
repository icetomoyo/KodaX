import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KodaXCustomProviderConfig } from '../types.js';
import { createCustomProvider } from './custom-provider.js';
import {
  getCustomProvider,
  getCustomProviderList,
  getCustomProviderModels,
  getCustomProviderNames,
  isCustomProviderName,
  registerCustomProviders,
} from './custom-registry.js';
import {
  getAvailableProviderNames,
  isKnownProvider,
  resolveProvider,
} from './resolver.js';

const EXPECTED_NATIVE_CUSTOM_PROFILE = {
  transport: 'native-api',
  conversationSemantics: 'full-history',
  mcpSupport: 'native',
  contextFidelity: 'full',
  toolCallingFidelity: 'full',
  sessionSupport: 'full',
  longRunningSupport: 'full',
  multimodalSupport: 'none',
  evidenceSupport: 'full',
} as const;

const EXPECTED_NATIVE_DEFAULT_PROFILE = {
  transport: 'native-api',
  conversationSemantics: 'full-history',
  mcpSupport: 'none',
  contextFidelity: 'full',
  toolCallingFidelity: 'full',
  sessionSupport: 'full',
  longRunningSupport: 'full',
  multimodalSupport: 'none',
  evidenceSupport: 'full',
} as const;

const OPENAI_CUSTOM: KodaXCustomProviderConfig = {
  name: 'custom-openai',
  protocol: 'openai',
  baseUrl: 'https://example.test/v1',
  apiKeyEnv: 'CUSTOM_OPENAI_API_KEY',
  model: 'custom-main',
  models: ['custom-main', 'custom-alt'],
  supportsThinking: true,
  reasoningCapability: 'native-toggle',
  capabilityProfile: {
    transport: 'native-api',
    conversationSemantics: 'full-history',
    mcpSupport: 'native',
  },
  contextWindow: 123456,
  maxOutputTokens: 4096,
  thinkingBudgetCap: 2048,
};

const ANTHROPIC_CUSTOM: KodaXCustomProviderConfig = {
  name: 'custom-anthropic',
  protocol: 'anthropic',
  baseUrl: 'https://example.test/anthropic',
  apiKeyEnv: 'CUSTOM_ANTHROPIC_API_KEY',
  model: 'claude-custom',
  models: ['claude-custom-fast'],
  supportsThinking: true,
  reasoningCapability: 'native-budget',
};

function cloneConfig(config: KodaXCustomProviderConfig): KodaXCustomProviderConfig {
  return {
    ...config,
    models: config.models ? [...config.models] : undefined,
    capabilityProfile: config.capabilityProfile
      ? { ...config.capabilityProfile }
      : undefined,
  };
}

describe('custom providers', () => {
  afterEach(() => {
    registerCustomProviders([]);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('creates OpenAI-compatible custom providers with the expected metadata', () => {
    vi.stubEnv('CUSTOM_OPENAI_API_KEY', 'test-key');
    const provider = createCustomProvider(cloneConfig(OPENAI_CUSTOM));

    expect(provider.name).toBe('custom-openai');
    expect(provider.isConfigured()).toBe(true);
    expect(provider.getModel()).toBe('custom-main');
    expect(provider.getBaseUrl()).toBe('https://example.test/v1');
    expect(provider.getAvailableModels()).toEqual(['custom-main', 'custom-alt']);
    expect(provider.getConfiguredReasoningCapability()).toBe('native-toggle');
    expect(provider.getCapabilityProfile()).toEqual(EXPECTED_NATIVE_CUSTOM_PROFILE);
    expect(provider.getContextWindow()).toBe(123456);
  });

  it('creates Anthropic-compatible custom providers with the expected metadata', () => {
    vi.stubEnv('CUSTOM_ANTHROPIC_API_KEY', 'test-key');
    const provider = createCustomProvider(cloneConfig(ANTHROPIC_CUSTOM));

    expect(provider.name).toBe('custom-anthropic');
    expect(provider.isConfigured()).toBe(true);
    expect(provider.getModel()).toBe('claude-custom');
    expect(provider.getBaseUrl()).toBe('https://example.test/anthropic');
    expect(provider.getAvailableModels()).toEqual(['claude-custom', 'claude-custom-fast']);
    expect(provider.getConfiguredReasoningCapability()).toBe('native-budget');
  });

  it('rejects invalid custom provider definitions up front', () => {
    expect(() =>
      createCustomProvider({
        ...cloneConfig(OPENAI_CUSTOM),
        model: '',
      }),
    ).toThrowError(/requires name, baseUrl, apiKeyEnv, and model/i);

    expect(() =>
      createCustomProvider({
        ...cloneConfig(OPENAI_CUSTOM),
        protocol: 'bogus' as KodaXCustomProviderConfig['protocol'],
      }),
    ).toThrowError(/unknown protocol/i);

    expect(() =>
      createCustomProvider({
        ...cloneConfig(OPENAI_CUSTOM),
        userAgentMode: 'official' as KodaXCustomProviderConfig['userAgentMode'],
      }),
    ).toThrowError(/unknown useragentmode/i);
  });

  it('tracks registered custom providers without instantiating them', () => {
    vi.stubEnv('CUSTOM_OPENAI_API_KEY', 'configured-key');
    registerCustomProviders([cloneConfig(OPENAI_CUSTOM), cloneConfig(ANTHROPIC_CUSTOM)]);

    expect(isCustomProviderName('custom-openai')).toBe(true);
    expect(getCustomProviderNames()).toEqual(['custom-openai', 'custom-anthropic']);
    expect(getCustomProviderModels('custom-openai')).toEqual(['custom-main', 'custom-alt']);
    expect(getCustomProviderModels('missing-provider')).toBeUndefined();

    const providers = getCustomProviderList();
    expect(providers).toEqual([
      {
        name: 'custom-openai',
        model: 'custom-main',
        models: ['custom-main', 'custom-alt'],
        configured: true,
        reasoningCapability: 'native-toggle',
        capabilityProfile: EXPECTED_NATIVE_CUSTOM_PROFILE,
        custom: true,
      },
      {
        name: 'custom-anthropic',
        model: 'claude-custom',
        models: ['claude-custom', 'claude-custom-fast'],
        configured: false,
        reasoningCapability: 'native-budget',
        capabilityProfile: EXPECTED_NATIVE_DEFAULT_PROFILE,
        custom: true,
      },
    ]);

    providers[0]!.capabilityProfile.mcpSupport = 'none';
    expect(getCustomProviderList()[0]!.capabilityProfile.mcpSupport).toBe('native');
  });

  it('instantiates registered custom providers on demand', () => {
    vi.stubEnv('CUSTOM_OPENAI_API_KEY', 'configured-key');
    registerCustomProviders([cloneConfig(OPENAI_CUSTOM)]);

    const provider = getCustomProvider('custom-openai');

    expect(provider?.name).toBe('custom-openai');
    expect(provider?.getModel()).toBe('custom-main');
    expect(getCustomProvider('missing-provider')).toBeUndefined();
  });

  it('overrides the OpenAI SDK user agent for compatibility gateways', async () => {
    vi.stubEnv('CUSTOM_OPENAI_API_KEY', 'configured-key');
    const provider = createCustomProvider(cloneConfig(OPENAI_CUSTOM)) as any;

    const request = await provider.client.buildRequest({
      method: 'post',
      path: '/chat/completions',
      body: {
        model: provider.getModel(),
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      },
    });

    expect(request.req.headers.get('user-agent')).toBe('KodaX');
  });

  it('keeps the OpenAI SDK user agent when custom providers opt into sdk mode', async () => {
    vi.stubEnv('CUSTOM_OPENAI_API_KEY', 'configured-key');
    const provider = createCustomProvider(
      cloneConfig({
        ...OPENAI_CUSTOM,
        userAgentMode: 'sdk',
      }),
    ) as any;

    const request = await provider.client.buildRequest({
      method: 'post',
      path: '/chat/completions',
      body: {
        model: provider.getModel(),
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      },
    });

    expect(request.req.headers.get('user-agent')).toMatch(/^OpenAI\/JS/i);
  });

  it('overrides the Anthropic SDK user agent for compatibility gateways', async () => {
    vi.stubEnv('CUSTOM_ANTHROPIC_API_KEY', 'configured-key');
    const provider = createCustomProvider(cloneConfig(ANTHROPIC_CUSTOM)) as any;

    const request = await provider.client.buildRequest({
      method: 'post',
      path: '/v1/messages',
      body: {
        model: provider.getModel(),
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      },
    });

    expect(request.req.headers.get('user-agent')).toBe('KodaX');
  });

  it('keeps the Anthropic SDK user agent when custom providers opt into sdk mode', async () => {
    vi.stubEnv('CUSTOM_ANTHROPIC_API_KEY', 'configured-key');
    const provider = createCustomProvider(
      cloneConfig({
        ...ANTHROPIC_CUSTOM,
        userAgentMode: 'sdk',
      }),
    ) as any;

    const request = await provider.client.buildRequest({
      method: 'post',
      path: '/v1/messages',
      body: {
        model: provider.getModel(),
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      },
    });

    expect(request.req.headers.get('user-agent')).toMatch(/^Anthropic\/JS/i);
  });

  it('accepts KodaXModelDescriptor objects in models[] for per-model context windows', () => {
    vi.stubEnv('CUSTOM_OPENAI_API_KEY', 'test-key');
    const provider = createCustomProvider({
      ...cloneConfig(OPENAI_CUSTOM),
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      // Mixed array: legacy string + descriptor object on the same provider
      models: [
        'custom-main',
        { id: 'small-window-alt', contextWindow: 32_000, maxOutputTokens: 4_000 },
      ],
    } as KodaXCustomProviderConfig);

    expect(provider.getAvailableModels()).toEqual(['custom-main', 'small-window-alt']);
    expect(provider.getEffectiveContextWindow('custom-main')).toBe(200_000);
    expect(provider.getEffectiveContextWindow('small-window-alt')).toBe(32_000);
    expect(provider.getEffectiveMaxOutputTokens('small-window-alt')).toBe(4_000);
    expect(provider.getEffectiveMaxOutputTokens('custom-main')).toBe(32_000);
  });

  it('exposes descriptor-form custom models through the registry helpers as id strings', () => {
    vi.stubEnv('CUSTOM_OPENAI_API_KEY', 'test-key');
    registerCustomProviders([
      {
        ...cloneConfig(OPENAI_CUSTOM),
        models: [
          'custom-main',
          { id: 'small-window-alt', contextWindow: 32_000 },
        ],
      } as KodaXCustomProviderConfig,
    ]);

    expect(getCustomProviderModels('custom-openai')).toEqual([
      'custom-main',
      'small-window-alt',
    ]);

    const list = getCustomProviderList();
    expect(list[0]?.models).toEqual(['custom-main', 'small-window-alt']);
  });

  it('rejects duplicate custom provider names during registration', () => {
    expect(() =>
      registerCustomProviders([
        cloneConfig(OPENAI_CUSTOM),
        cloneConfig({ ...OPENAI_CUSTOM, baseUrl: 'https://duplicate.test/v1' }),
      ]),
    ).toThrowError(/duplicate custom provider name/i);
  });

  it('rejects invalid userAgentMode during registration without mutating the existing registry', () => {
    vi.stubEnv('CUSTOM_OPENAI_API_KEY', 'configured-key');
    registerCustomProviders([cloneConfig(OPENAI_CUSTOM)]);

    expect(() =>
      registerCustomProviders([
        cloneConfig({
          ...ANTHROPIC_CUSTOM,
          userAgentMode: 'official' as KodaXCustomProviderConfig['userAgentMode'],
        }),
      ]),
    ).toThrowError(/unknown useragentmode/i);

    expect(getCustomProviderNames()).toEqual(['custom-openai']);
    expect(getCustomProvider('custom-openai')?.getModel()).toBe('custom-main');
  });

  it('warns when a custom provider shadows a built-in one, while the built-in still wins', () => {
    vi.stubEnv('OPENAI_API_KEY', 'built-in-key');
    vi.stubEnv('CUSTOM_OPENAI_API_KEY', 'custom-key');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    registerCustomProviders([
      {
        ...cloneConfig(OPENAI_CUSTOM),
        name: 'openai',
        model: 'shadow-model',
      },
    ]);

    const provider = resolveProvider('openai');

    expect(provider.getModel()).toBe('gpt-5.3-codex');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('shadows a built-in provider'),
    );
  });

  it('resolves custom providers after checking the built-in registry first', () => {
    vi.stubEnv('CUSTOM_OPENAI_API_KEY', 'configured-key');
    registerCustomProviders([cloneConfig(OPENAI_CUSTOM)]);

    expect(isKnownProvider('custom-openai')).toBe(true);
    expect(isKnownProvider('openai')).toBe(true);
    expect(isKnownProvider('missing-provider')).toBe(false);

    const provider = resolveProvider('custom-openai');

    expect(provider.name).toBe('custom-openai');
    expect(provider.getModel()).toBe('custom-main');
    expect(getAvailableProviderNames()).toContain('custom-openai');
  });

  it('reports both built-in and custom providers when resolution fails', () => {
    registerCustomProviders([cloneConfig(OPENAI_CUSTOM)]);

    expect(() => resolveProvider('missing-provider')).toThrowError(
      /Unknown provider: missing-provider\. Available:/,
    );
    expect(() => resolveProvider('missing-provider')).toThrowError(/custom-openai/);
    expect(() => resolveProvider('missing-provider')).toThrowError(/openai/);
  });
});
