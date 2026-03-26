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

describe('provider capability profiles', () => {
  it('marks CLI bridge providers as lossy bridge transports in snapshot metadata', () => {
    expect(getProviderConfiguredCapabilityProfile('gemini-cli')).toEqual(
      EXPECTED_CLI_BRIDGE_PROFILE,
    );
    expect(getProviderConfiguredCapabilityProfile('codex-cli')).toEqual(
      EXPECTED_CLI_BRIDGE_PROFILE,
    );

    const providers = getProviderList();
    expect(
      providers.find((provider) => provider.name === 'gemini-cli')?.capabilityProfile,
    ).toEqual(EXPECTED_CLI_BRIDGE_PROFILE);
    expect(
      providers.find((provider) => provider.name === 'codex-cli')?.capabilityProfile,
    ).toEqual(EXPECTED_CLI_BRIDGE_PROFILE);
  });

  it('keeps native providers on full-history native MCP profiles', () => {
    expect(getProviderConfiguredCapabilityProfile('anthropic')).toEqual(
      EXPECTED_NATIVE_PROFILE,
    );
    expect(getProviderConfiguredCapabilityProfile('openai')).toEqual(
      EXPECTED_NATIVE_PROFILE,
    );
  });

  it('returns null for unknown providers instead of inventing a native profile', () => {
    expect(getProviderConfiguredCapabilityProfile('unknown-provider')).toBeNull();
  });

  it('exposes the current MiniMax coding model lineup in snapshot metadata', () => {
    expect(getProviderModels('minimax-coding')).toEqual([
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
      'MiniMax-M2.1',
      'MiniMax-M2.1-highspeed',
      'MiniMax-M2',
    ]);

    expect(
      getProviderList().find((provider) => provider.name === 'minimax-coding')?.model,
    ).toBe('MiniMax-M2.7');
  });
});
