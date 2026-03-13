/**
 * ShortcutsProvider - React Context Provider for Shortcuts System
 * ShortcutsProvider - 快捷键系统 React Context Provider
 *
 * Reference: Issue 083 - 键盘快捷键系统
 *
 * Initializes the ShortcutsRegistry with default shortcuts and provides
 * context for shortcut-related state (like help visibility).
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import {
  getShortcutsRegistry,
  DEFAULT_SHORTCUTS,
} from './index.js';
import type { RegisteredShortcut, ShortcutContext } from './types.js';

// === Types ===

/**
 * Shortcuts context value
 * 快捷键上下文值
 */
export interface ShortcutsContextValue {
  /** Whether help panel is visible - 帮助面板是否可见 */
  showHelp: boolean;
  /** Toggle help panel visibility - 切换帮助面板可见性 */
  toggleHelp: () => void;
  /** Show help panel - 显示帮助面板 */
  setShowHelp: (visible: boolean) => void;
  /** Current keyboard context - 当前键盘上下文 */
  currentContext: ShortcutContext;
  /** Set current context - 设置当前上下文 */
  setCurrentContext: (context: ShortcutContext) => void;
  /** Get all shortcuts grouped by category - 获取按分类分组的所有快捷键 */
  getShortcutsByCategory: () => Record<string, RegisteredShortcut[]>;
  /** Get shortcuts for current context - 获取当前上下文的快捷键 */
  getContextShortcuts: () => RegisteredShortcut[];
}

// === Context ===

const ShortcutsContext = createContext<ShortcutsContextValue | null>(null);

// === Provider Props ===

export interface ShortcutsProviderProps {
  children: ReactNode;
  /** Initial context (default: 'input') - 初始上下文（默认：'input'） */
  initialContext?: ShortcutContext;
}

// === Provider ===

/**
 * ShortcutsProvider - Provides shortcuts context to children
 * ShortcutsProvider - 为子组件提供快捷键上下文
 */
export function ShortcutsProvider({
  children,
  initialContext = 'input',
}: ShortcutsProviderProps): React.ReactElement {
  const [showHelp, setShowHelp] = useState(false);
  const [currentContext, setCurrentContext] = useState<ShortcutContext>(initialContext);

  // Initialize registry with default shortcuts SYNCHRONOUSLY
  // This MUST happen during render (not in useEffect) to ensure shortcuts
  // are registered before child components try to use them
  // MUST be sync - 子组件在渲染时就需要访问快捷键定义，所以必须同步注册
  const registry = getShortcutsRegistry();
  registry.registerAll(DEFAULT_SHORTCUTS);

  // Toggle help handler
  const toggleHelp = useCallback(() => {
    setShowHelp((prev) => !prev);
  }, []);

  // Get shortcuts grouped by category
  const getShortcutsByCategory = useCallback(() => {
    const registry = getShortcutsRegistry();
    const shortcuts = registry.getAllShortcuts();

    const categories: Record<string, RegisteredShortcut[]> = {
      global: [],
      mode: [],
      navigation: [],
      editing: [],
    };

    for (const shortcut of shortcuts) {
      const category = shortcut.definition.category;
      if (!categories[category]) {
        categories[category] = [];
      }
      categories[category].push(shortcut);
    }

    return categories;
  }, []);

  // Get shortcuts for current context
  const getContextShortcuts = useCallback(() => {
    const registry = getShortcutsRegistry();
    return registry.getShortcutsByContext(currentContext);
  }, [currentContext]);

  const value: ShortcutsContextValue = {
    showHelp,
    toggleHelp,
    setShowHelp,
    currentContext,
    setCurrentContext,
    getShortcutsByCategory,
    getContextShortcuts,
  };

  return React.createElement(
    ShortcutsContext.Provider,
    { value },
    children
  );
}

// === Hooks ===

/**
 * Get shortcuts context - 获取快捷键上下文
 */
export function useShortcutsContext(): ShortcutsContextValue {
  const context = useContext(ShortcutsContext);
  if (!context) {
    throw new Error('useShortcutsContext must be used within a ShortcutsProvider');
  }
  return context;
}

/**
 * Use help visibility state - 使用帮助可见性状态
 */
export function useHelpVisibility(): {
  showHelp: boolean;
  toggleHelp: () => void;
  setShowHelp: (visible: boolean) => void;
} {
  const { showHelp, toggleHelp, setShowHelp } = useShortcutsContext();
  return { showHelp, toggleHelp, setShowHelp };
}

/**
 * Use shortcut context state - 使用快捷键上下文状态
 */
export function useShortcutContext(): {
  currentContext: ShortcutContext;
  setCurrentContext: (context: ShortcutContext) => void;
} {
  const { currentContext, setCurrentContext } = useShortcutsContext();
  return { currentContext, setCurrentContext };
}
