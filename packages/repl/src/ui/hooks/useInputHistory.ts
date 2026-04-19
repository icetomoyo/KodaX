/**
 * useInputHistory - Input history management Hook - 输入历史管理 Hook
 *
 * Manages command history, supports up/down arrow navigation.
 *
 * Module-scoped history store: the entries array lives at module scope so it
 * survives PromptComposer unmount+remount (triggered e.g. by Ctrl+O transcript
 * toggle in InkREPL). historyIndex / tempInput remain component-scoped so the
 * nav cursor resets on remount, matching pre-existing user-visible behavior.
 *
 * Design: docs/features/v0.7.21.md FEATURE_077.
 */

import { useCallback, useRef } from "react";
import type { HistoryEntry } from "../types.js";

// Module-scoped history: survives component unmount/remount within the REPL
// process. See FEATURE_077.
const historyStore: HistoryEntry[] = [];

/** Test-only helper — resets the module-scoped history store between tests. */
export function __resetInputHistoryForTesting(): void {
  historyStore.length = 0;
}

export interface UseInputHistoryOptions {
  maxSize?: number;
  onSave?: (entry: HistoryEntry) => void;
}

export interface UseInputHistoryReturn {
  add: (text: string) => void;
  navigateUp: () => string | null;
  navigateDown: () => string | null;
  reset: () => void;
  saveTempInput: (text: string) => void;
}

export function useInputHistory(options: UseInputHistoryOptions = {}): UseInputHistoryReturn {
  const { maxSize = 1000, onSave } = options;
  const historyIndexRef = useRef<number>(-1);
  const tempInputRef = useRef<string>("");

  const add = useCallback(
    (text: string) => {
      if (!text.trim()) return;

      const lastEntry = historyStore[historyStore.length - 1];
      if (lastEntry?.text !== text) {
        const entry: HistoryEntry = { text, timestamp: Date.now() };
        historyStore.push(entry);
        if (historyStore.length > maxSize) {
          historyStore.splice(0, historyStore.length - maxSize);
        }
        onSave?.(entry);
      }

      historyIndexRef.current = -1;
      tempInputRef.current = "";
    },
    [maxSize, onSave]
  );

  const navigateUp = useCallback((): string | null => {
    if (historyStore.length === 0) return null;

    if (historyIndexRef.current === -1) {
      historyIndexRef.current = historyStore.length - 1;
      return historyStore[historyIndexRef.current]?.text ?? null;
    }

    if (historyIndexRef.current > 0) {
      historyIndexRef.current--;
      return historyStore[historyIndexRef.current]?.text ?? null;
    }

    return null;
  }, []);

  const navigateDown = useCallback((): string | null => {
    if (historyIndexRef.current === -1) return null;

    if (historyIndexRef.current < historyStore.length - 1) {
      historyIndexRef.current++;
      return historyStore[historyIndexRef.current]?.text ?? null;
    }

    // Reached the bottom: return to the user's saved draft (may be empty
    // string, but never null — matches Gemini CLI / OpenCode convention).
    historyIndexRef.current = -1;
    return tempInputRef.current;
  }, []);

  const reset = useCallback(() => {
    historyIndexRef.current = -1;
    tempInputRef.current = "";
  }, []);

  const saveTempInput = useCallback((text: string) => {
    if (historyIndexRef.current === -1) {
      tempInputRef.current = text;
    }
  }, []);

  return { add, navigateUp, navigateDown, reset, saveTempInput };
}
