/**
 * KeypressContext
 *
 * Provides a priority-based keyboard manager backed by KodaX's local terminal
 * runtime. This keeps keyboard input ownership below the shell layer instead of
 * depending on Ink's `useInput`.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { useStdout, useTerminalInput } from "../tui.js";
import { KeypressParser } from "../utils/keypress-parser.js";
import {
  KeypressHandlerPriority,
  type KeyInfo,
  type KeypressHandler,
} from "../types.js";

const ESC_TIMEOUT = 50;

export interface KeypressManager {
  register: (priority: number, handler: KeypressHandler) => () => void;
  dispatch: (event: KeyInfo) => boolean;
  size: () => number;
}

export function createKeypressManager(): KeypressManager {
  const handlers = new Map<number, KeypressHandler[]>();
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

      handlers.get(priority)!.push(handler);
      sortedPrioritiesCache = null;

      return () => {
        const priorityHandlers = handlers.get(priority);
        if (!priorityHandlers) {
          return;
        }

        const index = priorityHandlers.indexOf(handler);
        if (index >= 0) {
          priorityHandlers.splice(index, 1);
        }

        if (priorityHandlers.length === 0) {
          handlers.delete(priority);
        }

        sortedPrioritiesCache = null;
      };
    },

    dispatch(event: KeyInfo): boolean {
      const sortedPriorities = getSortedPriorities();

      for (const priority of sortedPriorities) {
        const priorityHandlers = handlers.get(priority);
        if (!priorityHandlers) {
          continue;
        }

        for (let index = priorityHandlers.length - 1; index >= 0; index -= 1) {
          const handler = priorityHandlers[index];
          if (!handler) {
            continue;
          }

          if (handler(event) === true) {
            return true;
          }
        }
      }

      return false;
    },

    size(): number {
      let count = 0;
      for (const priorityHandlers of handlers.values()) {
        count += priorityHandlers.length;
      }
      return count;
    },
  };
}

const KeypressManagerContext = createContext<KeypressManager | null>(null);

export interface KeypressProviderProps {
  children: ReactNode;
  enabled?: boolean;
}

export function KeypressProvider({
  children,
  enabled = true,
}: KeypressProviderProps): React.ReactElement {
  const { stdout } = useStdout();
  const managerRef = useRef<KeypressManager>(createKeypressManager());
  const parserRef = useRef<KeypressParser | null>(null);
  const escTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const dispatch = useCallback((event: KeyInfo) => {
    if (!enabled) {
      return;
    }
    managerRef.current.dispatch(event);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    stdout?.write?.("\x1b[?2004h");

    const parser = new KeypressParser();
    parserRef.current = parser;
    const unsubscribeParser = parser.onKeypress(dispatch);

    return () => {
      if (escTimeoutRef.current) {
        clearTimeout(escTimeoutRef.current);
        escTimeoutRef.current = null;
      }

      unsubscribeParser();
      parserRef.current = null;

      try {
        stdout?.write?.("\x1b[?2004l");
      } catch {
        // Ignore terminals that reject bracketed paste cleanup.
      }
    };
  }, [dispatch, enabled, stdout]);

  useTerminalInput((data) => {
    if (!enabled) {
      return;
    }

    if (escTimeoutRef.current) {
      clearTimeout(escTimeoutRef.current);
    }

    parserRef.current?.feed(data);

    if (data.length !== 0) {
      escTimeoutRef.current = setTimeout(() => {
        parserRef.current?.feed("", true);
      }, ESC_TIMEOUT);
    }
  }, {
    isActive: enabled,
    rawMode: true,
  });

  return React.createElement(
    KeypressManagerContext.Provider,
    { value: managerRef.current },
    children,
  );
}

export function useKeypressManager(): KeypressManager {
  const context = useContext(KeypressManagerContext);
  if (!context) {
    throw new Error("useKeypressManager must be used within a KeypressProvider");
  }
  return context;
}

export interface UseKeypressOptions {
  isActive?: boolean;
  priority?: number | boolean;
}

export function useKeypress(
  priorityOrHandler: number | boolean | KeypressHandler,
  handlerOrOptions?: KeypressHandler | UseKeypressOptions,
  deps: React.DependencyList = [],
): void {
  const manager = useKeypressManager();
  const isGeminiStyle = typeof priorityOrHandler === "function";

  let handler: KeypressHandler;
  let actualPriority: number;
  let isActive: boolean;

  if (isGeminiStyle) {
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
    actualPriority =
      typeof priorityOrHandler === "boolean"
        ? priorityOrHandler
          ? KeypressHandlerPriority.High
          : KeypressHandlerPriority.Normal
        : priorityOrHandler;
    handler = handlerOrOptions as KeypressHandler;
    isActive = true;
  }

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const unregister = manager.register(actualPriority, handler);
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager, actualPriority, isActive, ...(isGeminiStyle ? [] : deps)]);
}

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

export { KeypressManagerContext };
