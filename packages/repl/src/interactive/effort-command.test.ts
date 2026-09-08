import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock only saveConfig so the test never touches the real ~/.kodax/config.json.
vi.mock('../common/utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../common/utils.js')>()),
  saveConfig: vi.fn(),
}));

import { saveConfig } from '../common/utils.js';
import { BUILTIN_COMMANDS } from './commands.js';
import type { CommandCallbacks, CurrentConfig, InteractiveContext } from '../commands/types.js';

const effortCmd = BUILTIN_COMMANDS.find((command) => command.name === 'effort')!;
const thinkingCmd = BUILTIN_COMMANDS.find((command) => command.name === 'thinking')!;
const reasoningCmd = BUILTIN_COMMANDS.find((command) => command.name === 'reasoning')!;
const ctx = {} as unknown as InteractiveContext;
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function createConfig(overrides: Partial<CurrentConfig> = {}): CurrentConfig {
  return {
    provider: 'openai',
    thinking: false,
    reasoningMode: 'off',
    agentMode: 'ama',
    permissionMode: 'accept-edits',
    ...overrides,
  };
}

function getLoggedOutput(): string {
  return vi.mocked(console.log).mock.calls
    .map(([line]) => String(line))
    .join('\n')
    .replace(ANSI_PATTERN, '');
}

describe('/effort command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not report success when the Host rejects the settings write', async () => {
    const config = createConfig();
    const callbacks = {
      setEffort: vi.fn().mockRejectedValue(new Error('Host settings write failed')),
      setReasoningMode: vi.fn(),
    } as unknown as CommandCallbacks;
    await expect(effortCmd.handler(['high'], ctx, callbacks, config))
      .rejects.toThrow('Host settings write failed');
    expect(callbacks.setReasoningMode).not.toHaveBeenCalled();
    expect(getLoggedOutput()).not.toContain('Reasoning effort:');
    expect(config.effort).toBeUndefined();
  });

  it('reports success only after the Host settings write has finished', async () => {
    let finish!: () => void;
    const callbacks = {
      setEffort: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })),
      setReasoningMode: vi.fn(),
    } as unknown as CommandCallbacks;
    const pending = effortCmd.handler(['high'], ctx, callbacks, createConfig());
    await vi.waitFor(() => expect(callbacks.setEffort).toHaveBeenCalledOnce());
    expect(getLoggedOutput()).not.toContain('Reasoning effort:');
    finish();
    await pending;
    expect(getLoggedOutput()).toContain('Reasoning effort:');
  });

  it('sets explicit effort and re-enables legacy reasoning when it was off', async () => {
    const setEffort = vi.fn();
    const setReasoningMode = vi.fn();
    const callbacks = { setEffort, setReasoningMode } as unknown as CommandCallbacks;
    const config = createConfig();

    await effortCmd.handler(['high'], ctx, callbacks, config);

    expect(saveConfig).toHaveBeenCalledWith({
      effort: 'high',
      reasoningMode: 'auto',
      thinking: true,
    });
    expect(setEffort).toHaveBeenCalledWith('high');
    expect(setReasoningMode).toHaveBeenCalledWith('auto');
  });

  it('clears explicit effort with auto and normalizes the legacy reasoning mode', async () => {
    const setEffort = vi.fn();
    const setReasoningMode = vi.fn();
    const callbacks = { setEffort, setReasoningMode } as unknown as CommandCallbacks;
    const config = createConfig({ effort: 'high', reasoningMode: 'deep', thinking: true });

    await effortCmd.handler(['auto'], ctx, callbacks, config);

    // V2: reasoningMode is a derived compat field that is only ever 'auto'/'off'.
    // Clearing to auto must lift a stale legacy 'deep' to 'auto' (and keep
    // thinking on) so the status label and legacy display don't keep reading
    // 'high' from the dead value. Mirrors the Ctrl+T toggle's full triple write.
    expect(saveConfig).toHaveBeenCalledWith({
      effort: undefined,
      reasoningMode: 'auto',
      thinking: true,
    });
    expect(setEffort).toHaveBeenCalledWith(undefined);
    expect(setReasoningMode).toHaveBeenCalledWith('auto');
  });

  it('restores auto reasoning when clearing a previous none effort', async () => {
    const setEffort = vi.fn();
    const setReasoningMode = vi.fn();
    const callbacks = { setEffort, setReasoningMode } as unknown as CommandCallbacks;
    const config = createConfig({ effort: 'none', reasoningMode: 'off', thinking: false });

    await effortCmd.handler(['auto'], ctx, callbacks, config);

    expect(saveConfig).toHaveBeenCalledWith({
      effort: undefined,
      reasoningMode: 'auto',
      thinking: true,
    });
    expect(setEffort).toHaveBeenCalledWith(undefined);
    expect(setReasoningMode).toHaveBeenCalledWith('auto');
  });

  it('maps none to legacy reasoning off for visible runtime state', async () => {
    const setEffort = vi.fn();
    const setReasoningMode = vi.fn();
    const callbacks = { setEffort, setReasoningMode } as unknown as CommandCallbacks;
    const config = createConfig({ reasoningMode: 'auto', thinking: true });

    await effortCmd.handler(['none'], ctx, callbacks, config);

    expect(saveConfig).toHaveBeenCalledWith({
      effort: 'none',
      reasoningMode: 'off',
      thinking: false,
    });
    expect(setEffort).toHaveBeenCalledWith('none');
    expect(setReasoningMode).toHaveBeenCalledWith('off');
  });

  it('prints the effective effort label after provider capability fallback', async () => {
    const setEffort = vi.fn();
    const callbacks = { setEffort } as unknown as CommandCallbacks;
    const config = createConfig({
      model: 'gpt-5.3-codex',
      effortOverride: false,
      reasoningMode: 'auto',
      thinking: true,
    });

    await effortCmd.handler(['max'], ctx, callbacks, config);

    // Persist the full coherent triple (parity with the Ctrl+T toggle), not just
    // the bare effort — a reloaded config must replay identical thinking state.
    expect(saveConfig).toHaveBeenCalledWith({
      effort: 'max',
      reasoningMode: 'auto',
      thinking: true,
    });
    expect(setEffort).toHaveBeenCalledWith('max');
    expect(getLoggedOutput()).toContain('Reasoning effort: max->medium');
  });

  it('rejects whitespace-split effort values without persisting', async () => {
    const callbacks = {} as unknown as CommandCallbacks;
    await effortCmd.handler(['high', 'now'], ctx, callbacks, createConfig());

    expect(saveConfig).not.toHaveBeenCalled();
  });

  it.each([
    [thinkingCmd, 'deep'],
    [reasoningCmd, 'deep'],
  ])('routes legacy %s depth through the native effort writer', async (command, value) => {
    const setEffort = vi.fn();
    const setReasoningMode = vi.fn();
    const callbacks = { setEffort, setReasoningMode } as unknown as CommandCallbacks;
    const config = createConfig({ effort: 'max', effortOverride: true, reasoningMode: 'auto', thinking: true });

    await command.handler([value], ctx, callbacks, config);

    expect(saveConfig).toHaveBeenCalledWith({
      effort: 'high',
      reasoningMode: 'auto',
      thinking: true,
    });
    expect(setEffort).toHaveBeenCalledWith('high');
  });

  it('rejects none before saving when the active model is always-on thinking', async () => {
    const callbacks = { setEffort: vi.fn() } as unknown as CommandCallbacks;
    const config = createConfig({
      provider: 'qwen-token-plan',
      model: 'qwen3.8-max-preview',
      effort: 'high',
      effortOverride: true,
      reasoningMode: 'auto',
      thinking: true,
    });

    await thinkingCmd.handler(['none'], ctx, callbacks, config);

    expect(saveConfig).not.toHaveBeenCalled();
    expect(callbacks.setEffort).not.toHaveBeenCalled();
    expect(getLoggedOutput()).toContain('does not support disabling reasoning');
  });
});
