/**
 * useKeypressed
 *
 * Legacy helper hooks for direct keyboard parsing. These now read input
 * through the local TUI runtime instead of touching stdin directly.
 */

import { useEffect, useCallback, useRef } from "react";
import { useTerminalInput } from "../tui.js";
import { KeypressParser, parseKeypress } from "../utils/keypress-parser.js";
import type { KeyInfo } from "../types.js";

export type KeypressHandler = (key: KeyInfo) => boolean | void;

export interface UseKeypressedOptions {
  isActive?: boolean;
  rawMode?: boolean;
}

export function useKeypressed(
  handler: KeypressHandler,
  options: UseKeypressedOptions = {},
): void {
  const { isActive = true, rawMode = true } = options;
  const handlerRef = useRef(handler);
  const parserRef = useRef<KeypressParser | null>(null);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const parser = new KeypressParser();
    parserRef.current = parser;
    const unsubscribe = parser.onKeypress((key) => {
      handlerRef.current(key);
    });

    return () => {
      unsubscribe();
      parserRef.current = null;
    };
  }, [isActive]);

  useTerminalInput((data) => {
    parserRef.current?.feed(data);
  }, {
    isActive,
    rawMode,
  });
}

export function useKeypressedMulti(options: UseKeypressedOptions = {}) {
  const { isActive = true, rawMode = true } = options;
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
    if (!isActive) {
      return;
    }

    const parser = new KeypressParser();
    parserRef.current = parser;
    const unsubscribe = parser.onKeypress((key) => {
      for (const handler of handlersRef.current) {
        if (handler(key) === true) {
          break;
        }
      }
    });

    return () => {
      unsubscribe();
      parserRef.current = null;
    };
  }, [isActive]);

  useTerminalInput((data) => {
    parserRef.current?.feed(data);
  }, {
    isActive,
    rawMode,
  });

  return {
    addHandler,
    removeHandler,
  };
}

export { parseKeypress };

export function keyMatches(key: KeyInfo, match: Partial<KeyInfo>): boolean {
  if (match.name !== undefined && key.name !== match.name) return false;
  if (match.ctrl !== undefined && key.ctrl !== match.ctrl) return false;
  if (match.meta !== undefined && key.meta !== match.meta) return false;
  if (match.shift !== undefined && key.shift !== match.shift) return false;
  if (match.sequence !== undefined && key.sequence !== match.sequence) return false;
  if (match.insertable !== undefined && key.insertable !== match.insertable) return false;
  return true;
}
