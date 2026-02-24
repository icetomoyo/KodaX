/**
 * KeypressContext - Priority-based Keyboard Event Handling
 *
 * 参考 Gemini CLI 的 KeypressContext 架构实现。
 * 使用优先级系统允许不同组件处理相同的按键。
 *
 * 关键改进：
 * - 使用自定义 KeypressParser 替代 Ink 的 useInput
 * - 正确处理 Backspace/Delete 键混淆问题
 * - 添加 insertable 属性支持
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { useStdin } from "ink";
import { KeypressParser } from "../utils/keypress-parser.js";
import {
  KeypressHandlerPriority,
  type KeyInfo,
  type KeypressHandler,
} from "../types.js";

// === Constants ===

/** ESC 序列超时时间（毫秒） */
const ESC_TIMEOUT = 50;

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
  // 缓存排序后的优先级
  let sortedPrioritiesCache: number[] | null = null;

  const getSortedPriorities = (): number[] => {
    if (sortedPrioritiesCache === null) {
      sortedPrioritiesCache = [...handlers.keys()].sort((a, b) => b - a);
    }
    return sortedPrioritiesCache;
  };

  return {
    register(priority: number, handler: KeypressHandler): () => void {
      if (!handlers.has(priority)) {
        handlers.set(priority, []);
      }
      const priorityHandlers = handlers.get(priority)!;
      priorityHandlers.push(handler);

      // 使缓存失效
      sortedPrioritiesCache = null;

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
        // 使缓存失效
        sortedPrioritiesCache = null;
      };
    },

    dispatch(event: KeyInfo): boolean {
      // 按优先级从高到低遍历
      const sortedPriorities = getSortedPriorities();

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
 * 使用自定义 KeypressParser 替代 Ink 的 useInput，解决 Backspace/Delete 混淆问题。
 */
export function KeypressProvider({
  children,
  enabled = true,
}: KeypressProviderProps): React.ReactElement {
  const { stdin, setRawMode } = useStdin();
  const managerRef = useRef<KeypressManager>(createKeypressManager());

  // 分发事件的回调
  const dispatch = useCallback(
    (event: KeyInfo) => {
      if (!enabled) return;
      managerRef.current.dispatch(event);
    },
    [enabled]
  );

  // 设置 stdin 监听
  useEffect(() => {
    if (!stdin || !enabled) {
      return;
    }

    // 记录原始模式状态
    const wasRaw = stdin.isRaw;

    // 启用原始模式
    if (wasRaw === false) {
      setRawMode(true);
    }

    // 创建解析器
    const parser = new KeypressParser();

    // 注册处理器
    const unsubscribeParser = parser.onKeypress(dispatch);

    // ESC 序列超时定时器
    let timeoutId: NodeJS.Timeout | null = null;

    // 监听 stdin 数据
    const onData = (data: Buffer | string) => {
      // 清除之前的超时
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      // 喂给解析器
      parser.feed(data);

      // 设置 ESC 序列超时
      if (data.length !== 0) {
        timeoutId = setTimeout(() => {
          // 发送空数据触发超时处理（flush=true 表示刷新不完整的序列）
          parser.feed("", true);
        }, ESC_TIMEOUT);
      }
    };

    stdin.on("data", onData);

    // 清理
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      stdin.off("data", onData);
      unsubscribeParser();

      // 恢复原始模式
      if (wasRaw === false) {
        try {
          setRawMode(false);
        } catch {
          // 忽略错误
        }
      }
    };
  }, [stdin, setRawMode, enabled, dispatch]);

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
 * useKeypress 选项接口
 * 参考 Gemini CLI 的 useKeypress 签名
 */
export interface UseKeypressOptions {
  /** 是否激活（订阅键盘事件） */
  isActive?: boolean;
  /** 优先级（可选，默认 Normal） */
  priority?: number | boolean;
}

/**
 * 注册键盘事件处理器
 *
 * 支持两种调用模式：
 *
 * 1. KodaX 原有模式（向后兼容）：
 *    useKeypress(priority, handler, deps)
 *
 * 2. Gemini CLI 风格（推荐用于条件订阅）：
 *    useKeypress(handler, { isActive: boolean, priority?: number })
 *
 * @param priorityOrHandler 优先级或处理函数
 * @param handlerOrOptions 处理函数或选项对象
 * @param deps 依赖数组（仅用于 KodaX 模式）
 */
export function useKeypress(
  priorityOrHandler: number | boolean | KeypressHandler,
  handlerOrOptions?: KeypressHandler | UseKeypressOptions,
  deps: React.DependencyList = []
): void {
  const manager = useKeypressManager();

  // 检测调用模式
  const isGeminiStyle = typeof priorityOrHandler === "function";

  let handler: KeypressHandler;
  let actualPriority: number;
  let isActive: boolean;

  if (isGeminiStyle) {
    // Gemini CLI 风格：useKeypress(handler, { isActive, priority? })
    handler = priorityOrHandler as KeypressHandler;
    const options = (handlerOrOptions as UseKeypressOptions) ?? {};
    isActive = options.isActive ?? true;
    const priority = options.priority;
    actualPriority =
      typeof priority === "boolean"
        ? priority
          ? KeypressHandlerPriority.High
          : KeypressHandlerPriority.Normal
        : (priority ?? KeypressHandlerPriority.Normal);
  } else {
    // KodaX 原有模式：useKeypress(priority, handler, deps)
    actualPriority =
      typeof priorityOrHandler === "boolean"
        ? priorityOrHandler
          ? KeypressHandlerPriority.High
          : KeypressHandlerPriority.Normal
        : priorityOrHandler;
    handler = handlerOrOptions as KeypressHandler;
    isActive = true; // 原有模式总是激活
  }

  useEffect(() => {
    // 如果不激活，不订阅
    if (!isActive) {
      return;
    }

    const unregister = manager.register(actualPriority, handler);
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager, actualPriority, isActive, ...(isGeminiStyle ? [] : deps)]);
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
    if (pattern.insertable !== undefined && event.insertable !== pattern.insertable) return false;
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
  isInsertable: (event: KeyInfo) =>
    event.insertable === true && !event.ctrl && !event.meta,
} as const;

// === Exports ===

export { KeypressManagerContext };
