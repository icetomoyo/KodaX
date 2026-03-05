/**
 * useAutocomplete - Autocomplete integration hook - 自动补全集成 Hook
 *
 * Provides autocomplete state management and keyboard handling for input components.
 * 为输入组件提供自动补全状态管理和键盘处理。
 *
 * Usage:
 * 1. Call useAutocomplete with text/cursor state
 * 2. Render autocompleteSuggestions below input
 * 3. Handle Tab/Enter for selection in keypress handler
 */

import { useState, useEffect, useCallback, useMemo, createContext, useContext, type ReactNode } from "react";
import {
  AutocompleteProvider,
  createAutocompleteProvider,
  type AutocompleteState,
} from "../../interactive/autocomplete-provider.js";
import type { Suggestion } from "../types.js";
import type { Completion } from "../../interactive/autocomplete.js";

// ============================================================================
// Autocomplete Context - for sharing state between InputPrompt and InkREPL
// 自动补全上下文 - 在 InputPrompt 和 InkREPL 之间共享状态
// ============================================================================

/**
 * Context value type (extends UseAutocompleteReturn)
 * 上下文值类型（扩展 UseAutocompleteReturn）
 */
interface AutocompleteContextValue extends UseAutocompleteReturn {}

const AutocompleteContext = createContext<AutocompleteContextValue | null>(null);

/**
 * AutocompleteContextProvider - provides autocomplete state to children
 * AutocompleteContextProvider - 为子组件提供自动补全状态
 *
 * Usage: Wrap your app or component tree with this provider
 * 用法: 用此 provider 包装你的应用或组件树
 */
export function AutocompleteContextProvider({
  children,
  cwd,
  gitRoot,
}: {
  children: ReactNode;
  cwd?: string;
  gitRoot?: string;
}): React.ReactElement {
  const autocomplete = useAutocomplete({ cwd, gitRoot, enabled: true });

  return (
    <AutocompleteContext.Provider value={autocomplete}>
      {children}
    </AutocompleteContext.Provider>
  );
}

/**
 * useAutocompleteContext - access autocomplete context from parent component
 * useAutocompleteContext - 从父组件访问自动补全上下文
 *
 * Use this in InkREPL to render SuggestionsDisplay outside InputPrompt
 * 在 InkREPL 中使用此 hook 在 InputPrompt 外部渲染 SuggestionsDisplay
 */
export function useAutocompleteContext(): AutocompleteContextValue | null {
  return useContext(AutocompleteContext);
}

/**
 * Options for useAutocomplete hook
 * useAutocomplete hook 的选项
 */
export interface UseAutocompleteOptions {
  /** Working directory for file completion - 文件补全的工作目录 */
  cwd?: string;
  /** Git root for skill discovery - 技能发现的 Git 根目录 */
  gitRoot?: string;
  /** Whether autocomplete is enabled - 是否启用自动补全 */
  enabled?: boolean;
}

/**
 * Selected completion with type info for replacement logic
 * 带类型信息的选中补全，用于替换逻辑
 */
export interface SelectedCompletion {
  /** Replacement text - 替换文本 */
  text: string;
  /** Completion type - 补全类型 */
  type: 'command' | 'argument' | 'file' | 'skill';
}

/**
 * Return type for useAutocomplete hook
 * useAutocomplete hook 的返回类型
 */
export interface UseAutocompleteReturn {
  /** Current autocomplete state - 当前自动补全状态 */
  state: AutocompleteState;
  /** Suggestions for display (converted to Suggestion format) - 用于显示的建议（转换为 Suggestion 格式） */
  suggestions: Suggestion[];
  /** Handle input change - 处理输入变化 */
  handleInput: (text: string, cursorPos: number) => void;
  /** Handle Tab key - returns selected completion or null - 处理 Tab 键 - 返回选中的补全或 null */
  handleTab: () => SelectedCompletion | null;
  /** Handle Enter key when dropdown visible - returns selected completion or null - 处理下拉框可见时的 Enter 键 - 返回选中的补全或 null */
  handleEnter: () => SelectedCompletion | null;
  /** Handle up arrow - 处理上箭头 */
  handleUp: () => void;
  /** Handle down arrow - 处理下箭头 */
  handleDown: () => void;
  /** Handle Escape key - 处理 Escape 键 */
  handleEscape: () => void;
  /** Cancel autocomplete - 取消自动补全 */
  cancel: () => void;
  /** Get provider instance (for advanced usage) - 获取提供者实例（高级用法） */
  getProvider: () => AutocompleteProvider;
}

/**
 * Convert Completion to Suggestion format
 * 将 Completion 转换为 Suggestion 格式
 */
function completionToSuggestion(completion: Completion, index: number): Suggestion {
  const typeMap: Record<string, Suggestion["type"]> = {
    command: "command",
    file: "file",
    argument: "argument",
    skill: "skill",
  };

  const iconMap: Record<string, string> = {
    command: "⚡",
    file: "📄",
    argument: "•",
    skill: "★",
  };

  return {
    id: `autocomplete-${index}`,
    text: completion.text,
    displayText: completion.display,
    description: completion.description,
    type: typeMap[completion.type] ?? "command",
    icon: iconMap[completion.type] ?? ">",
  };
}

/**
 * useAutocomplete hook
 *
 * Integrates autocomplete provider with React component state.
 * 将自动补全提供者与 React 组件状态集成。
 *
 * If called without options and within AutocompleteContextProvider, uses context.
 * Otherwise creates a new provider instance.
 * 如果不带选项调用且在 AutocompleteContextProvider 内，使用 context。
 * 否则创建新的 provider 实例。
 */
export function useAutocomplete(
  options: UseAutocompleteOptions = {}
): UseAutocompleteReturn {
  // Try to use context if available and no explicit options
  const context = useContext(AutocompleteContext);
  if (context && !options.cwd && !options.gitRoot) {
    return context;
  }

  // Otherwise create local instance
  return useAutocompleteImpl(options);
}

/**
 * Internal implementation - creates and manages autocomplete provider
 * 内部实现 - 创建和管理自动补全提供者
 */
function useAutocompleteImpl(
  options: UseAutocompleteOptions
): UseAutocompleteReturn {
  const { cwd, gitRoot, enabled = true } = options;

  // Create provider instance (memoized)
  // 创建提供者实例（记忆化）
  const provider = useMemo(() => {
    return createAutocompleteProvider({
      cwd,
      gitRoot,
      debounceDelay: 100,
      minTriggerChars: 1,
      maxCompletions: 8,
    });
  }, []); // Don't recreate on cwd/gitRoot change - use updateOptions instead

  // Update provider options when they change
  // 当选项变化时更新提供者
  useEffect(() => {
    provider.updateOptions({ cwd, gitRoot });
  }, [provider, cwd, gitRoot]);

  // Local state for UI
  // UI 的本地状态
  const [state, setState] = useState<AutocompleteState>({
    visible: false,
    selectedIndex: 0,
    completions: [],
    loading: false,
  });

  // Subscribe to provider state changes
  // 订阅提供者状态变化
  useEffect(() => {
    const unsubscribe = provider.subscribe((newState) => {
      setState(newState);
    });

    return unsubscribe;
  }, [provider]);

  // Convert completions to suggestions for display
  // 将补全转换为建议用于显示
  const suggestions = useMemo(() => {
    return state.completions.map((c, i) => completionToSuggestion(c, i));
  }, [state.completions]);

  // Handle input change
  // 处理输入变化
  const handleInput = useCallback(
    (text: string, cursorPos: number) => {
      if (!enabled) {
        provider.cancel();
        return;
      }
      provider.handleInput(text, cursorPos);
    },
    [provider, enabled]
  );

  // Handle Tab key - returns completion with type
  // 处理 Tab 键 - 返回带类型的补全
  const handleTab = useCallback((): SelectedCompletion | null => {
    if (!state.visible) return null;
    return provider.acceptCompletionWithType();
  }, [provider, state.visible]);

  // Handle Enter key when dropdown visible - returns completion with type
  // 处理下拉框可见时的 Enter 键 - 返回带类型的补全
  const handleEnter = useCallback((): SelectedCompletion | null => {
    if (!state.visible) return null;
    return provider.acceptCompletionWithType();
  }, [provider, state.visible]);

  // Handle up arrow
  // 处理上箭头
  const handleUp = useCallback(() => {
    if (!state.visible) return;
    provider.selectPrevious();
  }, [provider, state.visible]);

  // Handle down arrow
  // 处理下箭头
  const handleDown = useCallback(() => {
    if (!state.visible) return;
    provider.selectNext();
  }, [provider, state.visible]);

  // Handle Escape key
  // 处理 Escape 键
  const handleEscape = useCallback(() => {
    if (state.visible) {
      provider.cancel();
    }
  }, [provider, state.visible]);

  // Cancel autocomplete
  // 取消自动补全
  const cancel = useCallback(() => {
    provider.cancel();
  }, [provider]);

  // Get provider instance
  // 获取提供者实例
  const getProvider = useCallback(() => provider, [provider]);

  return {
    state,
    suggestions,
    handleInput,
    handleTab,
    handleEnter,
    handleUp,
    handleDown,
    handleEscape,
    cancel,
    getProvider,
  };
}
