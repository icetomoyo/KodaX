import { describe, expect, it } from 'vitest';
import {
  getProviderConfiguredCapabilityProfile,
  getProviderList,
} from './registry.js';

describe('provider capability profiles', () => {
  it('marks CLI bridge providers as lossy bridge transports in snapshot metadata', () => {
    expect(getProviderConfiguredCapabilityProfile('gemini-cli')).toEqual({
      transport: 'cli-bridge',
      conversationSemantics: 'last-user-message',
      mcpSupport: 'none',
    });
    expect(getProviderConfiguredCapabilityProfile('codex-cli')).toEqual({
      transport: 'cli-bridge',
      conversationSemantics: 'last-user-message',
      mcpSupport: 'none',
    });

    const providers = getProviderList();
    expect(providers.find((provider) => provider.name === 'gemini-cli')?.capabilityProfile).toEqual({
      transport: 'cli-bridge',
      conversationSemantics: 'last-user-message',
      mcpSupport: 'none',
    });
    expect(providers.find((provider) => provider.name === 'codex-cli')?.capabilityProfile).toEqual({
      transport: 'cli-bridge',
      conversationSemantics: 'last-user-message',
      mcpSupport: 'none',
    });
  });

  it('keeps native providers on full-history native MCP profiles', () => {
    expect(getProviderConfiguredCapabilityProfile('anthropic')).toEqual({
      transport: 'native-api',
      conversationSemantics: 'full-history',
      mcpSupport: 'none',
    });
    expect(getProviderConfiguredCapabilityProfile('openai')).toEqual({
      transport: 'native-api',
      conversationSemantics: 'full-history',
      mcpSupport: 'none',
    });
  });

  it('returns null for unknown providers instead of inventing a native profile', () => {
    expect(getProviderConfiguredCapabilityProfile('unknown-provider')).toBeNull();
  });
});
