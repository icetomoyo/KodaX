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
    expect(getProviderConfiguredReasoningCapability('deepseek', 'deepseek-reasoner')).toBe('none');
    expect(getProviderConfiguredReasoningCapability('deepseek', 'deepseek-chat')).toBe('native-toggle');
    expect(getProviderConfiguredReasoningCapability('unknown-provider')).toBe('unknown');
  });

  it('throws a provider error for unknown providers', () => {
    expect(() => getProvider('missing-provider')).toThrowError(KodaXProviderError);
  });

  it('exposes a stable default provider snapshot', () => {
    expect(typeof KODAX_DEFAULT_PROVIDER).toBe('string');
    expect(getProvider()).toBeDefined();
  });
});
