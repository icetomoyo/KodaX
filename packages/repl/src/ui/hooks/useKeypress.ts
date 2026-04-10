/**
 * useKeypress - Keyboard event handling Hook
 *
 * Wraps KodaX's KeypressContext so UI keyboard handling stays on the local
 * input pipeline instead of depending on Ink's useInput.
 */

import { useApp } from "../tui.js";
import { useCallback, useRef } from "react";
import { useKeypress as useContextKeypress } from "../contexts/KeypressContext.js";
import type { KeyInfo } from "../types.js";

export interface UseKeypressOptions {
  onKey?: (key: KeyInfo) => boolean;
  onEsc?: () => void;
  onCtrlC?: () => void;
  enabled?: boolean;
}

const DOUBLE_ESC_INTERVAL_MS = 500;

export function useKeypress(options: UseKeypressOptions = {}) {
  const { onKey, onEsc, onCtrlC, enabled = true } = options;
  const lastEscTimeRef = useRef<number>(0);
  const { exit } = useApp();

  const handleInput = useCallback(
    (keyInfo: KeyInfo) => {
      if (!enabled) {
        return false;
      }

      if (keyInfo.name === "escape") {
        const now = Date.now();
        const isDoubleEsc = now - lastEscTimeRef.current < DOUBLE_ESC_INTERVAL_MS;
        lastEscTimeRef.current = now;

        if (isDoubleEsc) {
          keyInfo.name = "escape-escape";
        }

        onEsc?.();
        onKey?.(keyInfo);
        return true;
      }

      if (keyInfo.ctrl && keyInfo.name === "c") {
        onCtrlC?.();
        onKey?.(keyInfo);
        return true;
      }

      if (keyInfo.ctrl && keyInfo.name === "d") {
        exit();
        return true;
      }

      onKey?.(keyInfo);
      return false;
    },
    [enabled, exit, onCtrlC, onEsc, onKey],
  );

  useContextKeypress(handleInput, {
    isActive: enabled,
  });

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
