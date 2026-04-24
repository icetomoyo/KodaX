import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_COMMANDS, type CommandCallbacks, type CurrentConfig } from './commands.js';
import { createInteractiveContext, type InteractiveContext } from './context.js';
import {
  getProviderList,
  getProviderReasoningCapability,
} from '../common/utils.js';

describe('provider capability disclosure', () => {
  let context: InteractiveContext;
  let currentConfig: CurrentConfig;

  beforeEach(async () => {
    context = await createInteractiveContext({});
    currentConfig = {
      provider: 'gemini-cli',
      thinking: true,
      reasoningMode: 'balanced',
      agentMode: 'ama',
      permissionMode: 'accept-edits',
    };
  });

  it('shows bridge capability limits in /model provider list output', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const modelCommand = BUILTIN_COMMANDS.find((command) => command.name === 'model');

    expect(modelCommand).toBeDefined();
    await modelCommand!.handler([], context, {} as CommandCallbacks, currentConfig);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('gemini-cli');
    expect(output).toContain('codex-cli');
    expect(output).toContain('[configured]');
    expect(output).toContain('CLI bridge; forwards only the latest user message; MCP unavailable');
  });

  it('shows the active provider capability profile in /status', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const statusCommand = BUILTIN_COMMANDS.find((command) => command.name === 'status');

    expect(statusCommand).toBeDefined();
    await statusCommand!.handler([], context, {} as CommandCallbacks, currentConfig);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Session Status');
    expect(output).toContain('Provider Cap:');
    expect(output).toContain('CLI bridge; forwards only the latest user message; MCP unavailable');
    expect(output).toContain('Provider Policy:');
    expect(output).toContain('native reasoning control is unavailable on this provider');
  });

  it('shows the full capability matrix and common policy scenarios in /provider', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const providerCommand = BUILTIN_COMMANDS.find((command) => command.name === 'provider');

    expect(providerCommand).toBeDefined();
    await providerCommand!.handler([], context, {} as CommandCallbacks, currentConfig);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Provider Details:');
    expect(output).toContain('Source:');
    expect(output).toContain('Capability Matrix:');
    expect(output).toContain('Context fidelity: lossy');
    expect(output).toContain('Long-running support: limited');
    expect(output).toContain('Common Scenarios:');
    expect(output).toContain('Long-running task: BLOCK');
  });

  it('keeps bridge providers marked as configured and prompt-only for reasoning UX', () => {
    const providers = getProviderList();
    expect(providers.find((provider) => provider.name === 'gemini-cli')?.configured).toBe(true);
    expect(providers.find((provider) => provider.name === 'codex-cli')?.configured).toBe(true);
    expect(getProviderReasoningCapability('gemini-cli')).toBe('prompt-only');
    expect(getProviderReasoningCapability('codex-cli')).toBe('prompt-only');
  });

  it('resolves deepseek capability by active model when available', () => {
    expect(getProviderReasoningCapability('deepseek', 'deepseek-chat')).toBe('native-toggle');
    expect(getProviderReasoningCapability('deepseek', 'deepseek-reasoner')).toBe('none');
  });

  it('does not overstate MCP support for native API providers', async () => {
    currentConfig.provider = 'anthropic';

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const statusCommand = BUILTIN_COMMANDS.find((command) => command.name === 'status');

    expect(statusCommand).toBeDefined();
    await statusCommand!.handler([], context, {} as CommandCallbacks, currentConfig);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Native API; preserves full conversation history; MCP unavailable');
    expect(output).not.toContain('MCP available');
  });
});
