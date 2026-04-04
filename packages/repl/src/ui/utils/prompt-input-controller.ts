import { useCallback, useEffect, useRef } from "react";
import { useAutocomplete, useAutocompleteContext, type SelectedCompletion } from "../hooks/useAutocomplete.js";
import { useInputHistory } from "../hooks/useInputHistory.js";
import { useTextBuffer } from "../hooks/useTextBuffer.js";
import type { KeyInfo, PromptEditingMode } from "../types.js";
import { buildAutocompleteReplacement } from "./autocomplete-replacement.js";

export interface PromptInputControllerOptions {
  onSubmit: (text: string) => void;
  onExit?: () => void;
  placeholder?: string;
  prompt?: string;
  focus?: boolean;
  initialValue?: string;
  cwd?: string;
  gitRoot?: string;
  autocompleteEnabled?: boolean;
  onInputChange?: (text: string) => void;
}

export interface PromptInputControllerResult {
  text: string;
  cursor: { row: number; col: number };
  lines: string[];
  isPasting: boolean;
  terminalFocused: boolean;
  editingMode: PromptEditingMode;
  handleKey: (key: KeyInfo) => boolean;
}

export type PromptEscapeBehavior =
  | "cancel-autocomplete"
  | "clear-input"
  | "arm-clear"
  | "pass-through";

export type PromptEnterBehavior =
  | "accept-completion-and-submit"
  | "newline"
  | "line-continuation"
  | "submit";

export type PromptEditingCommand =
  | "move-home"
  | "move-end"
  | "undo"
  | "redo"
  | "kill-line-right"
  | "kill-line-left"
  | "delete-word-left";

const DOUBLE_ESC_INTERVAL = 500;

export function shouldUseHistoryNavigation(
  cursorRow: number,
  lineCount: number,
  direction: "up" | "down",
): boolean {
  if (direction === "up") {
    return cursorRow === 0;
  }
  return cursorRow >= Math.max(0, lineCount - 1);
}

export function resolvePromptEscapeBehavior(options: {
  isAutocompleteVisible: boolean;
  hasText: boolean;
  timeSinceLastEscapeMs: number;
}): PromptEscapeBehavior {
  if (options.isAutocompleteVisible) {
    return "cancel-autocomplete";
  }

  if (!options.hasText) {
    return "pass-through";
  }

  if (options.timeSinceLastEscapeMs < DOUBLE_ESC_INTERVAL) {
    return "clear-input";
  }

  return "arm-clear";
}

export function resolvePromptEnterBehavior(options: {
  keyName: string;
  ctrl: boolean;
  shift: boolean;
  isAutocompleteVisible: boolean;
  isLineContinuation: boolean;
  isPasting: boolean;
}): PromptEnterBehavior {
  if (options.keyName === "newline" || (options.keyName === "return" && (options.ctrl || options.shift))) {
    return "newline";
  }

  if (options.isPasting) {
    return "newline";
  }

  if (options.isAutocompleteVisible) {
    return "accept-completion-and-submit";
  }

  if (options.isLineContinuation) {
    return "line-continuation";
  }

  return "submit";
}

export function resolvePromptEditingCommand(
  key: Pick<KeyInfo, "ctrl" | "meta" | "name">,
): PromptEditingCommand | undefined {
  if (key.meta && key.name === "backspace") {
    return "delete-word-left";
  }

  if (!key.ctrl) {
    return undefined;
  }

  switch (key.name) {
    case "a":
      return "move-home";
    case "e":
      return "move-end";
    case "z":
      return "undo";
    case "y":
      return "redo";
    case "k":
      return "kill-line-right";
    case "u":
      return "kill-line-left";
    case "w":
      return "delete-word-left";
    default:
      return undefined;
  }
}

export function usePromptInputController({
  onSubmit,
  onExit,
  focus = true,
  initialValue = "",
  cwd,
  gitRoot,
  autocompleteEnabled = true,
  onInputChange,
}: PromptInputControllerOptions): PromptInputControllerResult {
  const lastEscPressRef = useRef<number>(0);

  const { add: addHistory, navigateUp, navigateDown, reset: resetHistory, saveTempInput } = useInputHistory();
  const {
    buffer,
    text,
    cursor,
    lines,
    isPasting,
    editingMode,
    setText,
    replaceRange,
    clear,
    move,
    insert,
    backspace,
    newline,
    delete: deleteChar,
    undo,
    redo,
    killLineRight,
    killLineLeft,
    deleteWordLeft,
  } = useTextBuffer({
    initialValue,
    onTextChange: onInputChange,
  });

  const contextAutocomplete = useAutocompleteContext();
  const localAutocomplete = useAutocomplete({
    cwd,
    gitRoot,
    enabled: autocompleteEnabled,
  });

  const {
    state: autocompleteState,
    suggestions,
    handleInput: handleAutocompleteInput,
    handleTab,
    handleEnter,
    handleUp: handleAutocompleteUp,
    handleDown: handleAutocompleteDown,
    handleEscape: handleAutocompleteEscape,
  } = contextAutocomplete ?? localAutocomplete;

  useEffect(() => {
    if (focus) {
      return;
    }

    lastEscPressRef.current = 0;
    if (autocompleteState.visible) {
      handleAutocompleteEscape();
    }
  }, [autocompleteState.visible, focus, handleAutocompleteEscape]);

  const prevTextRef = useRef(text);
  useEffect(() => {
    if (!autocompleteEnabled) {
      return;
    }
    if (text === prevTextRef.current) {
      return;
    }

    prevTextRef.current = text;
    handleAutocompleteInput(text, buffer.getAbsoluteOffset());
  }, [autocompleteEnabled, buffer, handleAutocompleteInput, text]);

  const acceptCompletion = useCallback((completion: SelectedCompletion): string | undefined => {
    if (!completion?.text) {
      return undefined;
    }

    const replacement = buildAutocompleteReplacement(
      text,
      buffer.getAbsoluteOffset(),
      completion,
    );
    const finalText =
      text.slice(0, replacement.start)
      + replacement.replacement
      + text.slice(replacement.end);

    replaceRange(replacement.start, replacement.end, replacement.replacement);
    return finalText;
  }, [buffer, replaceRange, text]);

  const submitCurrentText = useCallback((submittedText?: string) => {
    const nextText = submittedText ?? text;
    if (!nextText.trim()) {
      return;
    }

    addHistory(nextText);
    onSubmit(nextText);
    clear();
  }, [addHistory, clear, onSubmit, text]);

  const handleKey = useCallback((key: KeyInfo): boolean => {
    if (!focus) {
      return false;
    }

    const isAutocompleteVisible = autocompleteState.visible && suggestions.length > 0;

    if (key.name === "tab" && isAutocompleteVisible) {
      const completion = handleTab();
      if (completion) {
        acceptCompletion(completion);
      }
      return true;
    }

    if (key.ctrl && key.name === "c") {
      if (text.length > 0) {
        clear();
        resetHistory();
      } else {
        onExit?.();
      }
      return true;
    }

    if (key.name === "escape") {
      const behavior = resolvePromptEscapeBehavior({
        isAutocompleteVisible,
        hasText: text.length > 0,
        timeSinceLastEscapeMs: Date.now() - lastEscPressRef.current,
      });

      switch (behavior) {
        case "cancel-autocomplete":
          handleAutocompleteEscape();
          lastEscPressRef.current = 0;
          return true;
        case "clear-input":
          lastEscPressRef.current = 0;
          clear();
          resetHistory();
          return true;
        case "arm-clear":
          lastEscPressRef.current = Date.now();
          return true;
        case "pass-through":
        default:
          return false;
      }
    }

    if (key.name === "up") {
      if (isAutocompleteVisible) {
        handleAutocompleteUp();
        return true;
      }

      if (key.ctrl) {
        move("up");
        return true;
      }

      if (shouldUseHistoryNavigation(cursor.row, lines.length, "up")) {
        saveTempInput(text);
        const historyText = navigateUp();
        if (historyText !== null) {
          setText(historyText);
        }
      } else {
        move("up");
      }
      return true;
    }

    if (key.name === "down") {
      if (isAutocompleteVisible) {
        handleAutocompleteDown();
        return true;
      }

      if (key.ctrl) {
        move("down");
        return true;
      }

      if (shouldUseHistoryNavigation(cursor.row, lines.length, "down")) {
        const historyText = navigateDown();
        if (historyText !== null) {
          setText(historyText);
        }
      } else {
        move("down");
      }
      return true;
    }

    if (key.name === "left") {
      move("left");
      return true;
    }
    if (key.name === "right") {
      move("right");
      return true;
    }
    if (key.name === "home") {
      move("home");
      return true;
    }
    if (key.name === "end") {
      move("end");
      return true;
    }

    const editingCommand = resolvePromptEditingCommand(key);
    if (editingCommand) {
      switch (editingCommand) {
        case "move-home":
          move("home");
          return true;
        case "move-end":
          move("end");
          return true;
        case "undo":
          undo();
          return true;
        case "redo":
          redo();
          return true;
        case "kill-line-right":
          killLineRight();
          return true;
        case "kill-line-left":
          killLineLeft();
          return true;
        case "delete-word-left":
          deleteWordLeft();
          return true;
        default:
          break;
      }
    }

    if (key.name === "backspace") {
      backspace();
      return true;
    }
    if (key.name === "delete") {
      deleteChar();
      return true;
    }

    if (key.name === "return" || key.name === "newline") {
      const enterBehavior = resolvePromptEnterBehavior({
        keyName: key.name,
        ctrl: key.ctrl,
        shift: key.shift,
        isAutocompleteVisible,
        isLineContinuation: Boolean(lines[cursor.row]?.endsWith("\\")),
        isPasting,
      });

      switch (enterBehavior) {
        case "accept-completion-and-submit": {
          const completion = handleEnter();
          if (completion) {
            const finalText = acceptCompletion(completion);
            submitCurrentText(finalText);
          } else {
            submitCurrentText();
          }
          return true;
        }
        case "newline":
          newline();
          return true;
        case "line-continuation":
          backspace();
          newline();
          return true;
        case "submit":
        default:
          submitCurrentText();
          return true;
      }
    }

    if (key.insertable && !key.ctrl && !key.meta) {
      insert(key.sequence, key.isPasted ? { paste: true } : undefined);
      return true;
    }
    return false;
  }, [
    acceptCompletion,
    addHistory,
    autocompleteState.visible,
    backspace,
    clear,
    cursor.row,
    deleteChar,
    focus,
    handleAutocompleteDown,
    handleAutocompleteEscape,
    handleAutocompleteUp,
    handleEnter,
    handleTab,
    lines,
    killLineLeft,
    killLineRight,
    move,
    navigateDown,
    navigateUp,
    newline,
    onExit,
    redo,
    resetHistory,
    saveTempInput,
    setText,
    submitCurrentText,
    suggestions.length,
    text.length,
    deleteWordLeft,
    isPasting,
    undo,
  ]);

  return {
    text,
    cursor,
    lines,
    isPasting,
    terminalFocused: focus,
    editingMode,
    handleKey,
  };
}
