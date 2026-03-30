import { describe, expect, it } from 'vitest';
import { KodaXCodexCliProvider } from './codex-cli.js';
import { KodaXGeminiCliProvider } from './gemini-cli.js';

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

describe('CLI bridge providers', () => {
  it('exposes Gemini CLI as an always-configured bridge provider', () => {
    const provider = new KodaXGeminiCliProvider();

    expect(provider.name).toBe('gemini-cli');
    expect(provider.supportsThinking).toBe(false);
    expect(provider.isConfigured()).toBe(true);
    expect(provider.getAvailableModels()).toContain(provider.getModel());
    expect(provider.getCapabilityProfile()).toEqual(EXPECTED_CLI_BRIDGE_PROFILE);

    provider.disconnect();
  });

  it('exposes Codex CLI as an always-configured bridge provider', () => {
    const provider = new KodaXCodexCliProvider();

    expect(provider.name).toBe('codex-cli');
    expect(provider.supportsThinking).toBe(false);
    expect(provider.isConfigured()).toBe(true);
    expect(provider.getAvailableModels()).toContain(provider.getModel());
    expect(provider.getCapabilityProfile()).toEqual(EXPECTED_CLI_BRIDGE_PROFILE);

    provider.disconnect();
  });
});
