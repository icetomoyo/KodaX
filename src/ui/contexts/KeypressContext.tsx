/**
 * KeypressContext - Priority-based Keyboard Event Handling
 *
 * 参考 Gemini CLI 的 KeypressContext 架构实现。
 * 使用优先级系统允许不同组件处理相同的按键。
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { useInput } from "ink";
import {
  KeypressHandlerPriority,
  type KeyInfo,
  type KeypressHandler,
} from "../types.js";

// === Types ===

/**
 * 键盘事件管理器接口
 */
export interface KeypressManager {
  /**
   * 注册键盘事件处理器
   * @param priority 处理器优先级
   * @param handler 处理函数，返回 true 表示消费事件
   * @returns 注销函数
   */
  register: (priority: number, handler: KeypressHandler) => () => void;

  /**
   * 分发键盘事件到处理器
   * @param event 键盘事件
   * @returns 是否被消费
   */
  dispatch: (event: KeyInfo) => boolean;

  /**
   * 获取当前注册的处理器数量
   */
  size: () => number;
}

// === Keypress Manager Implementation ===

/**
 * 创建键盘事件管理器
 *
 * 使用 MultiMap 风格的优先级管理：
 * - 高优先级的处理器先执行
 * - 同优先级内后注册的先执行 (LIFO)
 * - 返回 true 的处理器会阻止后续处理器执行
 */
export function createKeypressManager(): KeypressManager {
  // 使用 Map 存储优先级 -> 处理器数组的映射
  const handlers = new Map<number, KeypressHandler[]>();

  return {
    register(priority: number, handler: KeypressHandler): () => void {
      if (!handlers.has(priority)) {
        handlers.set(priority, []);
      }
      const priorityHandlers = handlers.get(priority)!;
      priorityHandlers.push(handler);

      // 按 priority 降序排序（高优先级在前）
      const sortedKeys = [...handlers.keys()].sort((a, b) => b - a);
      const newMap = new Map<number, KeypressHandler[]>();
      for (const key of sortedKeys) {
        newMap.set(key, handlers.get(key)!);
      }
      handlers.clear();
      for (const [key, value] of newMap) {
        handlers.set(key, value);
      }

      return () => {
        const arr = handlers.get(priority);
        if (arr) {
          const index = arr.indexOf(handler);
          if (index !== -1) {
            arr.splice(index, 1);
          }
          if (arr.length === 0) {
            handlers.delete(priority);
          }
        }
      };
    },

    dispatch(event: KeyInfo): boolean {
      // 按优先级从高到低遍历
      const sortedPriorities = [...handlers.keys()].sort((a, b) => b - a);

      for (const priority of sortedPriorities) {
        const priorityHandlers = handlers.get(priority);
        if (!priorityHandlers) continue;

        // 同优先级内从后往前遍历 (LIFO)
        for (let i = priorityHandlers.length - 1; i >= 0; i--) {
          const handler = priorityHandlers[i];
          if (!handler) continue;

          const result = handler(event);
          if (result === true) {
            return true; // 事件被消费
          }
        }
      }

      return false; // 事件未被消费
    },

    size(): number {
      let count = 0;
      for (const arr of handlers.values()) {
        count += arr.length;
      }
      return count;
    },
  };
}

// === Context ===

const KeypressManagerContext = createContext<KeypressManager | null>(null);

// === Provider Props ===

export interface KeypressProviderProps {
  children: ReactNode;
  enabled?: boolean;
}

// === Provider ===

/**
 * KeypressProvider - 提供全局键盘事件管理
 *
 * 必须在 Ink 组件树内使用。
 */
export function KeypressProvider({
  children,
  enabled = true,
}: KeypressProviderProps): React.ReactElement {
  const managerRef = useRef<KeypressManager>(createKeypressManager());

  // 处理键盘输入
  const handleInput = useCallback(
    (char: string, key: KeyInfo) => {
      if (!enabled) return;

      const event: KeyInfo = {
        name: key.name || char,
        sequence: char,
        ctrl: key.ctrl || false,
        meta: key.meta || false,
        shift: key.shift || false,
      };

      managerRef.current.dispatch(event);
    },
    [enabled]
  );

  // 使用 Ink 的 useInput hook
  useInput(handleInput, { isActive: enabled });

  return React.createElement(
    KeypressManagerContext.Provider,
    { value: managerRef.current },
    children
  );
}

// === Hooks ===

/**
 * 获取键盘管理器
 */
export function useKeypressManager(): KeypressManager {
  const context = useContext(KeypressManagerContext);
  if (!context) {
    throw new Error("useKeypressManager must be used within a KeypressProvider");
  }
  return context;
}

/**
 * 注册键盘事件处理器
 *
 * @param priority 处理器优先级
 * @param handler 处理函数
 * @param deps 依赖数组
 */
export function useKeypress(
  priority: number,
  handler: KeypressHandler,
  deps: React.DependencyList = []
): void {
  const manager = useKeypressManager();

  useEffect(() => {
    const unregister = manager.register(priority, handler);
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager, priority, ...deps]);
}

/**
 * 创建按键匹配器
 *
 * 用于检查按键是否匹配特定模式
 */
export function createKeyMatcher(pattern: Partial<KeyInfo>): (event: KeyInfo) => boolean {
  return (event: KeyInfo): boolean => {
    if (pattern.name !== undefined && event.name !== pattern.name) return false;
    if (pattern.ctrl !== undefined && event.ctrl !== pattern.ctrl) return false;
    if (pattern.meta !== undefined && event.meta !== pattern.meta) return false;
    if (pattern.shift !== undefined && event.shift !== pattern.shift) return false;
    if (pattern.sequence !== undefined && event.sequence !== pattern.sequence) return false;
    return true;
  };
}

// === Common Key Matchers ===

export const KeyMatchers = {
  isEnter: createKeyMatcher({ name: "return" }),
  isEscape: createKeyMatcher({ name: "escape" }),
  isCtrlC: createKeyMatcher({ name: "c", ctrl: true }),
  isCtrlD: createKeyMatcher({ name: "d", ctrl: true }),
  isUp: createKeyMatcher({ name: "up" }),
  isDown: createKeyMatcher({ name: "down" }),
  isLeft: createKeyMatcher({ name: "left" }),
  isRight: createKeyMatcher({ name: "right" }),
  isBackspace: createKeyMatcher({ name: "backspace" }),
  isDelete: createKeyMatcher({ name: "delete" }),
  isTab: createKeyMatcher({ name: "tab" }),
  isShiftEnter: (event: KeyInfo) =>
    event.name === "return" && event.shift === true,
  isCtrlEnter: (event: KeyInfo) =>
    event.name === "return" && event.ctrl === true,
} as const;

// === Exports ===

export { KeypressManagerContext };
