import { describe, expect, it } from 'vitest';
import {
  getProviderConfiguredCapabilityProfile,
  getProviderList,
  getProviderModels,
} from './registry.js';

const EXPECTED_CLI_BRIDGE_PROFILE = {
  transport: 'cli-bridge',
  conversationSemantics: 'last-user-message',
  mcpSupport: 'none',
  contextFidelity: 'lossy',
  toolCallingFidelity: 'limited',
  sessionSupport: 'stateless',
  longRunningSupport: 'limited',
  multimodalSupport: 'none',
  evidenceSupport: 'limited',
} as const;

const EXPECTED_IMAGE_INPUT_CLI_BRIDGE_PROFILE = {
  ...EXPECTED_CLI_BRIDGE_PROFILE,
  multimodalSupport: 'image-input',
} as const;

const EXPECTED_NATIVE_PROFILE = {
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

const EXPECTED_IMAGE_INPUT_NATIVE_PROFILE = {
  ...EXPECTED_NATIVE_PROFILE,
  multimodalSupport: 'image-input',
} as const;

describe('provider capability profiles', () => {
  it('marks CLI bridge providers as lossy bridge transports in snapshot metadata', () => {
    // gemini-cli was widened to image-input in FEATURE_134 v0.7.40 since
    // Gemini CLI 2.x supports `@<path>` file-include syntax in prompts.
    expect(getProviderConfiguredCapabilityProfile('gemini-cli')).toEqual(
      EXPECTED_IMAGE_INPUT_CLI_BRIDGE_PROFILE,
    );
    expect(getProviderConfiguredCapabilityProfile('codex-cli')).toEqual(
      EXPECTED_CLI_BRIDGE_PROFILE,
    );

    const providers = getProviderList();
    expect(
      providers.find((provider) => provider.name === 'gemini-cli')?.capabilityProfile,
    ).toEqual(EXPECTED_IMAGE_INPUT_CLI_BRIDGE_PROFILE);
    expect(
      providers.find((provider) => provider.name === 'codex-cli')?.capabilityProfile,
    ).toEqual(EXPECTED_CLI_BRIDGE_PROFILE);
  });

  it('keeps multimodal-native providers on image-input capable native profiles', () => {
    expect(getProviderConfiguredCapabilityProfile('anthropic')).toEqual(
      EXPECTED_IMAGE_INPUT_NATIVE_PROFILE,
    );
    expect(getProviderConfiguredCapabilityProfile('openai')).toEqual(
      EXPECTED_IMAGE_INPUT_NATIVE_PROFILE,
    );
  });

  it('marks verified image-input providers as image-input capable (FEATURE_134 v0.7.40)', () => {
    // Anthropic-compat clones inherit anthropic.ts:770 image block forwarding.
    // OpenAI-compat clones inherit openai.ts:904 image_url forwarding.
    // Gemini-CLI gets image input through the CLI's `@<path>` syntax wired by
    // `KodaXGeminiCliProvider.serializeImageBlockToPromptToken`.
    // The flag means KodaX does not artificially block multimodal requests
    // at the SA-path policy gate; per-model vision support is the upstream
    // provider's contract.
    const visionCapableProviders = [
      'anthropic',
      'openai',
      'deepseek',
      'kimi',
      'kimi-code',
      'qwen',
      'qwen-token-plan',
      'zhipu',
      'zhipu-coding',
      'zai-coding',
      'minimax-coding',
      'mimo-coding',
      'mimo',
      'ark-coding',
      'gemini-cli',
    ] as const;
    for (const provider of visionCapableProviders) {
      expect(getProviderConfiguredCapabilityProfile(provider)?.multimodalSupport).toBe(
        'image-input',
      );
    }
  });

  it('marks DeepSeek image-input capable for the vision-exp model route', () => {
    // Provider-level gate opened with the 2026-08 deepseek-v4-flash-vision-exp
    // announcement; per-model routing (only the vision model accepts images,
    // flash/pro stay text-only) lives in @kodax-ai/agent media capabilities.
    expect(getProviderConfiguredCapabilityProfile('deepseek')).toEqual(
      EXPECTED_IMAGE_INPUT_NATIVE_PROFILE,
    );
  });

  it('keeps codex-cli text-only (no `codex exec --json` image input surface)', () => {
    expect(getProviderConfiguredCapabilityProfile('codex-cli')?.multimodalSupport).toBe(
      'none',
    );
  });

  it('returns null for unknown providers instead of inventing a native profile', () => {
    expect(getProviderConfiguredCapabilityProfile('unknown-provider')).toBeNull();
  });

  it('exposes the current MiniMax coding model lineup in snapshot metadata', () => {
    // 2026-06: M2.5 / M2.1 / M2 (+ their -highspeed variants) retired
    // by the upstream gateway — only the M2.7 GA pair and the M3
    // Frontier Coding model remain.
    expect(getProviderModels('minimax-coding')).toEqual([
      'MiniMax-M3',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.7',
    ]);

    expect(
      getProviderList().find((provider) => provider.name === 'minimax-coding')?.model,
    ).toBe('MiniMax-M3');
  });

  it('lists each built-in provider model once with the default first', () => {
    for (const provider of getProviderList()) {
      const models = getProviderModels(provider.name);

      expect(models[0]).toBe(provider.model);
      expect(new Set(models).size).toBe(models.length);
      expect(provider.models).toEqual(models);
    }
  });
});
