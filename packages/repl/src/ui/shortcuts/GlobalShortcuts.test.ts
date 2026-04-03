import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentConfig } from '../../interactive/commands.js';

const {
  shortcutHandlers,
  saveConfigMock,
} = vi.hoisted(() => ({
  shortcutHandlers: new Map<string, () => boolean>(),
  saveConfigMock: vi.fn(),
}));

vi.mock('./index.js', () => ({
  useShortcut: (actionId: string, handler: () => boolean) => {
    shortcutHandlers.set(actionId, handler);
  },
}));

vi.mock('../../common/utils.js', () => ({
  saveConfig: (...args: unknown[]) => saveConfigMock(...args),
}));

import { GlobalShortcuts } from './GlobalShortcuts.js';

describe('GlobalShortcuts', () => {
  beforeEach(() => {
    shortcutHandlers.clear();
    saveConfigMock.mockReset();
  });

  it('lets Ctrl+P toggle execution mode even while help is open', () => {
    let currentConfig: CurrentConfig = {
      provider: 'openai',
      model: 'gpt-5.4',
      thinking: false,
      reasoningMode: 'off',
      agentMode: 'ama',
      parallel: false,
      permissionMode: 'accept-edits',
    };

    const setShowHelp = vi.fn();
    const onSetParallel = vi.fn();

    GlobalShortcuts({
      currentConfig,
      setCurrentConfig: (updater) => {
        currentConfig =
          typeof updater === 'function'
            ? updater(currentConfig)
            : updater;
      },
      isLoading: false,
      abort: vi.fn(),
      stopThinking: vi.fn(),
      clearThinkingContent: vi.fn(),
      setCurrentTool: vi.fn(),
      setIsLoading: vi.fn(),
      onToggleHelp: vi.fn(),
      setShowHelp,
      onSetParallel,
      isInputEmpty: true,
    });

    const handler = shortcutHandlers.get('toggleParallelMode');
    expect(handler).toBeDefined();
    expect(handler?.()).toBe(true);
    expect(currentConfig.parallel).toBe(true);
    expect(saveConfigMock).toHaveBeenCalledWith({ parallel: true });
    expect(onSetParallel).toHaveBeenCalledWith(true);
    expect(setShowHelp).toHaveBeenCalledWith(false);
  });

  it('lets Alt+M toggle agent mode and persist the change', () => {
    let currentConfig: CurrentConfig = {
      provider: 'openai',
      model: 'gpt-5.4',
      thinking: false,
      reasoningMode: 'off',
      agentMode: 'ama',
      parallel: false,
      permissionMode: 'accept-edits',
    };

    const setShowHelp = vi.fn();
    const onSetAgentMode = vi.fn();

    GlobalShortcuts({
      currentConfig,
      setCurrentConfig: (updater) => {
        currentConfig =
          typeof updater === 'function'
            ? updater(currentConfig)
            : updater;
      },
      isLoading: false,
      abort: vi.fn(),
      stopThinking: vi.fn(),
      clearThinkingContent: vi.fn(),
      setCurrentTool: vi.fn(),
      setIsLoading: vi.fn(),
      onToggleHelp: vi.fn(),
      setShowHelp,
      onSetAgentMode,
      isInputEmpty: true,
    });

    const handler = shortcutHandlers.get('toggleAgentMode');
    expect(handler).toBeDefined();
    expect(handler?.()).toBe(true);
    expect(currentConfig.agentMode).toBe('sa');
    expect(saveConfigMock).toHaveBeenCalledWith({ agentMode: 'sa' });
    expect(onSetAgentMode).toHaveBeenCalledWith('sa');
    expect(setShowHelp).toHaveBeenCalledWith(false);
  });

  it('lets Ctrl+O toggle transcript verbosity without persisting config', () => {
    const currentConfig: CurrentConfig = {
      provider: 'openai',
      model: 'gpt-5.4',
      thinking: false,
      reasoningMode: 'off',
      agentMode: 'ama',
      parallel: false,
      permissionMode: 'accept-edits',
    };

    const setShowHelp = vi.fn();
    const onToggleTranscriptVerbosity = vi.fn();

    GlobalShortcuts({
      currentConfig,
      setCurrentConfig: vi.fn(),
      isLoading: false,
      abort: vi.fn(),
      stopThinking: vi.fn(),
      clearThinkingContent: vi.fn(),
      setCurrentTool: vi.fn(),
      setIsLoading: vi.fn(),
      onToggleHelp: vi.fn(),
      setShowHelp,
      onToggleTranscriptVerbosity,
      isInputEmpty: true,
    });

    const handler = shortcutHandlers.get('toggleTranscriptVerbosity');
    expect(handler).toBeDefined();
    expect(handler?.()).toBe(true);
    expect(onToggleTranscriptVerbosity).toHaveBeenCalledTimes(1);
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(setShowHelp).toHaveBeenCalledWith(false);
  });

  it('does not open transcript search while interactive dialogs are active', () => {
    const currentConfig: CurrentConfig = {
      provider: 'openai',
      model: 'gpt-5.4',
      thinking: false,
      reasoningMode: 'off',
      agentMode: 'ama',
      parallel: false,
      permissionMode: 'accept-edits',
    };

    const setShowHelp = vi.fn();
    const onOpenTranscriptSearch = vi.fn();

    GlobalShortcuts({
      currentConfig,
      setCurrentConfig: vi.fn(),
      isLoading: false,
      abort: vi.fn(),
      stopThinking: vi.fn(),
      clearThinkingContent: vi.fn(),
      setCurrentTool: vi.fn(),
      setIsLoading: vi.fn(),
      onToggleHelp: vi.fn(),
      setShowHelp,
      onOpenTranscriptSearch,
      canOpenTranscriptSearch: false,
      isInputEmpty: true,
    });

    const handler = shortcutHandlers.get('openTranscriptSearch');
    expect(handler).toBeDefined();
    expect(handler?.()).toBe(false);
    expect(onOpenTranscriptSearch).not.toHaveBeenCalled();
    expect(setShowHelp).not.toHaveBeenCalled();
  });
});
