import { useCallback, useEffect, useRef } from "react";
import { useAutocomplete, useAutocompleteContext, type SelectedCompletion } from "../hooks/useAutocomplete.js";
import { useInputHistory } from "../hooks/useInputHistory.js";
import { useTextBuffer } from "../hooks/useTextBuffer.js";
import type { KeyInfo, PromptEditingMode, PromptSubmitPayload } from "../types.js";
import type { PastedContent } from "./paste-store.js";

export type { PromptSubmitPayload };
import {
  LARGE_INPUT_TRUNCATE_THRESHOLD,
  findPlaceholderAfterCursor,
  findPlaceholderBeforeCursor,
  maybeTruncateLongInput,
} from "./paste-store.js";
import { buildAutocompleteReplacement } from "./autocomplete-replacement.js";

export interface PromptInputControllerOptions {
  /**
   * Receives the finalized prompt. Consumers that care about the expanded
   * text (parseCommand, agent pipeline) should read `payload.fullText`;
   * consumers that render the user prompt (history UI) should read
   * `payload.displayText`.
   */
  onSubmit: (payload: PromptSubmitPayload) => void;
  onExit?: () => void;
  placeholder?: string;
  prompt?: string;
  focus?: boolean;
  initialValue?: string;
  cwd?: string;
  gitRoot?: string;
  autocompleteEnabled?: boolean;
  onInputChange?: (text: string) => void;
  /**
   * Called when the input history ↑ recalls an entry that carries stored
   * paste contents. Consumers may hydrate a disk-backed paste cache here
   * before expansion is attempted on the next submit.
   */
  onHistoryRecall?: (entry: { text: string; pastedContents: PastedContent[] }) => void;
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
  onHistoryRecall,
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
    pasteStore,
    resetTransientState,
    setText,
    replaceRange,
    clear,
    move,
    moveToOffset,
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

  // Issue 121 Layer 2: auto-truncate long non-paste input. Triggers when the
  // buffer exceeds LARGE_INPUT_TRUNCATE_THRESHOLD from a path that bypassed
  // Layer 1 (stdin pipe, non-bracketed-paste terminals, programmatic setText).
  // Guard: only fire while the user is NOT actively mid-paste (isPasting)
  // so we don't race the paste-end sync.
  const lastTruncatedLengthRef = useRef<number>(0);
  useEffect(() => {
    if (isPasting) return;
    if (text.length <= LARGE_INPUT_TRUNCATE_THRESHOLD) {
      lastTruncatedLengthRef.current = 0;
      return;
    }
    if (text.length === lastTruncatedLengthRef.current) return;

    const nextId = pasteStore.peekNextId();
    const { truncatedText, placeholderContent } = maybeTruncateLongInput(
      text,
      nextId,
    );
    if (!placeholderContent) return;
    pasteStore.registerTruncatedText(placeholderContent);
    lastTruncatedLengthRef.current = truncatedText.length;
    setText(truncatedText);
  }, [text, isPasting, pasteStore, setText]);

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
    resetTransientState();
    if (autocompleteState.visible) {
      handleAutocompleteEscape();
    }
  }, [autocompleteState.visible, focus, handleAutocompleteEscape, resetTransientState]);

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
    const displayText = submittedText ?? text;
    if (!displayText.trim()) {
      return;
    }

    // Issue 121: expand paste placeholders into the full form destined for
    // parseCommand / agent. Collect a snapshot of only the contents actually
    // referenced by displayText (orphaned ids are dropped from persistence).
    const fullText = pasteStore.expand(displayText);
    const referencedIds = new Set<number>();
    const placeholderPattern = /\[(Pasted text|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.*)\]/g;
    for (const m of displayText.matchAll(placeholderPattern)) {
      const id = Number.parseInt(m[2] ?? "0", 10);
      if (Number.isFinite(id) && id > 0) referencedIds.add(id);
    }
    const pastedContents: PastedContent[] = [];
    for (const id of referencedIds) {
      const entry = pasteStore.get(id);
      if (entry) pastedContents.push(entry);
    }

    addHistory(displayText, { pastedContents });
    onSubmit({ displayText, fullText, pastedContents });
    clear();
  }, [addHistory, clear, onSubmit, pasteStore, text]);

  const handleHistoryRecall = useCallback(
    (entry: { text: string; pastedContents?: readonly PastedContent[] } | null) => {
      if (!entry) return;
      if (entry.pastedContents && entry.pastedContents.length > 0) {
        for (const content of entry.pastedContents) {
          pasteStore.adopt(content);
        }
        onHistoryRecall?.({
          text: entry.text,
          pastedContents: [...entry.pastedContents],
        });
      }
      setText(entry.text);
    },
    [onHistoryRecall, pasteStore, setText],
  );

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
        const entry = navigateUp();
        handleHistoryRecall(entry);
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
        const entry = navigateDown();
        handleHistoryRecall(entry);
      } else {
        move("down");
      }
      return true;
    }

    // Issue 121: arrow keys jump atomically over paste placeholders so the
    // cursor never lands inside a `[Pasted text #N ...]` block. Without this
    // the cursor can split a placeholder visually, and subsequent edits (or
    // submit) would leak partial placeholder text to the LLM.
    if (key.name === "left") {
      const offset = buffer.getAbsoluteOffset();
      const adj = findPlaceholderBeforeCursor(buffer.text, offset);
      if (adj) {
        moveToOffset(adj.start);
      } else {
        move("left");
      }
      return true;
    }
    if (key.name === "right") {
      const offset = buffer.getAbsoluteOffset();
      const adj = findPlaceholderAfterCursor(buffer.text, offset);
      if (adj) {
        moveToOffset(adj.end);
      } else {
        move("right");
      }
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
    buffer,
    clear,
    cursor.row,
    deleteChar,
    focus,
    handleAutocompleteDown,
    handleAutocompleteEscape,
    handleAutocompleteUp,
    handleEnter,
    handleHistoryRecall,
    handleTab,
    lines,
    killLineLeft,
    killLineRight,
    move,
    moveToOffset,
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
