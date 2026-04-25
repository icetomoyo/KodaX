import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KODAX_DEFAULT_PROVIDER,
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

  it('throws a provider error for unknown providers', () => {
    expect(() => getProvider('missing-provider')).toThrowError(KodaXProviderError);
  });

  it('registers Xiaomi MiMo Token Plan as mimo-coding (Anthropic-compat, MIMO_API_KEY)', () => {
    vi.stubEnv('MIMO_API_KEY', 'tp-test-key');
    const mimo = getProvider('mimo-coding');
    expect(mimo.name).toBe('mimo-coding');
    expect(mimo.getEffectiveContextWindow('mimo-v2.5-pro')).toBe(1_000_000);
    expect(mimo.getEffectiveContextWindow('mimo-v2.5')).toBe(1_000_000);
    expect(getProviderConfiguredReasoningCapability('mimo-coding', 'mimo-v2.5-pro')).toBe('native-budget');
  });

  it('registers Volcengine Ark Coding Plan as ark-coding (Anthropic-compat, ARK_API_KEY)', () => {
    vi.stubEnv('ARK_API_KEY', 'ark-test-key');
    const ark = getProvider('ark-coding');
    expect(ark.name).toBe('ark-coding');

    // Default + alts together must cover all 9 models the gateway routes to.
    const models = ark.getAvailableModels();
    expect(models).toEqual([
      'glm-5.1',
      'glm-4.7',
      'kimi-k2.6',
      'kimi-k2.5',
      'minimax-latest',
      'deepseek-v3.2',
      'doubao-seed-2.0-code',
      'doubao-seed-2.0-pro',
      'doubao-seed-2.0-lite',
    ]);

    // Ark gateway routes BY model field — bench-confirmed `kimi-k2.5`
    // upstream is Moonshot K2.5's 128K window (vs the provider-level 200K).
    expect(ark.getEffectiveContextWindow('glm-5.1')).toBe(200_000);
    expect(ark.getEffectiveContextWindow('kimi-k2.5')).toBe(128_000);
    expect(ark.getEffectiveContextWindow('deepseek-v3.2')).toBe(128_000);

    expect(getProviderConfiguredReasoningCapability('ark-coding', 'glm-5.1')).toBe('native-budget');
  });

  it('exposes a stable default provider snapshot', () => {
    expect(typeof KODAX_DEFAULT_PROVIDER).toBe('string');
    expect(getProvider()).toBeDefined();
  });

  // FEATURE_098: per-model context window override where the model
  // really diverges from the provider default. Tests guard the data,
  // not the lookup mechanism (already covered in base.test.ts).
  it('pins true context windows for models that diverge from provider defaults', () => {
    vi.stubEnv('KIMI_API_KEY', 'test-key');
    vi.stubEnv('ZHIPU_API_KEY', 'test-key');

    const kimi = getProvider('kimi');
    expect(kimi.getEffectiveContextWindow('kimi-k2.6')).toBe(256_000);
    expect(kimi.getEffectiveContextWindow('k2.5')).toBe(128_000);

    const zhipu = getProvider('zhipu');
    expect(zhipu.getEffectiveContextWindow('glm-5')).toBe(200_000);
    expect(zhipu.getEffectiveContextWindow('glm-5.1')).toBe(200_000);
    expect(zhipu.getEffectiveContextWindow('glm-5-turbo')).toBe(128_000);

    const zhipuCoding = getProvider('zhipu-coding');
    expect(zhipuCoding.getEffectiveContextWindow('glm-5-turbo')).toBe(128_000);
  });
});
