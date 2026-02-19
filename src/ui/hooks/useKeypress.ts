/**
 * useKeypress - 键盘事件处理 Hook
 *
 * 封装 Ink 的 useInput，提供更详细的按键信息
 */

import { useInput, useApp, type Key } from "ink";
import { useCallback, useRef } from "react";
import type { KeyInfo } from "../types.js";

export interface UseKeypressOptions {
  onKey?: (key: KeyInfo) => boolean; // 返回 true 表示已处理
  onEsc?: () => void;
  onCtrlC?: () => void;
  enabled?: boolean;
}

/**
 * 双击 Esc 检测配置
 */
const DOUBLE_ESC_INTERVAL_MS = 500;

/**
 * 将 Ink Key 转换为 KeyInfo
 */
function keyToKeyInfo(char: string, key: Key): KeyInfo {
  let name = "";
  if (key.upArrow) name = "up";
  else if (key.downArrow) name = "down";
  else if (key.leftArrow) name = "left";
  else if (key.rightArrow) name = "right";
  else if (key.return) name = "return";
  else if (key.escape) name = "escape";
  else if (key.backspace) name = "backspace";
  else if (key.delete) name = "delete";
  else if (key.tab) name = "tab";
  else name = char;

  return {
    name,
    sequence: char,
    ctrl: key.ctrl ?? false,
    meta: key.meta ?? false,
    shift: key.shift ?? false,
  };
}

export function useKeypress(options: UseKeypressOptions = {}) {
  const { onKey, onEsc, onCtrlC, enabled = true } = options;
  const lastEscTimeRef = useRef<number>(0);
  const { exit } = useApp();

  const handleInput = useCallback(
    (char: string, key: Key) => {
      if (!enabled) return;

      const keyInfo = keyToKeyInfo(char, key);

      // 特殊处理 Esc
      if (key.escape) {
        const now = Date.now();
        const isDoubleEsc = now - lastEscTimeRef.current < DOUBLE_ESC_INTERVAL_MS;
        lastEscTimeRef.current = now;

        if (isDoubleEsc) {
          // 双击 Esc - 编辑上一条消息
          keyInfo.name = "escape-escape";
        }

        onEsc?.();
        onKey?.(keyInfo);
        return;
      }

      // 特殊处理 Ctrl+C
      if (key.ctrl && char === "c") {
        onCtrlC?.();
        onKey?.(keyInfo);
        return;
      }

      // 特殊处理 Ctrl+D (退出)
      if (key.ctrl && char === "d") {
        exit();
        return;
      }

      // 调用通用处理
      onKey?.(keyInfo);
    },
    [enabled, onKey, onEsc, onCtrlC, exit]
  );

  useInput(handleInput, { isActive: enabled });

  return {
    lastEscTime: lastEscTimeRef.current,
  };
}

/**
 * 创建 key matcher 工具函数
 */
export function createKeyMatcher(key: KeyInfo) {
  return {
    is: (name: string, modifiers?: { ctrl?: boolean; shift?: boolean; meta?: boolean }) => {
      if (key.name !== name) return false;
      if (modifiers?.ctrl !== undefined && key.ctrl !== modifiers.ctrl) return false;
      if (modifiers?.shift !== undefined && key.shift !== modifiers.shift) return false;
      if (modifiers?.meta !== undefined && key.meta !== modifiers.meta) return false;
      return true;
    },
    isCtrl: (name: string) => key.ctrl && key.name === name,
    isShift: (name: string) => key.shift && key.name === name,
    isArrow: () => ["up", "down", "left", "right"].includes(key.name),
    isChar: () => key.sequence?.length === 1 && !key.ctrl && !key.meta,
    getChar: () => (key.sequence?.length === 1 ? key.sequence : null),
  };
}
