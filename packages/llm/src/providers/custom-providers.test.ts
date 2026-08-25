import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KodaXCustomProviderConfig, KodaXReasoningProfile } from '../types.js';
import { createCustomProvider } from './custom-provider.js';
import {
  getCustomProvider,
  getCustomProviderCapabilityProfile,
  getCustomProviderList,
  getCustomModelCapabilities,
  getCustomProviderModelDescriptors,
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
    // F3: openai-compat native-toggle stays PASSIVE — KodaX must NOT synthesize a
    // generic-thinking-toggle profile, because that injects the Anthropic-shaped
    // thinking:{type:'enabled'} object that OpenAI-style relays reject/ignore (the
    // v0.7.57 relay-deepseek regression). With no profile the name-gated capability
    // switch sends nothing for a custom provider; reasoning_content is parsed
    // unconditionally so thinking still surfaces if the endpoint emits it.
    expect(provider.getReasoningProfile()).toBeUndefined();
    expect(provider.getCapabilityProfile()).toEqual(EXPECTED_NATIVE_CUSTOM_PROFILE);
    expect(provider.getContextWindow()).toBe(123456);
  });

  it('F3: native-toggle is protocol-aware — passive on openai, enable-toggle on anthropic', () => {
    vi.stubEnv('CUSTOM_TOGGLE_OPENAI_API_KEY', 'test-key');
    vi.stubEnv('CUSTOM_TOGGLE_ANTHROPIC_API_KEY', 'test-key');

    // openai-compat: no profile synthesized → no Anthropic-shaped thinking object
    // reaches the wire (relays reject it). reasoning_content is parsed regardless.
    const openai = createCustomProvider({
      name: 'toggle-openai',
      protocol: 'openai',
      baseUrl: 'https://toggle.example/v1',
      apiKeyEnv: 'CUSTOM_TOGGLE_OPENAI_API_KEY',
      model: 'toggle-model',
      supportsThinking: true,
      reasoningCapability: 'native-toggle',
    });
    expect(openai.getReasoningProfile()).toBeUndefined();

    // anthropic-compat: bare thinking:{type:'enabled'} is the correct non-Claude
    // shape (matches built-in zhipu/kimi/minimax), so the toggle profile stays.
    const anthropic = createCustomProvider({
      name: 'toggle-anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://toggle.example/anthropic',
      apiKeyEnv: 'CUSTOM_TOGGLE_ANTHROPIC_API_KEY',
      model: 'toggle-model',
      supportsThinking: true,
      reasoningCapability: 'native-toggle',
    });
    expect(anthropic.getReasoningProfile()).toMatchObject({
      reasoningPreset: 'generic-thinking-toggle',
      thinkingStrategy: 'provider-toggle',
    });
  });

  it('F3: bare supportsThinking is passive on openai, enable-toggle on anthropic', () => {
    vi.stubEnv('CUSTOM_BARE_OPENAI_API_KEY', 'test-key');
    vi.stubEnv('CUSTOM_BARE_ANTHROPIC_API_KEY', 'test-key');

    const openai = createCustomProvider({
      name: 'bare-openai',
      protocol: 'openai',
      baseUrl: 'https://bare.example/v1',
      apiKeyEnv: 'CUSTOM_BARE_OPENAI_API_KEY',
      model: 'bare-model',
      supportsThinking: true,
    });
    expect(openai.getReasoningProfile()).toBeUndefined();

    const anthropic = createCustomProvider({
      name: 'bare-anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://bare.example/anthropic',
      apiKeyEnv: 'CUSTOM_BARE_ANTHROPIC_API_KEY',
      model: 'bare-model',
      supportsThinking: true,
    });
    expect(anthropic.getReasoningProfile()).toMatchObject({
      reasoningPreset: 'generic-thinking-toggle',
      thinkingStrategy: 'provider-toggle',
    });
  });

  it('creates custom provider reasoning profiles from reasoningPreset templates', () => {
    vi.stubEnv('CUSTOM_GLM_API_KEY', 'test-key');
    const provider = createCustomProvider({
      name: 'custom-glm',
      protocol: 'openai',
      baseUrl: 'https://glm.example/v1',
      apiKeyEnv: 'CUSTOM_GLM_API_KEY',
      model: 'glm-5.2',
      reasoningPreset: 'zai-glm-5.2',
      reasoning: { defaultEffort: 'high' },
      models: [
        { id: 'kimi-code', reasoningPreset: 'kimi-k2.7-code' },
        { id: 'k3', reasoningPreset: 'kimi-k3' },
      ],
    });

    expect(provider.getConfiguredReasoningCapability()).toBe('native-effort');
    expect(provider.getReasoningProfile('glm-5.2')).toMatchObject({
      reasoningPreset: 'zai-glm-5.2',
      effortStrategy: 'openai-chat-effort',
      defaultEffort: 'high',
    });
    expect(provider.getReasoningProfile('kimi-code')).toMatchObject({
      reasoningPreset: 'kimi-k2.7-code',
      effortStrategy: 'prompt-only',
      localRejectEfforts: ['none', 'minimal'],
    });
    expect(provider.getReasoningProfile('k3')).toMatchObject({
      reasoningPreset: 'kimi-k3',
      effortStrategy: 'provider-toggle',
      defaultEffort: 'high',
      supportedEfforts: expect.arrayContaining([
        expect.objectContaining({ value: 'low' }),
        expect.objectContaining({ value: 'high', isDefault: true }),
        expect.objectContaining({ value: 'max' }),
      ]),
    });
  });

  it('migrates the legacy DeepSeek preset according to the configured model', () => {
    const flash = createCustomProvider({
      name: 'custom-deepseek-flash',
      protocol: 'openai',
      baseUrl: 'https://deepseek.example/v1',
      apiKeyEnv: 'CUSTOM_DEEPSEEK_FLASH_API_KEY',
      model: 'deepseek-v4-flash',
      reasoningPreset: 'deepseek-v4-openai',
    });
    const pro = createCustomProvider({
      name: 'custom-deepseek-pro',
      protocol: 'openai',
      baseUrl: 'https://deepseek.example/v1',
      apiKeyEnv: 'CUSTOM_DEEPSEEK_PRO_API_KEY',
      model: 'deepseek-v4-pro',
      reasoningPreset: 'deepseek-v4-openai',
    });
    const mixed = createCustomProvider({
      name: 'custom-deepseek-mixed',
      protocol: 'openai',
      baseUrl: 'https://deepseek.example/v1',
      apiKeyEnv: 'CUSTOM_DEEPSEEK_MIXED_API_KEY',
      model: 'deepseek-v4-flash',
      models: ['deepseek-v4-pro'],
      reasoningPreset: 'deepseek-v4-openai',
    });

    expect(flash.getReasoningProfile()?.effortAliases).toEqual({
      medium: 'high',
      xhigh: 'high',
    });
    expect(pro.getReasoningProfile()?.effortAliases).toEqual({
      low: 'high',
      medium: 'high',
      xhigh: 'max',
    });
    expect(mixed.getReasoningProfile('deepseek-v4-pro')?.effortAliases).toEqual({
      low: 'high',
      medium: 'high',
      xhigh: 'max',
    });

    registerCustomProviders([{
      name: 'custom-deepseek-mixed',
      protocol: 'openai',
      baseUrl: 'https://deepseek.example/v1',
      apiKeyEnv: 'CUSTOM_DEEPSEEK_MIXED_API_KEY',
      model: 'deepseek-v4-flash',
      models: ['deepseek-v4-pro'],
      reasoningPreset: 'deepseek-v4-openai',
    }]);
    expect(
      getCustomModelCapabilities('custom-deepseek-mixed', 'deepseek-v4-pro')
        ?.reasoningProfile?.effortAliases,
    ).toEqual({
      low: 'high',
      medium: 'high',
      xhigh: 'max',
    });
  });

  it('loads deprecated reasoningCapabilityV2 custom-provider fields as reasoningProfile', () => {
    vi.stubEnv('CUSTOM_LEGACY_PROFILE_API_KEY', 'test-key');
    const legacyConfig: KodaXCustomProviderConfig & {
      reasoningCapabilityV2: KodaXReasoningProfile;
    } = {
      name: 'custom-legacy-profile',
      protocol: 'openai',
      baseUrl: 'https://legacy.example/v1',
      apiKeyEnv: 'CUSTOM_LEGACY_PROFILE_API_KEY',
      model: 'legacy-model',
      reasoningCapability: 'native-effort',
      reasoningCapabilityV2: {
        reasoningPreset: 'openai-chat-reasoning',
        effortStrategy: 'openai-chat-effort',
        defaultEffort: 'medium',
      },
    };

    const provider = createCustomProvider(legacyConfig);

    expect(provider.getReasoningProfile()).toMatchObject({
      reasoningPreset: 'openai-chat-reasoning',
      effortStrategy: 'openai-chat-effort',
    });
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
    expect(provider.getReasoningProfile()).toMatchObject({
      reasoningPreset: 'anthropic-budget',
      effortStrategy: 'provider-budget',
      thinkingStrategy: 'anthropic-budget',
    });
  });

  it('maps legacy supportsThinking false to a disabled reasoning profile', () => {
    vi.stubEnv('CUSTOM_OPENAI_API_KEY', 'test-key');
    const provider = createCustomProvider({
      ...cloneConfig(OPENAI_CUSTOM),
      supportsThinking: false,
      reasoningCapability: undefined,
    });

    expect(provider.getConfiguredReasoningCapability()).toBe('none');
    expect(provider.getReasoningProfile()).toMatchObject({
      reasoningPreset: 'none',
      effortStrategy: 'none',
    });
  });

  it('builds a profile from the friendly reasoning { efforts, default } form (off → disable)', () => {
    vi.stubEnv('CUSTOM_SIMPLE_API_KEY', 'test-key');
    const provider = createCustomProvider({
      name: 'custom-simple',
      protocol: 'openai',
      baseUrl: 'https://simple.example/v1',
      apiKeyEnv: 'CUSTOM_SIMPLE_API_KEY',
      model: 'simple-model',
      reasoning: { efforts: ['off', 'low', 'high', 'max'], default: 'high' },
    });

    const profile = provider.getReasoningProfile();
    expect(profile?.effortStrategy).toBe('openai-chat-effort');
    expect(profile?.supportedEfforts?.map((p) => p.value)).toEqual([
      'none', 'low', 'high', 'max',
    ]);
    expect(profile?.defaultEffort).toBe('high');
    expect(profile?.supportsDisabledThinking).toBe(true);
    expect(profile?.disabledEfforts).toEqual(['none']);
    expect(profile?.supportsReasoningEffort).toBe(true);
  });

  it('B1: friendly form on anthropic-compat maps to enabled+reasoning_effort (non-Claude), not adaptive', () => {
    vi.stubEnv('CUSTOM_SIMPLE_ANT_API_KEY', 'test-key');
    const provider = createCustomProvider({
      name: 'custom-simple-ant',
      protocol: 'anthropic',
      baseUrl: 'https://simple-ant.example',
      apiKeyEnv: 'CUSTOM_SIMPLE_ANT_API_KEY',
      model: 'glm-simple',
      reasoning: { efforts: ['low', 'high'], default: 'high' },
    });
    // Non-Claude anthropic-compat endpoints (zhipu/deepseek) take {type:'enabled'} +
    // reasoning_effort, not Claude's adaptive shape. Omitting `off` means the
    // friendly declaration explicitly says thinking cannot be disabled.
    expect(provider.getReasoningProfile()).toMatchObject({
      effortStrategy: 'anthropic-reasoning-effort',
      thinkingStrategy: 'provider-toggle',
      supportsDisabledThinking: false,
      localRejectEfforts: ['none'],
    });
  });

  it('maps reasoning: "none" to a disabled profile', () => {
    vi.stubEnv('CUSTOM_NONE_API_KEY', 'test-key');
    const provider = createCustomProvider({
      name: 'custom-none',
      protocol: 'openai',
      baseUrl: 'https://none.example/v1',
      apiKeyEnv: 'CUSTOM_NONE_API_KEY',
      model: 'none-model',
      reasoning: 'none',
    });
    expect(provider.getReasoningProfile()).toMatchObject({
      reasoningPreset: 'none',
      effortStrategy: 'none',
    });
  });

  it('prefers the friendly reasoning form over a deprecated reasoningPreset', () => {
    vi.stubEnv('CUSTOM_PREC_API_KEY', 'test-key');
    const provider = createCustomProvider({
      name: 'custom-prec',
      protocol: 'openai',
      baseUrl: 'https://prec.example/v1',
      apiKeyEnv: 'CUSTOM_PREC_API_KEY',
      model: 'prec-model',
      reasoningPreset: 'zai-glm-5.2', // deprecated; should be overridden
      reasoning: { efforts: ['low', 'medium'], default: 'low' },
    });
    const profile = provider.getReasoningProfile();
    expect(profile?.reasoningPreset).toBeUndefined(); // built fresh, not from preset
    expect(profile?.supportedEfforts?.map((p) => p.value)).toEqual(['low', 'medium']);
    expect(profile?.defaultEffort).toBe('low');
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

    expect(() =>
      createCustomProvider({
        ...cloneConfig(OPENAI_CUSTOM),
        promptCacheAffinity: 'yes' as unknown as boolean,
      }),
    ).toThrowError(/promptcacheaffinity must be a boolean/i);

    expect(() =>
      createCustomProvider({
        ...cloneConfig(OPENAI_CUSTOM),
        maxOutputTokensField: 'completion_limit' as unknown as KodaXCustomProviderConfig['maxOutputTokensField'],
      }),
    ).toThrowError(/maxoutputtokensfield must be "max_tokens" or "max_completion_tokens"/i);

    expect(() =>
      createCustomProvider({
        ...cloneConfig(ANTHROPIC_CUSTOM),
        maxOutputTokensField: 'max_tokens',
      }),
    ).toThrowError(/maxoutputtokensfield is only valid for protocol="openai"/i);
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

    // F3: openai-compat native-toggle is passive — no profile synthesized (KodaX
    // must not inject the Anthropic-shaped thinking object that OpenAI relays reject).
    // The capability label is still surfaced; the wire stays clean.
    expect(getCustomModelCapabilities('custom-openai', 'custom-main')).toMatchObject({
      reasoningCapability: 'native-toggle',
      reasoningProfile: undefined,
      thinkingBudgetCap: 2048,
    });
    expect(getCustomModelCapabilities('custom-anthropic', 'claude-custom')).toMatchObject({
      reasoningCapability: 'native-budget',
      reasoningProfile: {
        reasoningPreset: 'anthropic-budget',
        effortStrategy: 'provider-budget',
      },
    });
  });

  it('instantiates registered custom providers on demand', () => {
    vi.stubEnv('CUSTOM_OPENAI_API_KEY', 'configured-key');
    registerCustomProviders([cloneConfig(OPENAI_CUSTOM)]);

    const provider = getCustomProvider('custom-openai');

    expect(provider?.name).toBe('custom-openai');
    expect(provider?.getModel()).toBe('custom-main');
    expect(getCustomProvider('missing-provider')).toBeUndefined();
  });

  it('defaults the two-layer cascade fields when the custom config omits them', () => {
    vi.stubEnv('CUSTOM_OPENAI_API_KEY', 'test-key');
    const provider = createCustomProvider(cloneConfig(OPENAI_CUSTOM));
    // No flags set in OPENAI_CUSTOM → all three cascade getters fall
    // through to provider-level default → safe defaults (legacy behaviour).
    expect(provider.getEffectiveReplayReasoningContent()).toBe(false);
    expect(provider.getEffectiveStrictThinkingSignature()).toBe(false);
    expect(provider.getStreamMaxDurationMs()).toBeUndefined();
  });

  it('passes through provider-level cascade fields from custom config', () => {
    vi.stubEnv('CUSTOM_OPENAI_API_KEY', 'test-key');
    const provider = createCustomProvider({
      ...cloneConfig(OPENAI_CUSTOM),
      replayReasoningContent: true,
      strictThinkingSignature: true,
      streamMaxDurationMs: 250_000,
    });
    expect(provider.getEffectiveReplayReasoningContent()).toBe(true);
    expect(provider.getEffectiveStrictThinkingSignature()).toBe(true);
    expect(provider.getStreamMaxDurationMs()).toBe(250_000);
  });

  it('honours per-model overrides of cascade fields above provider defaults', () => {
    vi.stubEnv('CUSTOM_OPENAI_API_KEY', 'test-key');
    // Real-world shape: a single gateway routing models that need
    // different settings. Provider default replayReasoningContent=true
    // (e.g. DeepSeek V4 alias) — but the gateway also exposes an
    // openai-proper passthrough that must NOT echo reasoning_content.
    const provider = createCustomProvider({
      ...cloneConfig(OPENAI_CUSTOM),
      models: [
        { id: 'deepseek-v4-flash' },
        { id: 'gpt-5', replayReasoningContent: false, streamMaxDurationMs: 0 },
        { id: 'glm-5.1', streamMaxDurationMs: 300_000 },
      ],
      replayReasoningContent: true,
      streamMaxDurationMs: 120_000,
    });
    // Inheriting model picks up the provider defaults.
    expect(provider.getEffectiveReplayReasoningContent('deepseek-v4-flash')).toBe(true);
    expect(provider.getStreamMaxDurationMs('deepseek-v4-flash')).toBe(120_000);
    // gpt-5 forces both off — verifies per-model `false` beats `true`
    // at provider level (the load-bearing case).
    expect(provider.getEffectiveReplayReasoningContent('gpt-5')).toBe(false);
    expect(provider.getStreamMaxDurationMs('gpt-5')).toBe(0);
    // glm-5.1 only overrides the duration, inherits replay from provider.
    expect(provider.getEffectiveReplayReasoningContent('glm-5.1')).toBe(true);
    expect(provider.getStreamMaxDurationMs('glm-5.1')).toBe(300_000);
  });

  it('overrides the OpenAI SDK user agent for compatibility gateways', async () => {
    vi.stubEnv('CUSTOM_OPENAI_API_KEY', 'configured-key');
    const provider = createCustomProvider(cloneConfig(OPENAI_CUSTOM)) as any;

    const request = await (await provider.getClient()).buildRequest({
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

    const request = await (await provider.getClient()).buildRequest({
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

    const request = await (await provider.getClient()).buildRequest({
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

    const request = await (await provider.getClient()).buildRequest({
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

  it('F2: warns when reasoningCapability is set but supportsThinking is false (ignored)', () => {
    vi.stubEnv('CUSTOM_F2_API_KEY', 'test-key');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    registerCustomProviders([{
      name: 'f2-contradiction',
      protocol: 'openai',
      baseUrl: 'https://f2.example/v1',
      apiKeyEnv: 'CUSTOM_F2_API_KEY',
      model: 'f2-model',
      supportsThinking: false,
      reasoningCapability: 'native-toggle',
    }]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('is ignored because supportsThinking is false'),
    );
  });

  it('F2: does NOT warn on a bare supportsThinking:true config (valid default)', () => {
    vi.stubEnv('CUSTOM_F2OK_API_KEY', 'test-key');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    registerCustomProviders([{
      name: 'f2-ok',
      protocol: 'openai',
      baseUrl: 'https://f2ok.example/v1',
      apiKeyEnv: 'CUSTOM_F2OK_API_KEY',
      model: 'f2ok-model',
      supportsThinking: true,
    }]);

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('is ignored because supportsThinking is false'),
    );
  });

  it('reports reasoningCapability as none when supportsThinking is false (surface matches runtime)', () => {
    vi.stubEnv('CUSTOM_NOTHINK_API_KEY', 'test-key');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config: KodaXCustomProviderConfig = {
      name: 'no-think',
      protocol: 'openai',
      baseUrl: 'https://no-think.example/v1',
      apiKeyEnv: 'CUSTOM_NOTHINK_API_KEY',
      model: 'nt-model',
      supportsThinking: false,
      reasoningCapability: 'native-toggle',
    };
    registerCustomProviders([cloneConfig(config)]);

    // supportsThinking:false makes runtime resolve to 'none'; every capability surface
    // must agree, not advertise the configured (but ignored) 'native-toggle'.
    expect(getCustomProviderList().find((p) => p.name === 'no-think')?.reasoningCapability).toBe('none');
    expect(getCustomModelCapabilities('no-think', 'nt-model')?.reasoningCapability).toBe('none');

    const provider = createCustomProvider(cloneConfig(config));
    expect(provider.getConfiguredReasoningCapability()).toBe('none');
    expect(provider.getReasoningProfile()).toMatchObject({
      reasoningPreset: 'none',
      effortStrategy: 'none',
    });
  });

  it('supportsThinking:false overrides an explicit reasoningProfile (no metadata contradiction)', () => {
    vi.stubEnv('CUSTOM_OVERRIDE_API_KEY', 'test-key');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config: KodaXCustomProviderConfig = {
      name: 'override-think',
      protocol: 'openai',
      baseUrl: 'https://override.example/v1',
      apiKeyEnv: 'CUSTOM_OVERRIDE_API_KEY',
      model: 'ot-model',
      supportsThinking: false,
      reasoningProfile: {
        reasoningPreset: 'deepseek-v4-openai',
        effortStrategy: 'openai-chat-effort',
        thinkingStrategy: 'provider-toggle',
        supportedEfforts: [{ value: 'high', isDefault: true }],
        supportsReasoningEffort: true,
      },
    };
    registerCustomProviders([cloneConfig(config)]);

    // supportsThinking:false is the master off-switch: the explicit thinking profile is
    // overridden to 'none' across EVERY surface, so nothing contradicts the runtime
    // (previously the capability read 'none' while the profile still drove thinking).
    expect(getCustomProviderList().find((p) => p.name === 'override-think')?.reasoningCapability).toBe('none');
    const caps = getCustomModelCapabilities('override-think', 'ot-model');
    expect(caps?.reasoningCapability).toBe('none');
    expect(caps?.reasoningProfile).toMatchObject({ reasoningPreset: 'none', effortStrategy: 'none' });
    expect(caps?.supportsThinking).toBe(false);

    const provider = createCustomProvider(cloneConfig(config));
    expect(provider.getConfiguredReasoningCapability()).toBe('none');
    expect(provider.getReasoningProfile()).toMatchObject({
      reasoningPreset: 'none',
      effortStrategy: 'none',
    });

    // The user is warned their (now-ignored) reasoning config conflicts with the switch.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('is ignored because supportsThinking is false'),
    );
  });

  it('supportsThinking:false overrides a PER-MODEL reasoningProfile at runtime AND every surface', () => {
    vi.stubEnv('CUSTOM_PERMODEL_API_KEY', 'test-key');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config: KodaXCustomProviderConfig = {
      name: 'permodel-nothink',
      protocol: 'openai',
      baseUrl: 'https://permodel.example/v1',
      apiKeyEnv: 'CUSTOM_PERMODEL_API_KEY',
      model: 'main',
      supportsThinking: false,
      models: [
        'main',
        {
          id: 'alt',
          reasoningProfile: {
            reasoningPreset: 'deepseek-v4-openai',
            effortStrategy: 'openai-chat-effort',
            thinkingStrategy: 'provider-toggle',
            supportedEfforts: [{ value: 'high', isDefault: true }],
            supportsReasoningEffort: true,
          },
        },
      ],
    };
    registerCustomProviders([cloneConfig(config)]);

    // RUNTIME: the per-model thinking profile must be overridden to 'none' at the SOURCE,
    // otherwise the request would send thinking despite supportsThinking:false while the
    // query surfaces report 'none' — the exact surface/runtime split this guards against.
    const provider = createCustomProvider(cloneConfig(config));
    expect(provider.getReasoningProfile('alt')).toMatchObject({
      reasoningPreset: 'none',
      effortStrategy: 'none',
    });

    // QUERY SURFACES: per-model capabilities + descriptor list both agree with runtime.
    expect(getCustomModelCapabilities('permodel-nothink', 'alt')).toMatchObject({
      reasoningCapability: 'none',
      reasoningProfile: { reasoningPreset: 'none', effortStrategy: 'none' },
    });
    const alt = getCustomProviderModelDescriptors('permodel-nothink')?.find((d) => d.id === 'alt');
    expect(alt?.reasoningProfile).toMatchObject({ reasoningPreset: 'none', effortStrategy: 'none' });

    // The per-model thinking config is flagged at startup (warning inspects models[]).
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('is ignored because supportsThinking is false'),
    );
  });

  it('supportsThinking:false normalizes a PER-MODEL deprecated reasoningCapability on every surface', () => {
    // Regression: the deprecated per-model `reasoningCapability` field survived the
    // descriptor spread, so provider.getConfiguredReasoningCapability('alt') reported
    // the stale label ('native-effort') even though supportsThinking:false forces the
    // runtime profile to 'none'. That surface/runtime split masks the
    // 'reasoning-control-limited' user warning. Every surface must agree on 'none'.
    vi.stubEnv('CUSTOM_PMCAP_API_KEY', 'test-key');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config: KodaXCustomProviderConfig = {
      name: 'permodel-cap',
      protocol: 'openai',
      baseUrl: 'https://permodelcap.example/v1',
      apiKeyEnv: 'CUSTOM_PMCAP_API_KEY',
      model: 'main',
      supportsThinking: false,
      models: ['main', { id: 'alt', reasoningCapability: 'native-effort' }],
    };
    registerCustomProviders([cloneConfig(config)]);

    const provider = createCustomProvider(cloneConfig(config));
    // The stale label must be normalized to 'none' at the descriptor source.
    expect(provider.getConfiguredReasoningCapability('alt')).toBe('none');
    expect(provider.getReasoningProfile('alt')).toMatchObject({
      reasoningPreset: 'none',
      effortStrategy: 'none',
    });

    // Query surfaces already forced 'none' — assert they still agree (no regression).
    expect(getCustomModelCapabilities('permodel-cap', 'alt')?.reasoningCapability).toBe('none');
    const alt = getCustomProviderModelDescriptors('permodel-cap')?.find((d) => d.id === 'alt');
    expect(alt?.reasoningCapability).toBe('none');
  });

  it('supportsThinking:false overrides a per-model reasoningProfile on ANTHROPIC-compat too', () => {
    vi.stubEnv('CUSTOM_PMANT_API_KEY', 'test-key');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config: KodaXCustomProviderConfig = {
      name: 'permodel-ant',
      protocol: 'anthropic',
      baseUrl: 'https://pmant.example',
      apiKeyEnv: 'CUSTOM_PMANT_API_KEY',
      model: 'main',
      supportsThinking: false,
      models: [
        'main',
        {
          id: 'alt',
          reasoningProfile: {
            reasoningPreset: 'anthropic-budget',
            effortStrategy: 'provider-budget',
            thinkingStrategy: 'anthropic-budget',
            supportedEfforts: [{ value: 'high', isDefault: true }],
          },
        },
      ],
    };
    registerCustomProviders([cloneConfig(config)]);

    const provider = createCustomProvider(cloneConfig(config));
    expect(provider.getReasoningProfile('alt')).toMatchObject({
      reasoningPreset: 'none',
      effortStrategy: 'none',
    });
    expect(getCustomModelCapabilities('permodel-ant', 'alt')).toMatchObject({
      reasoningCapability: 'none',
      reasoningProfile: { reasoningPreset: 'none', effortStrategy: 'none' },
    });
  });

  it('openai-passive (bare supportsThinking:true) reports none across EVERY surface (consistent with passive runtime)', () => {
    vi.stubEnv('CUSTOM_PASSIVE_API_KEY', 'test-key');
    const config: KodaXCustomProviderConfig = {
      name: 'passive-openai',
      protocol: 'openai',
      baseUrl: 'https://passive.example/v1',
      apiKeyEnv: 'CUSTOM_PASSIVE_API_KEY',
      model: 'p-model',
      supportsThinking: true,
    };
    registerCustomProviders([cloneConfig(config)]);

    const provider = createCustomProvider(cloneConfig(config));
    // openai-passive sends no wire reasoning param → all three label surfaces agree on 'none'
    // (not 'native-toggle'), and the resolved profile is undefined.
    expect(provider.getConfiguredReasoningCapability()).toBe('none');
    expect(provider.getReasoningProfile()).toBeUndefined();
    expect(getCustomProviderList().find((p) => p.name === 'passive-openai')?.reasoningCapability).toBe('none');
    expect(getCustomModelCapabilities('passive-openai', 'p-model')?.reasoningCapability).toBe('none');
    // The model is still thinking-capable — reflected by supportsThinking, not the label.
    expect(getCustomModelCapabilities('passive-openai', 'p-model')?.supportsThinking).toBe(true);
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

describe('custom provider imageInput', () => {
  afterEach(() => {
    registerCustomProviders([]);
    vi.unstubAllEnvs();
  });

  it('imageInput:true forces multimodalSupport image-input on the provider instance', () => {
    vi.stubEnv('CUSTOM_OPENAI_API_KEY', 'test-key');
    const provider = createCustomProvider({
      ...cloneConfig(OPENAI_CUSTOM),
      imageInput: true,
    });

    const profile = provider.getCapabilityProfile();
    expect(profile.multimodalSupport).toBe('image-input');
    // Explicit partial-profile fields survive the merge.
    expect(profile.mcpSupport).toBe('native');
  });

  it('keeps multimodalSupport none when imageInput is absent', () => {
    vi.stubEnv('CUSTOM_OPENAI_API_KEY', 'test-key');
    const provider = createCustomProvider(cloneConfig(OPENAI_CUSTOM));

    expect(provider.getCapabilityProfile().multimodalSupport).toBe('none');
  });

  it('imageInput:true overrides an explicit capabilityProfile multimodalSupport none', () => {
    vi.stubEnv('CUSTOM_OPENAI_API_KEY', 'test-key');
    const provider = createCustomProvider({
      ...cloneConfig(OPENAI_CUSTOM),
      imageInput: true,
      capabilityProfile: {
        ...cloneConfig(OPENAI_CUSTOM).capabilityProfile!,
        multimodalSupport: 'none',
      },
    });

    expect(provider.getCapabilityProfile().multimodalSupport).toBe('image-input');
  });

  it('getCustomProviderList reflects the merged profile', () => {
    registerCustomProviders([{ ...cloneConfig(OPENAI_CUSTOM), imageInput: true }]);

    const entry = getCustomProviderList().find((p) => p.name === 'custom-openai');
    expect(entry?.capabilityProfile.multimodalSupport).toBe('image-input');
  });

  it('getCustomProviderCapabilityProfile is keyless and case-insensitive', () => {
    // No CUSTOM_OPENAI_API_KEY stubbed — the lookup must not require the key.
    registerCustomProviders([{ ...cloneConfig(OPENAI_CUSTOM), imageInput: true }]);

    expect(getCustomProviderCapabilityProfile('custom-openai')?.multimodalSupport)
      .toBe('image-input');
    expect(getCustomProviderCapabilityProfile('CUSTOM-OPENAI')?.multimodalSupport)
      .toBe('image-input');
    // Default profile (no flag) still resolves, keyless.
    registerCustomProviders([cloneConfig(OPENAI_CUSTOM)]);
    expect(getCustomProviderCapabilityProfile('custom-openai')?.multimodalSupport)
      .toBe('none');
    expect(getCustomProviderCapabilityProfile('not-registered')).toBeUndefined();
  });

  it('rejects a non-boolean imageInput', () => {
    expect(() => createCustomProvider({
      ...cloneConfig(OPENAI_CUSTOM),
      imageInput: 'yes' as unknown as boolean,
    })).toThrowError(/imageInput/);
  });
});
