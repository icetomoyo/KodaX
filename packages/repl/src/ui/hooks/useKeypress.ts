/**
 * useKeypress - Keyboard event handling Hook
 *
 * Wraps the local TUI facade's useInput helper and normalizes key metadata.
 */

import { useInput, useApp, type Key } from "../tui.js";
import { useCallback, useRef } from "react";
import type { KeyInfo } from "../types.js";

export interface UseKeypressOptions {
  onKey?: (key: KeyInfo) => boolean;
  onEsc?: () => void;
  onCtrlC?: () => void;
  enabled?: boolean;
}

const DOUBLE_ESC_INTERVAL_MS = 500;

function keyToKeyInfo(char: string, key: Key): KeyInfo {
  let name = "";
  let insertable = false;

  if (key.upArrow) name = "up";
  else if (key.downArrow) name = "down";
  else if (key.leftArrow) name = "left";
  else if (key.rightArrow) name = "right";
  else if (key.return) name = "return";
  else if (key.escape) name = "escape";
  else if (key.backspace) name = "backspace";
  else if (key.delete) name = "delete";
  else if (key.tab) name = "tab";
  else {
    name = char;
    insertable = char.length === 1 && char.charCodeAt(0) >= 32 && !key.ctrl && !key.meta;
  }

  return {
    name,
    sequence: char,
    ctrl: key.ctrl ?? false,
    meta: key.meta ?? false,
    shift: key.shift ?? false,
    insertable,
  };
}

export function useKeypress(options: UseKeypressOptions = {}) {
  const { onKey, onEsc, onCtrlC, enabled = true } = options;
  const lastEscTimeRef = useRef<number>(0);
  const { exit } = useApp();

  const handleInput = useCallback(
    (char: string, key: Key) => {
      if (!enabled) {
        return;
      }

      const keyInfo = keyToKeyInfo(char, key);

      if (key.escape) {
        const now = Date.now();
        const isDoubleEsc = now - lastEscTimeRef.current < DOUBLE_ESC_INTERVAL_MS;
        lastEscTimeRef.current = now;

        if (isDoubleEsc) {
          keyInfo.name = "escape-escape";
        }

        onEsc?.();
        onKey?.(keyInfo);
        return;
      }

      if (key.ctrl && char === "c") {
        onCtrlC?.();
        onKey?.(keyInfo);
        return;
      }

      if (key.ctrl && char === "d") {
        exit();
        return;
      }

      onKey?.(keyInfo);
    },
    [enabled, exit, onCtrlC, onEsc, onKey],
  );

  useInput(handleInput, { isActive: enabled });

  return {
    lastEscTime: lastEscTimeRef.current,
  };
}

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
