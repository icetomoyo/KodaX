import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KODAX_DEFAULT_PROVIDER,
  getModelCapabilities,
  getProvider,
  getProviderConfiguredReasoningCapability,
  getProviderList,
  isProviderConfigured,
} from './registry.js';
import { KodaXProviderError } from '../errors.js';
import { getCodexCliDefaultModel, getGeminiCliDefaultModel } from './cli-bridge-models.js';

describe('provider registry', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function expectReasoningPreset(
    provider: string,
    model: string,
    preset: string,
  ): void {
    expect(getModelCapabilities(provider, model)?.reasoningProfile?.reasoningPreset).toBe(preset);
  }

  it('includes CLI bridge providers in the built-in registry snapshot', () => {
    const gemini = getProviderList().find((provider) => provider.name === 'gemini-cli');
    const codex = getProviderList().find((provider) => provider.name === 'codex-cli');

    expect(gemini?.model).toBe(getGeminiCliDefaultModel());
    expect(codex?.model).toBe(getCodexCliDefaultModel());
  });

  it('tracks API-key backed providers through environment configuration', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    expect(isProviderConfigured('openai')).toBe(true);
    expect(isProviderConfigured('unknown-provider')).toBe(false);
  });

  it('returns model-specific reasoning capabilities from snapshots', () => {
    expect(getProviderConfiguredReasoningCapability('deepseek', 'deepseek-v4-pro')).toBe('native-effort');
    expect(getProviderConfiguredReasoningCapability('deepseek', 'deepseek-v4-flash')).toBe('native-effort');
    expect(getProviderConfiguredReasoningCapability('unknown-provider')).toBe('unknown');
  });

  it('tracks the current per-model DeepSeek V4 reasoning effort mapping', () => {
    const flash = getModelCapabilities('deepseek', 'deepseek-v4-flash')?.reasoningProfile;
    const pro = getModelCapabilities('deepseek', 'deepseek-v4-pro')?.reasoningProfile;

    expect(flash?.reasoningPreset).toBe('deepseek-v4-flash-openai');
    expect(flash?.effortAliases).toEqual({
      medium: 'high',
      xhigh: 'high',
    });
    expect(pro?.reasoningPreset).toBe('deepseek-v4-pro-openai');
    expect(pro?.effortAliases).toEqual({
      low: 'high',
      medium: 'high',
      xhigh: 'max',
    });
  });

  it.each([
    ['deepseek', 'deepseek-v4-flash'],
    ['deepseek', 'deepseek-v4-pro'],
    ['kimi-code', 'k3'],
    ['kimi-code', 'k3-256k'],
    ['minimax-coding', 'MiniMax-M3'],
    ['mimo-coding', 'mimo-v2.5-pro'],
    ['mimo', 'mimo-v2.5-pro'],
    ['ark-coding', 'glm-5.2'],
    ['ark-coding', 'kimi-k2.6'],
    ['ark-coding', 'MiniMax-M3'],
    ['ark-coding', 'deepseek-v4-pro'],
    ['ark-coding', 'deepseek-v4-flash'],
    ['qwen-token-plan', 'qwen3.7-max'],
    ['qwen-token-plan', 'qwen3.7-plus'],
    ['qwen-token-plan', 'qwen3.6-flash'],
    ['qwen-token-plan', 'glm-5.2'],
    ['qwen-token-plan', 'deepseek-v4-pro'],
  ])('%s/%s explicitly supports disabling thinking', (provider, model) => {
    expect(getModelCapabilities(provider, model)?.reasoningProfile).toMatchObject({
      supportsDisabledThinking: true,
    });
  });

  it.each([
    ['kimi-code', 'kimi-for-coding'],
    ['kimi-code', 'kimi-for-coding-highspeed'],
    ['minimax-coding', 'MiniMax-M2.7'],
    ['minimax-coding', 'MiniMax-M2.7-highspeed'],
    ['ark-coding', 'kimi-k2.7-code'],
    ['ark-coding', 'MiniMax-M2.7'],
    ['qwen-token-plan', 'qwen3.8-max'],
    ['qwen-token-plan', 'qwen3.8-max-preview'],
  ])('%s/%s rejects attempts to disable always-on thinking', (provider, model) => {
    expect(getModelCapabilities(provider, model)?.reasoningProfile).toMatchObject({
      localRejectEfforts: expect.arrayContaining(['none']),
    });
  });

  it('throws a provider error for unknown providers', () => {
    let caught: unknown;
    try {
      getProvider('missing-provider');
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KodaXProviderError);
    expect(caught).toMatchObject({
      metadata: {
        failureCode: 'provider_not_registered',
        stage: 'catalog',
      },
    });
  });

  it('registers MiniMax Coding Plan as minimax-coding (Anthropic-compat, MINIMAX_CODING_API_KEY)', () => {
    // Pin the load-bearing pieces of the multi-model gateway: the provider
    // default (M3 at the 1M provider window) and the legacy explicit M2.7
    // override (204K). Guard both so a default change cannot silently drop
    // backwards-compatible explicit model selection.
    vi.stubEnv('MINIMAX_CODING_API_KEY', 'mm-test-key');
    const minimax = getProvider('minimax-coding');
    expect(minimax.name).toBe('minimax-coding');
    expect(getProviderList().find((provider) => provider.name === 'minimax-coding')?.model)
      .toBe('MiniMax-M3');
    expect(minimax.getEffectiveContextWindow('MiniMax-M2.7')).toBe(204_800);
    expect(minimax.getEffectiveContextWindow('MiniMax-M2.7-highspeed')).toBe(204_800);
    expect(minimax.getEffectiveContextWindow('MiniMax-M3')).toBe(1_000_000);
    expect(getProviderConfiguredReasoningCapability('minimax-coding', 'MiniMax-M3')).toBe('native-adaptive');
    expect(getProviderConfiguredReasoningCapability('minimax-coding', 'MiniMax-M2.7-highspeed'))
      .toBe('native-toggle');
    expectReasoningPreset('minimax-coding', 'MiniMax-M3', 'minimax-m3');
    expectReasoningPreset('minimax-coding', 'MiniMax-M2.7', 'minimax-m2-always');
  });

  it('registers Xiaomi MiMo Token Plan as mimo-coding (Anthropic-compat, MIMO_CODING_API_KEY)', () => {
    vi.stubEnv('MIMO_CODING_API_KEY', 'tp-test-key');
    const mimo = getProvider('mimo-coding');
    expect(mimo.name).toBe('mimo-coding');
    expect(mimo.getEffectiveContextWindow('mimo-v2.5-pro')).toBe(1_000_000);
    expect(mimo.getEffectiveContextWindow('mimo-v2.5')).toBe(1_000_000);
    expect(getProviderConfiguredReasoningCapability('mimo-coding', 'mimo-v2.5-pro')).toBe('native-toggle');
    expectReasoningPreset('mimo-coding', 'mimo-v2.5-pro', 'mimo-v2.5-toggle');
  });

  it('registers Alibaba Cloud Token Plan as qwen-token-plan (Anthropic-compat)', () => {
    vi.stubEnv('QWEN_TOKEN_API_KEY', 'token-plan-test-key');
    const tokenPlan = getProvider('qwen-token-plan');

    expect(tokenPlan.name).toBe('qwen-token-plan');
    expect(tokenPlan.getModel()).toBe('qwen3.8-max');
    expect(tokenPlan.getAvailableModels()).toEqual([
      'qwen3.8-max',
      'qwen3.8-max-preview',
      'qwen3.7-max',
      'qwen3.7-plus',
      'qwen3.6-flash',
      'glm-5.2',
      'deepseek-v4-pro',
    ]);

    for (const model of tokenPlan.getAvailableModels()) {
      expect(tokenPlan.getEffectiveContextWindow(model)).toBe(1_000_000);
    }

    expect(tokenPlan.getEffectiveMaxOutputTokens('qwen3.8-max')).toBe(131_072);
    expect(tokenPlan.getEffectiveMaxOutputTokens('qwen3.8-max-preview')).toBe(131_072);
    expect(tokenPlan.getEffectiveMaxOutputTokens('qwen3.7-plus')).toBe(64_000);
    expect(tokenPlan.getEffectiveMaxOutputTokens('glm-5.2')).toBe(131_072);
    expect(tokenPlan.getEffectiveMaxOutputTokens('deepseek-v4-pro')).toBe(64_000);
    expect(getProviderConfiguredReasoningCapability('qwen-token-plan', 'qwen3.8-max'))
      .toBe('native-budget');
    expect(getProviderConfiguredReasoningCapability('qwen-token-plan', 'qwen3.8-max-preview'))
      .toBe('native-budget');
    expect(getProviderConfiguredReasoningCapability('qwen-token-plan', 'glm-5.2'))
      .toBe('native-effort');
    expect(getProviderConfiguredReasoningCapability('qwen-token-plan', 'deepseek-v4-pro'))
      .toBe('native-effort');
    expectReasoningPreset('qwen-token-plan', 'qwen3.7-max', 'qwen-hybrid-thinking');
    expectReasoningPreset('qwen-token-plan', 'glm-5.2', 'zai-glm-5.2');
    expect(getModelCapabilities('qwen-token-plan', 'qwen3.8-max')?.reasoningProfile)
      .toMatchObject({ localRejectEfforts: ['none', 'minimal'] });
    expect(getModelCapabilities('qwen-token-plan', 'qwen3.8-max-preview')?.reasoningProfile)
      .toMatchObject({ localRejectEfforts: ['none', 'minimal'] });
    expect(getModelCapabilities('qwen-token-plan', 'qwen3.7-max')?.reasoningProfile)
      .toMatchObject({ supportsDisabledThinking: true });
    expect(getModelCapabilities('qwen-token-plan', 'deepseek-v4-pro')?.reasoningProfile)
      .toMatchObject({
        effortStrategy: 'anthropic-reasoning-effort',
        thinkingStrategy: 'provider-toggle',
      });

    type ConfigCarrier = {
      config: { baseUrl?: string; verifyStrategy?: string };
    };
    const config = (tokenPlan as unknown as ConfigCarrier).config;
    expect(config.baseUrl).toBe(
      'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    );
    expect(config.verifyStrategy).toBe('count-tokens');
  });

  it('registers Xiaomi MiMo pay-per-token as mimo (Anthropic-compat, MIMO_API_KEY)', () => {
    // Same upstream model family and capability shape as mimo-coding —
    // only the baseUrl and the API key env differ. Mirroring the
    // mimo-coding assertions guards against JSON ↔ class drift after
    // the two-provider split.
    vi.stubEnv('MIMO_API_KEY', 'sk-test-key');
    const mimo = getProvider('mimo');
    expect(mimo.name).toBe('mimo');
    expect(mimo.getEffectiveContextWindow('mimo-v2.5-pro')).toBe(1_000_000);
    expect(mimo.getEffectiveContextWindow('mimo-v2.5')).toBe(1_000_000);
    expect(getProviderConfiguredReasoningCapability('mimo', 'mimo-v2.5-pro')).toBe('native-toggle');
    expectReasoningPreset('mimo', 'mimo-v2.5-pro', 'mimo-v2.5-toggle');
  });

  it('registers the complete Kimi Code K3/K2.7 subscription lineup', () => {
    vi.stubEnv('KIMI_CODE_API_KEY', 'kimi-code-test-key');
    const kimiCode = getProvider('kimi-code');

    expect(kimiCode.getModel()).toBe('k3-256k');
    expect(kimiCode.getAvailableModels()).toEqual([
      'k3-256k',
      'k3',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ]);
    expect(kimiCode.getEffectiveContextWindow('kimi-for-coding')).toBe(262_144);
    expect(kimiCode.getEffectiveContextWindow('kimi-for-coding-highspeed')).toBe(262_144);
    expect(kimiCode.getEffectiveContextWindow('k3')).toBe(1_048_576);
    expect(kimiCode.getEffectiveContextWindow('k3-256k')).toBe(262_144);
    expectReasoningPreset('kimi-code', 'kimi-for-coding', 'kimi-k2.7-code');
    expectReasoningPreset('kimi-code', 'kimi-for-coding-highspeed', 'kimi-k2.7-code');
    expectReasoningPreset('kimi-code', 'k3', 'kimi-k3');
    expectReasoningPreset('kimi-code', 'k3-256k', 'kimi-k3');
  });

  it('registers Volcengine Ark Coding Plan as ark-coding (Anthropic-compat, ARK_CODING_API_KEY)', () => {
    vi.stubEnv('ARK_CODING_API_KEY', 'ark-test-key');
    const ark = getProvider('ark-coding');
    expect(ark.name).toBe('ark-coding');

    // Default + alts must cover all 12 models Ark's Coding Plan console
    // lists. Retired: glm-5.1 / glm-4.7 / deepseek-v3.2 (wire returns
    // UnsupportedModel 404). 2026-08-15: GLM-5.3 added and promoted to
    // default (live probe: glm-5.3 200; glm-latest and glm-5.2 both
    // currently resolve upstream to glm-5.3).
    const models = ark.getAvailableModels();
    expect(models).toEqual([
      'glm-5.3',
      'glm-5.2',
      'kimi-k2.7-code',
      'kimi-k2.6',
      'MiniMax-M3',
      'MiniMax-M2.7',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'doubao-seed-2.0-code',
      'doubao-seed-2.0-pro',
      'doubao-seed-2.0-lite',
      'doubao-seed-code',
    ]);

    // Per-model context window pins (user-confirmed against Volcengine
    // console catalog). Ark's GLM routes remain at 1M,
    // Kimi at 256K, MiniMax-M2.7 at 204_800, MiniMax-M3 at 1M
    // (Frontier Coding), DeepSeek V4 at 1M, Doubao Seed 2.0 at 256K.
    expect(ark.getModel()).toBe('glm-5.3');
    expect(ark.getWireModel()).toBe('glm-5.3');
    expect(ark.getEffectiveContextWindow('glm-5.3')).toBe(1_000_000);
    expect(ark.getEffectiveContextWindow('glm-5.2')).toBe(1_000_000);
    expect(ark.getEffectiveContextWindow('kimi-k2.7-code')).toBe(256_000);
    expect(ark.getEffectiveContextWindow('kimi-k2.6')).toBe(256_000);
    expect(ark.getEffectiveContextWindow('MiniMax-M3')).toBe(1_000_000);
    expect(ark.getEffectiveContextWindow('MiniMax-M2.7')).toBe(204_800);
    expect(ark.getEffectiveContextWindow('deepseek-v4-pro')).toBe(1_000_000);
    expect(ark.getEffectiveContextWindow('deepseek-v4-flash')).toBe(1_000_000);
    expect(ark.getEffectiveContextWindow('doubao-seed-2.0-code')).toBe(256_000);
    expect(ark.getEffectiveContextWindow('doubao-seed-2.0-pro')).toBe(256_000);
    expect(ark.getEffectiveContextWindow('doubao-seed-2.0-lite')).toBe(256_000);
    expect(ark.getEffectiveContextWindow('doubao-seed-code')).toBe(256_000);

    // GLM-5.2 carries an explicit maxOutputTokens override. The Ark
    // gateway caps at 128_000 even though Zhipu's direct endpoint
    // accepts 131_072 — user-confirmed against an actual 400 from the
    // Ark wire (2026-06): "max_tokens above maximum value, expected
    // a value <= 128000". Pin the cap so future JSON edits can't
    // silently regress to either the provider-level 32_000 default
    // or the Zhipu-direct 131_072 value.
    expect(ark.getEffectiveMaxOutputTokens('glm-5.2')).toBe(128_000);
    // GLM-5.3 inherits the same Ark gateway 128K cap until a live
    // max-tokens probe proves a higher limit.
    expect(ark.getEffectiveMaxOutputTokens('glm-5.3')).toBe(128_000);

    expect(getProviderConfiguredReasoningCapability('ark-coding', 'glm-5.2')).toBe('native-effort');
    expectReasoningPreset('ark-coding', 'glm-5.3', 'zai-glm-5.3');
    expectReasoningPreset('ark-coding', 'glm-5.2', 'zai-glm-5.2');
    expectReasoningPreset('ark-coding', 'kimi-k2.7-code', 'kimi-k2.7-code');
    expectReasoningPreset('ark-coding', 'MiniMax-M3', 'minimax-m3');
    expectReasoningPreset('ark-coding', 'deepseek-v4-pro', 'deepseek-v4-anthropic');
    expectReasoningPreset('ark-coding', 'doubao-seed-2.0-code', 'none');
    expectReasoningPreset('ark-coding', 'doubao-seed-code', 'none');
  });

  it('exposes a stable default provider snapshot', () => {
    // Default provider (zhipu-coding) needs its key to instantiate.
    vi.stubEnv('ZHIPU_CODING_API_KEY', 'test-key');
    expect(typeof KODAX_DEFAULT_PROVIDER).toBe('string');
    expect(getProvider()).toBeDefined();
  });

  // OpenAI-compat thinking-mode providers that share the deepseek
  // reasoning_content convention all opt into the replayReasoningContent
  // flag for max fault-tolerance (deepseek empirically verified;
  // kimi/qwen/zhipu unverified but identical failure-mode shape).
  // OpenAI proper stays off — different protocol, would 400 on unknown
  // field.
  it('opts kimi/qwen/zhipu/deepseek into replayReasoningContent (and excludes openai)', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key');
    vi.stubEnv('KIMI_API_KEY', 'test-key');
    vi.stubEnv('QWEN_API_KEY', 'test-key');
    vi.stubEnv('ZHIPU_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_API_KEY', 'test-key');

    type ConfigCarrier = { config: { replayReasoningContent?: boolean } };
    const flagOf = (name: string): boolean | undefined =>
      (getProvider(name) as unknown as ConfigCarrier).config.replayReasoningContent;

    expect(flagOf('deepseek')).toBe(true);
    expect(flagOf('kimi')).toBe(true);
    expect(flagOf('qwen')).toBe(true);
    expect(flagOf('zhipu')).toBe(true);
    expect(flagOf('openai')).toBeUndefined();
  });

  it.each(['zhipu', 'zhipu-coding', 'zai-coding'])(
    '%s exposes GLM-5.3 as always-thinking with documented effort buckets',
    (provider) => {
      expect(getModelCapabilities(provider, 'glm-5.3')?.reasoningProfile).toMatchObject({
        reasoningPreset: 'zai-glm-5.3',
        defaultEffort: 'max',
        disabledEfforts: ['none'],
        supportsDisabledThinking: false,
        effortAliases: expect.objectContaining({
          minimal: 'low',
          medium: 'high',
          xhigh: 'max',
        }),
      });
    },
  );

  it('enables cache-affinity fields only for verified built-in endpoints', () => {
    vi.stubEnv('KIMI_CODE_API_KEY', 'test-key');
    vi.stubEnv('KIMI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key');

    type ConfigCarrier = { config: { promptCacheAffinity?: boolean } };
    const flagOf = (name: string): boolean | undefined =>
      (getProvider(name) as unknown as ConfigCarrier).config.promptCacheAffinity;

    expect(flagOf('kimi-code')).toBe(true);
    expect(flagOf('kimi')).toBe(true);
    expect(flagOf('openai')).toBe(true);
    expect(flagOf('anthropic')).toBeUndefined();
    expect(flagOf('deepseek')).toBeUndefined();
  });

  // FEATURE_098: per-model context window override where the model
  // really diverges from the provider default. Tests guard the data,
  // not the lookup mechanism (already covered in base.test.ts).
  it('pins true context windows for models that diverge from provider defaults', () => {
    vi.stubEnv('KIMI_API_KEY', 'test-key');
    vi.stubEnv('ZHIPU_API_KEY', 'test-key');
    vi.stubEnv('ZHIPU_CODING_API_KEY', 'test-key');

    const kimi = getProvider('kimi');
    expect(kimi.getModel()).toBe('kimi-k2.7-code');
    expect(kimi.getAvailableModels()).toEqual([
      'kimi-k2.7-code',
      'kimi-k3',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
      'kimi-k2.5',
    ]);
    expect(kimi.getEffectiveContextWindow('kimi-k3')).toBe(1_048_576);
    expect(kimi.getEffectiveContextWindow('kimi-k2.7-code')).toBe(262_144);
    expect(kimi.getEffectiveContextWindow('kimi-k2.7-code-highspeed')).toBe(262_144);
    expect(kimi.getEffectiveContextWindow('kimi-k2.6')).toBe(262_144);
    expect(kimi.getEffectiveContextWindow('kimi-k2.5')).toBe(262_144);
    expect(kimi.getEffectiveMaxOutputTokens('kimi-k3')).toBe(32_000);
    expect(kimi.getEffectiveMaxOutputTokens('kimi-k2.7-code')).toBe(32_768);
    expect(kimi.getEffectiveMaxOutputTokens('kimi-k2.7-code-highspeed')).toBe(32_768);
    expectReasoningPreset('kimi', 'kimi-k3', 'kimi-k3');
    expectReasoningPreset('kimi', 'kimi-k2.7-code', 'kimi-k2.7-code');
    expectReasoningPreset('kimi', 'kimi-k2.7-code-highspeed', 'kimi-k2.7-code');
    expectReasoningPreset('kimi', 'kimi-k2.6', 'kimi-hybrid-toggle');
    expectReasoningPreset('kimi', 'kimi-k2.5', 'kimi-hybrid-toggle');

    const zhipu = getProvider('zhipu');
    expect(zhipu.getEffectiveContextWindow('glm-5')).toBe(200_000);
    expect(zhipu.getAvailableModels()).toContain('glm-5.3');
    expect(zhipu.getWireModel('glm-5.3')).toBe('glm-5.3');
    expect(zhipu.getEffectiveContextWindow('glm-5.3')).toBe(1_000_000);
    expect(zhipu.getEffectiveMaxOutputTokens('glm-5.3')).toBe(131_072);
    // GLM-5.3 Flash (2026-08-26): native multimodal, 1M context, text params
    // identical to GLM-5.3 per the bigmodel docs page.
    expect(zhipu.getAvailableModels()).toContain('glm-5.3-flash');
    expect(zhipu.getWireModel('glm-5.3-flash')).toBe('glm-5.3-flash');
    expect(zhipu.getEffectiveContextWindow('glm-5.3-flash')).toBe(1_000_000);
    expect(zhipu.getEffectiveMaxOutputTokens('glm-5.3-flash')).toBe(131_072);
    expect(zhipu.getAvailableModels()).toContain('glm-5.2');
    expect(zhipu.getEffectiveContextWindow('glm-5.2')).toBe(1_000_000);
    expect(zhipu.getEffectiveMaxOutputTokens('glm-5.2')).toBe(131_072);
    expect(zhipu.getEffectiveContextWindow('glm-5.1')).toBe(200_000);
    // User-confirmed (2026-05): GLM-5 Turbo is also 200K, not 128K. The
    // historical FEATURE_098 128K pin mirrored docs that were outdated
    // or wrong — same correction pattern as kimi/k2.5 above. Both
    // endpoints (public + coding) now inherit the 200K provider default.
    expect(zhipu.getEffectiveContextWindow('glm-5-turbo')).toBe(200_000);

    const zhipuCoding = getProvider('zhipu-coding');
    expect(zhipuCoding.getModel()).toBe('glm-5.3');
    expect(zhipuCoding.getWireModel()).toBe('glm-5.3');
    expect(zhipuCoding.getAvailableModels()).toEqual(['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5-turbo', 'glm-4.7']);
    expect(zhipuCoding.getEffectiveContextWindow('glm-5.3')).toBe(1_000_000);
    expect(zhipuCoding.getEffectiveMaxOutputTokens('glm-5.3')).toBe(131_072);
    // Flash on the Coding Plan: 3x plan quota, same 1M/128K text shape.
    expect(zhipuCoding.getEffectiveContextWindow('glm-5.3-flash')).toBe(1_000_000);
    expect(zhipuCoding.getEffectiveMaxOutputTokens('glm-5.3-flash')).toBe(131_072);
    expect(zhipuCoding.getEffectiveContextWindow('glm-5.2')).toBe(1_000_000);
    expect(zhipuCoding.getEffectiveMaxOutputTokens('glm-5.2')).toBe(131_072);
    expect(zhipuCoding.getEffectiveContextWindow('glm-5-turbo')).toBe(200_000);
    // GLM-5.2 remains an explicit rollback choice while 5.3 rolls out.
    // GLM-5.1 auto-routes upstream; GLM-4.7 inherits the 200K default.
    expect(zhipuCoding.getAvailableModels()).toContain('glm-4.7');
    expect(zhipuCoding.getEffectiveContextWindow('glm-4.7')).toBe(200_000);
  });

  it('registers Zhipu Coding Plan overseas mirror as zai-coding (Anthropic-compat, ZAI_CODING_API_KEY)', () => {
    // Same upstream model lineup + capability surface as zhipu-coding —
    // only baseUrl (api.z.ai) and the API key env differ. Mirroring the
    // zhipu-coding assertions guards against JSON ↔ class drift after
    // the two-provider split.
    vi.stubEnv('ZAI_CODING_API_KEY', 'zai-test-key');
    const zai = getProvider('zai-coding');
    expect(zai.name).toBe('zai-coding');
    expect(zai.getModel()).toBe('glm-5.3');
    expect(zai.getWireModel()).toBe('glm-5.3');
    expect(zai.getAvailableModels()).toEqual(['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5-turbo', 'glm-4.7']);
    expect(zai.getEffectiveContextWindow('glm-5.2')).toBe(1_000_000);
    expect(zai.getEffectiveMaxOutputTokens('glm-5.2')).toBe(131_072);
    expect(zai.getEffectiveContextWindow('glm-5.3')).toBe(1_000_000);
    expect(zai.getEffectiveMaxOutputTokens('glm-5.3')).toBe(131_072);
    expect(zai.getEffectiveContextWindow('glm-5.3-flash')).toBe(1_000_000);
    expect(zai.getEffectiveMaxOutputTokens('glm-5.3-flash')).toBe(131_072);
    expect(zai.getEffectiveContextWindow('glm-5-turbo')).toBe(200_000);
    expect(zai.getAvailableModels()).toContain('glm-4.7');
    expect(zai.getEffectiveContextWindow('glm-4.7')).toBe(200_000);
    // Same 300s streamMaxDurationMs as zhipu-coding — overseas gateway
    // proxies to the same upstream, so the kill-window characteristic
    // applies identically.
    expect(zai.getStreamMaxDurationMs?.()).toBe(300_000);
    expect(getProviderConfiguredReasoningCapability('zai-coding', 'glm-5.3')).toBe('native-effort');
  });
});
