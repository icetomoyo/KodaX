/**
 * GlobalShortcuts - Global Keyboard Shortcuts Handler
 *
 * This component registers global shortcuts using the shortcuts system.
 * It should be placed inside the component tree where it can access
 * the necessary state and callbacks.
 */

import type React from 'react';
import chalk from 'chalk';
import {
  type KodaXAgentMode,
  KODAX_REASONING_MODE_SEQUENCE,
  type KodaXReasoningMode,
} from '@kodax/coding';
import { useShortcut } from './index.js';
import type { CurrentConfig } from '../../interactive/commands.js';
import type { PermissionMode } from '../../permission/types.js';
import { saveConfig } from '../../common/utils.js';

export interface GlobalShortcutsProps {
  currentConfig: CurrentConfig;
  setCurrentConfig: React.Dispatch<React.SetStateAction<CurrentConfig>>;
  isLoading: boolean;
  abort: () => void;
  stopThinking: () => void;
  clearThinkingContent: () => void;
  setCurrentTool: (tool: string | undefined) => void;
  setIsLoading: (loading: boolean) => void;
  onToggleHelp: () => void;
  setShowHelp: (visible: boolean) => void;
  onSetThinking?: (enabled: boolean) => void;
  onSetReasoningMode?: (mode: KodaXReasoningMode) => void;
  onToggleTranscriptVerbosity?: () => void;
  onSetAgentMode?: (mode: KodaXAgentMode) => void;
  onSetPermissionMode?: (mode: PermissionMode) => void;
  onSetParallel?: (enabled: boolean) => void;
  isInputEmpty: boolean;
  onSavePermissionMode?: (mode: PermissionMode) => void;
}

export function GlobalShortcuts({
  currentConfig,
  setCurrentConfig,
  isLoading,
  abort,
  stopThinking,
  clearThinkingContent,
  setCurrentTool,
  setIsLoading,
  onToggleHelp,
  setShowHelp,
  onSetThinking,
  onSetReasoningMode,
  onToggleTranscriptVerbosity,
  onSetAgentMode,
  onSetPermissionMode,
  onSetParallel,
  isInputEmpty,
  onSavePermissionMode,
}: GlobalShortcutsProps): null {
  useShortcut(
    'interrupt',
    () => {
      if (isLoading) {
        abort();
        stopThinking();
        clearThinkingContent();
        setCurrentTool(undefined);
        setIsLoading(false);
        console.log(chalk.yellow('\n[Interrupted]'));
        return true;
      }
      return false;
    },
    { isActive: isLoading },
  );

  useShortcut(
    'showHelp',
    () => {
      if (isInputEmpty) {
        onToggleHelp();
        return true;
      }
      return false;
    },
    { isActive: isInputEmpty },
  );

  useShortcut('toggleThinking', () => {
    const currentIndex = KODAX_REASONING_MODE_SEQUENCE.indexOf(
      currentConfig.reasoningMode,
    );
    const nextMode =
      KODAX_REASONING_MODE_SEQUENCE[
        (currentIndex + 1) % KODAX_REASONING_MODE_SEQUENCE.length
      ];
    const thinking = nextMode !== 'off';

    setCurrentConfig((prev) => ({
      ...prev,
      thinking,
      reasoningMode: nextMode,
    }));
    saveConfig({
      reasoningMode: nextMode,
      thinking,
    });
    onSetReasoningMode?.(nextMode);
    onSetThinking?.(thinking);
    setShowHelp(false);
    return true;
  });

  useShortcut('toggleTranscriptVerbosity', () => {
    onToggleTranscriptVerbosity?.();
    setShowHelp(false);
    return true;
  });

  useShortcut('togglePermissionMode', () => {
    const modeCycle: PermissionMode[] = ['plan', 'accept-edits', 'auto-in-project'];
    const currentIndex = modeCycle.indexOf(currentConfig.permissionMode);
    const nextIndex = (currentIndex + 1) % modeCycle.length;
    const newMode = modeCycle[nextIndex];

    setCurrentConfig((prev) => ({ ...prev, permissionMode: newMode }));
    onSetPermissionMode?.(newMode);
    onSavePermissionMode?.(newMode);
    setShowHelp(false);
    return true;
  });

  useShortcut('toggleAgentMode', () => {
    const nextMode: KodaXAgentMode = currentConfig.agentMode === 'ama' ? 'sa' : 'ama';

    setCurrentConfig((prev) => ({ ...prev, agentMode: nextMode }));
    saveConfig({ agentMode: nextMode });
    onSetAgentMode?.(nextMode);
    setShowHelp(false);
    return true;
  });

  useShortcut('toggleParallelMode', () => {
    const nextValue = !currentConfig.parallel;

    setCurrentConfig((prev) => ({ ...prev, parallel: nextValue }));
    saveConfig({ parallel: nextValue });
    onSetParallel?.(nextValue);
    setShowHelp(false);
    return true;
  });

  return null;
}
