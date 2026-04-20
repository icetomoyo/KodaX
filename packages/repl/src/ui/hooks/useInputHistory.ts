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
 *
 * Issue 121 extension: each entry may carry a `pastedContents` snapshot so
 * recalled prompts containing `[Pasted text #N]` placeholders still expand
 * to their original content when resubmitted. The module-scoped store keeps
 * pasted content references alive across composer remounts within a session.
 */

import { useCallback, useRef } from "react";
import type { HistoryEntry } from "../types.js";
import type { PastedContent } from "../utils/paste-store.js";

// Module-scoped history: survives component unmount/remount within the REPL
// process. See FEATURE_077.
const historyStore: HistoryEntry[] = [];

/** Test-only helper — resets the module-scoped history store between tests. */
export function __resetInputHistoryForTesting(): void {
  historyStore.length = 0;
}

/** Test-only helper — snapshot the current history store. */
export function __snapshotInputHistoryForTesting(): HistoryEntry[] {
  return historyStore.map((e) => ({
    text: e.text,
    timestamp: e.timestamp,
    pastedContents: e.pastedContents ? [...e.pastedContents] : undefined,
  }));
}

export interface AddHistoryOptions {
  pastedContents?: PastedContent[];
}

export interface UseInputHistoryOptions {
  maxSize?: number;
  onSave?: (entry: HistoryEntry) => void;
}

export interface UseInputHistoryReturn {
  add: (text: string, options?: AddHistoryOptions) => void;
  navigateUp: () => HistoryEntry | null;
  navigateDown: () => HistoryEntry | null;
  reset: () => void;
  saveTempInput: (text: string) => void;
}

export function useInputHistory(options: UseInputHistoryOptions = {}): UseInputHistoryReturn {
  const { maxSize = 1000, onSave } = options;
  const historyIndexRef = useRef<number>(-1);
  const tempInputRef = useRef<string>("");

  const add = useCallback(
    (text: string, addOptions?: AddHistoryOptions) => {
      if (!text.trim()) return;

      const lastEntry = historyStore[historyStore.length - 1];
      if (lastEntry?.text !== text) {
        const entry: HistoryEntry = {
          text,
          timestamp: Date.now(),
          ...(addOptions?.pastedContents && addOptions.pastedContents.length > 0
            ? { pastedContents: [...addOptions.pastedContents] }
            : {}),
        };
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

  const navigateUp = useCallback((): HistoryEntry | null => {
    if (historyStore.length === 0) return null;

    if (historyIndexRef.current === -1) {
      historyIndexRef.current = historyStore.length - 1;
      return historyStore[historyIndexRef.current] ?? null;
    }

    if (historyIndexRef.current > 0) {
      historyIndexRef.current--;
      return historyStore[historyIndexRef.current] ?? null;
    }

    return null;
  }, []);

  const navigateDown = useCallback((): HistoryEntry | null => {
    if (historyIndexRef.current === -1) return null;

    if (historyIndexRef.current < historyStore.length - 1) {
      historyIndexRef.current++;
      return historyStore[historyIndexRef.current] ?? null;
    }

    // Reached the bottom: return to the user's saved draft (may be empty
    // string, but never null — matches Gemini CLI / OpenCode convention).
    historyIndexRef.current = -1;
    return { text: tempInputRef.current, timestamp: Date.now() };
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
