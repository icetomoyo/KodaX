import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentConfig } from '../../interactive/commands.js';

const {
  shortcutHandlers,
  saveConfigMock,
} = vi.hoisted(() => ({
  shortcutHandlers: new Map<string, () => boolean>(),
  saveConfigMock: vi.fn(),
}));

// FEATURE_093 (v0.7.24): GlobalShortcuts now imports `useShortcut` directly
// from `./useShortcut.js` rather than the barrel `./index.js` to avoid the
// cycle — mock the concrete path so the hook is intercepted at the source.
vi.mock('./useShortcut.js', () => ({
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

  it('lets Alt+M toggle agent mode and persist the change', () => {
    let currentConfig: CurrentConfig = {
      provider: 'openai',
      model: 'gpt-5.4',
      thinking: false,
      reasoningMode: 'off',
      agentMode: 'ama',
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

  it('lets Ctrl+O toggle transcript mode without persisting config', () => {
    const currentConfig: CurrentConfig = {
      provider: 'openai',
      model: 'gpt-5.4',
      thinking: false,
      reasoningMode: 'off',
      agentMode: 'ama',
      permissionMode: 'accept-edits',
    };

    const setShowHelp = vi.fn();
    const onToggleTranscriptMode = vi.fn();

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
      onToggleTranscriptMode,
      isInputEmpty: true,
    });

    const handler = shortcutHandlers.get('toggleTranscriptMode');
    expect(handler).toBeDefined();
    expect(handler?.()).toBe(true);
    expect(onToggleTranscriptMode).toHaveBeenCalledTimes(1);
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

  it('blocks mode toggles while interactive dialogs are active', () => {
    let currentConfig: CurrentConfig = {
      provider: 'openai',
      model: 'gpt-5.4',
      thinking: false,
      reasoningMode: 'off',
      agentMode: 'ama',
      permissionMode: 'accept-edits',
    };

    const setShowHelp = vi.fn();

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
      isInteractiveDialogActive: true,
      isInputEmpty: true,
    });

    const toggleThinking = shortcutHandlers.get('toggleThinking');

    expect(toggleThinking).toBeDefined();
    expect(toggleThinking?.()).toBe(false);
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(setShowHelp).not.toHaveBeenCalled();
  });
});
