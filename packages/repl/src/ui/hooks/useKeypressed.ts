/**
 * useKeypressed - Custom keyboard input Hook - 自定义键盘输入 Hook
 *
 * Replaces Ink's useInput, resolves Backspace/Delete confusion - 替代 Ink 的 useInput，解决 Backspace/Delete 混淆问题
 * Uses custom KeypressParser for proper key parsing - 使用自己的 KeypressParser 进行正确的按键解析
 *
 * Reference: Gemini CLI KeypressContext - 参考: Gemini CLI KeypressContext
 */

import { useEffect, useCallback, useRef } from "react";
import { useStdin } from "ink";
import { KeypressParser, parseKeypress } from "../utils/keypress-parser.js";
import type { KeyInfo } from "../types.js";

export type KeypressHandler = (key: KeyInfo) => boolean | void;

export interface UseKeypressedOptions {
  /**
   * Whether the hook is active - 是否激活
   * @default true
   */
  isActive?: boolean;

  /**
   * Whether to enable raw mode - 是否启用原始模式
   * @default true
   */
  rawMode?: boolean;
}

/**
 * useKeypressed Hook
 *
 * Provides correct terminal keyboard input handling, resolves Backspace/Delete key confusion - 提供正确的终端键盘输入处理，解决 Backspace/Delete 键混淆问题
 *
 * @example
 * ```tsx
 * useKeypressed((key) => {
 *   if (key.name === 'backspace') {
 *     handleBackspace();
 *     return true; // Stop propagation - 阻止继续传播
 *   }
 *   if (key.name === 'delete') {
 *     handleDelete();
 *     return true;
 *   }
 * }, { isActive: focus });
 * ```
 */
export function useKeypressed(
  handler: KeypressHandler,
  options: UseKeypressedOptions = {}
): void {
  const { isActive = true, rawMode = true } = options;
  const stdin = useStdin();
  const handlerRef = useRef(handler);
  const parserRef = useRef<KeypressParser | null>(null);

  // Update handler ref - 更新 handler ref
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!isActive || !stdin.stdin) {
      return;
    }

    const stdinStream = stdin.stdin;

    // Enable raw mode - 启用原始模式
    if (rawMode && stdinStream.isTTY) {
      stdinStream.setRawMode(true);
    }

    // Create parser - 创建解析器
    const parser = new KeypressParser();
    parserRef.current = parser;

    // Register handler - 注册处理器
    const unsubscribe = parser.onKeypress((key) => {
      handlerRef.current(key);
    });

    // Listen to stdin data - 监听 stdin 数据
    const onData = (data: Buffer) => {
      parser.feed(data);
    };

    stdinStream.on("data", onData);

    return () => {
      stdinStream.off("data", onData);
      unsubscribe();

      // Restore terminal mode - 恢复终端模式
      if (rawMode && stdinStream.isTTY) {
        try {
          stdinStream.setRawMode(false);
        } catch {
          // Ignore error - 忽略错误
        }
      }

      parserRef.current = null;
    };
  }, [isActive, rawMode, stdin.stdin]);
}

/**
 * useKeypressedMulti Hook
 *
 * Supports multiple handlers, executes in order until one returns true - 支持多个处理器，按添加顺序执行，直到某个处理器返回 true
 *
 * @example
 * ```tsx
 * const { addHandler, removeHandler } = useKeypressedMulti({ isActive: focus });
 *
 * useEffect(() => {
 *   const handler = (key) => {
 *     if (key.name === 'escape') {
 *       handleEscape();
 *       return true;
 *     }
 *   };
 *   addHandler(handler);
 *   return () => removeHandler(handler);
 * }, []);
 * ```
 */
export function useKeypressedMulti(options: UseKeypressedOptions = {}) {
  const { isActive = true, rawMode = true } = options;
  const stdin = useStdin();
  const handlersRef = useRef<KeypressHandler[]>([]);
  const parserRef = useRef<KeypressParser | null>(null);

  const addHandler = useCallback((handler: KeypressHandler) => {
    handlersRef.current.push(handler);
  }, []);

  const removeHandler = useCallback((handler: KeypressHandler) => {
    const index = handlersRef.current.indexOf(handler);
    if (index >= 0) {
      handlersRef.current.splice(index, 1);
    }
  }, []);

  useEffect(() => {
    if (!isActive || !stdin.stdin) {
      return;
    }

    const stdinStream = stdin.stdin;

    // Enable raw mode - 启用原始模式
    if (rawMode && stdinStream.isTTY) {
      stdinStream.setRawMode(true);
    }

    // Create parser - 创建解析器
    const parser = new KeypressParser();
    parserRef.current = parser;

    // Register handler - 注册处理器
    const unsubscribe = parser.onKeypress((key) => {
      // Execute handlers in order until one returns true - 按顺序执行处理器，直到某个返回 true
      for (const handler of handlersRef.current) {
        const result = handler(key);
        if (result === true) {
          break;
        }
      }
    });

    // Listen to stdin data - 监听 stdin 数据
    const onData = (data: Buffer) => {
      parser.feed(data);
    };

    stdinStream.on("data", onData);

    return () => {
      stdinStream.off("data", onData);
      unsubscribe();

      // Restore terminal mode - 恢复终端模式
      if (rawMode && stdinStream.isTTY) {
        try {
          stdinStream.setRawMode(false);
        } catch {
          // Ignore error - 忽略错误
        }
      }

      parserRef.current = null;
    };
  }, [isActive, rawMode, stdin.stdin]);

  return {
    addHandler,
    removeHandler,
  };
}

/**
 * Parse a single keypress sequence directly - 直接解析单个按键序列
 *
 * For testing or manual handling - 用于测试或手动处理
 */
export { parseKeypress };

/**
 * Check if key matches specified conditions - 检查按键是否匹配指定条件
 */
export function keyMatches(key: KeyInfo, match: Partial<KeyInfo>): boolean {
  if (match.name !== undefined && key.name !== match.name) return false;
  if (match.ctrl !== undefined && key.ctrl !== match.ctrl) return false;
  if (match.meta !== undefined && key.meta !== match.meta) return false;
  if (match.shift !== undefined && key.shift !== match.shift) return false;
  if (match.sequence !== undefined && key.sequence !== match.sequence) return false;
  return true;
}

/**
 * Create a key matcher - 创建按键匹配器
 *
 * @example
 * ```tsx
 * const isBackspace = createKeyMatcher({ name: 'backspace' });
 * const isCtrlC = createKeyMatcher({ name: 'c', ctrl: true });
 *
 * useKeypressed((key) => {
 *   if (isBackspace(key)) {
 *     handleBackspace();
 *     return true;
 *   }
 *   if (isCtrlC(key)) {
 *     handleCtrlC();
 *     return true;
 *   }
 * });
 * ```
 */
export function createKeyMatcher(match: Partial<KeyInfo>): (key: KeyInfo) => boolean {
  return (key: KeyInfo) => keyMatches(key, match);
}
