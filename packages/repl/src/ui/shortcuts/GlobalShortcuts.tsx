/**
 * GlobalShortcuts - Global Keyboard Shortcuts Handler
 * GlobalShortcuts - 全局键盘快捷键处理器
 *
 * Reference: Issue 083 - 键盘快捷键系统
 *
 * This component registers global shortcuts using the shortcuts system.
 * It should be placed inside the component tree where it can access
 * the necessary state and callbacks.
 */

import chalk from 'chalk';
import { useShortcut } from './index.js';
import type { CurrentConfig } from '../../interactive/commands.js';
import type { PermissionMode } from '../../permission/types.js';

/**
 * GlobalShortcuts props
 */
export interface GlobalShortcutsProps {
  /** Current configuration state - 当前配置状态 */
  currentConfig: CurrentConfig;
  /** Update configuration callback - 更新配置回调 */
  setCurrentConfig: React.Dispatch<React.SetStateAction<CurrentConfig>>;
  /** Whether streaming is in progress - 是否正在 streaming */
  isLoading: boolean;
  /** Abort streaming callback - 中断 streaming 回调 */
  abort: () => void;
  /** Stop thinking indicator - 停止思考指示器 */
  stopThinking: () => void;
  /** Clear thinking content - 清除思考内容 */
  clearThinkingContent: () => void;
  /** Set current tool - 设置当前工具 */
  setCurrentTool: (tool: string | undefined) => void;
  /** Set loading state - 设置加载状态 */
  setIsLoading: (loading: boolean) => void;
  /** Toggle help panel - 切换帮助面板 */
  onToggleHelp: () => void;
  /** Set help visibility - 设置帮助栏可见性 */
  setShowHelp: (visible: boolean) => void;
  onSetThinking?: (enabled: boolean) => void;
  /** Whether input is empty (for ? shortcut) - 输入是否为空（用于 ? 快捷键） */
  isInputEmpty: boolean;
  /** Save permission mode to config - 保存权限模式到配置 */
  onSavePermissionMode?: (mode: PermissionMode) => void;
}

/**
 * GlobalShortcuts component - registers global keyboard shortcuts
 * GlobalShortcuts 组件 - 注册全局键盘快捷键
 */
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
  isInputEmpty,
  onSavePermissionMode,
}: GlobalShortcutsProps): null {
  // === Interrupt shortcut (Ctrl+C during streaming) ===
  // This integrates with the existing interrupt handling
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
    { isActive: isLoading }
  );

  // === Show help shortcut (?) ===
  // Only show help when input is empty - otherwise let ? be typed normally
  // 只有输入为空时才显示帮助，否则允许正常输入 ? 字符
  useShortcut('showHelp', () => {
    if (isInputEmpty) {
      onToggleHelp();
      return true; // Consume the event, don't type ?
    }
    return false; // Let ? be typed normally
  }, { isActive: isInputEmpty });

  // === Toggle thinking shortcut (Ctrl+T) ===
  useShortcut('toggleThinking', () => {
    const newThinking = !currentConfig.thinking;
    setCurrentConfig((prev: CurrentConfig) => ({ ...prev, thinking: newThinking }));
    onSetThinking?.(newThinking);
    // Hide help panel when using other shortcuts - 使用其他快捷键时隐藏帮助栏
    setShowHelp(false);
    return true;
  });

  // === Toggle permission mode shortcut (Ctrl+O / Shift+Tab) ===
  // Cycles through: plan → accept-edits → auto-in-project → plan
  useShortcut('togglePermissionMode', () => {
    const MODE_CYCLE: PermissionMode[] = ['plan', 'accept-edits', 'auto-in-project'];
    const currentIndex = MODE_CYCLE.indexOf(currentConfig.permissionMode);
    const nextIndex = (currentIndex + 1) % MODE_CYCLE.length;
    const newMode = MODE_CYCLE[nextIndex];

    setCurrentConfig((prev: CurrentConfig) => ({ ...prev, permissionMode: newMode }));
    onSavePermissionMode?.(newMode); // Persist to config
    // Hide help panel when using other shortcuts - 使用其他快捷键时隐藏帮助栏
    setShowHelp(false);
    return true;
  });

  // This component doesn't render anything
  return null;
}
