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
// FEATURE_134 v0.7.40 — image paste integration. `extractImagePaths` is a
// sync regex check used as a fast-path gate; `handleBracketedPaste` is the
// async orchestrator (jimp decode + persist + KodaXImageBlock). Outputs
// flow back into the input buffer as `@<path>` refs, which the existing
// `preparePromptInputArtifacts` pipeline (`common/input-artifacts.ts`)
// converts to `KodaXInputArtifact[]` on submit. So FEATURE_134 only adds
// the paste → text-ref translation; everything downstream is already
// wired via the @-ref syntax.
import {
  extractImagePaths,
  handleBracketedPaste,
  triggerExplicitClipboardImage,
} from "../../paste/index.js";
import { emitKodaXDiagnostic } from "@kodax-ai/agent";

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
  /** Notify the UI when an image-path paste falls back to plain text. */
  onPasteFallback?: (message: string) => void;
  /**
   * Called when the input history ↑ recalls an entry that carries stored
   * paste contents. Consumers may hydrate a disk-backed paste cache here
   * before expansion is attempted on the next submit.
   */
  onHistoryRecall?: (entry: { text: string; pastedContents: PastedContent[] }) => void;
  /**
   * FEATURE_149 Phase 2.1 (v0.7.38) — pop queued follow-ups back into the
   * editor on ↑ when the buffer is empty. Returns the text to load (the
   * consumer atomically clears its queue), or `undefined` to fall through
   * to normal history navigation when the queue is empty.
   */
  onPopPendingInputs?: () => string | undefined;
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

function reportPromptInputDiagnostic(message: string, detail?: unknown): void {
  emitKodaXDiagnostic({
    source: "repl:prompt-input",
    level: "warn",
    message,
    ...(detail !== undefined ? { detail } : {}),
  });
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
  onPasteFallback,
  onHistoryRecall,
  onPopPendingInputs,
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

  // FEATURE_134 v0.7.40 — async image paste handler. Fired from the
  // synthetic `name === "paste"` event when its content contains image
  // file paths (per `extractImagePaths` regex), OR from explicit
  // Alt+V / Ctrl+V triggers. Resolves to `@<absolute-path>` references
  // inserted at the cursor. Downstream `preparePromptInputArtifacts`
  // (`common/input-artifacts.ts`) parses these refs back into
  // `KodaXInputArtifact[]` on submit — so no other change is needed.
  //
  // Fire-and-forget: returns immediately so the keypress contract stays
  // sync. Errors are surfaced via diagnostics so background paste handling
  // never writes below Ink's live region.
  const insertImageRefsFromPaste = useCallback(
    async (pasteContent: string): Promise<void> => {
      try {
        const outcome = await handleBracketedPaste(pasteContent);
        if (outcome.kind === "images") {
          const refs = outcome.blocks.map((b) => `@${b.path}`).join(" ");
          // paste:false so the insert path doesn't register a placeholder
          // — these refs are short, structurally meaningful, and the user
          // should see them verbatim in the input buffer.
          insert(`${refs} `, { paste: false });
        } else if (outcome.kind === "error") {
          reportPromptInputDiagnostic(`Paste image handling failed: ${outcome.message}`);
          insert(pasteContent, { paste: false });
          onPasteFallback?.("Image paste failed; inserted as plain text.");
        }
        // noop / text outcomes: nothing to do here. The fast-path gate
        // in handleKey only invokes this when extractImagePaths returned
        // a non-empty list, so an unexpected text fallthrough is rare.
      } catch (err) {
        reportPromptInputDiagnostic('Paste image handling failed.', err);
      }
    },
    [insert, onPasteFallback],
  );

  // FEATURE_134 v0.7.40 — single-flight guard. OS-level Alt+V autorepeat
  // (Windows conhost in particular emits repeat events even on a brief
  // press) would otherwise fire N concurrent clipboard reads → N temp
  // files. The guard drops re-entrant invocations while the previous
  // clipboard read is in flight; pairs with the content-hash filename in
  // `persist-image.ts` so even repeated explicit presses on the same
  // screenshot reuse one file rather than accumulating duplicates.
  const explicitImagePasteInflightRef = useRef<boolean>(false);
  const triggerExplicitImagePaste = useCallback(async (): Promise<void> => {
    if (explicitImagePasteInflightRef.current) {
      return;
    }
    explicitImagePasteInflightRef.current = true;
    try {
      const outcome = await triggerExplicitClipboardImage();
      if (outcome.kind === "images") {
        const refs = outcome.blocks.map((b) => `@${b.path}`).join(" ");
        insert(`${refs} `, { paste: false });
      } else if (outcome.kind === "error") {
        reportPromptInputDiagnostic(`Clipboard image handling failed: ${outcome.message}`);
      }
      // noop: clipboard had no image — silent (matches FEATURE_134 design).
    } catch (err) {
      reportPromptInputDiagnostic('Clipboard image handling failed.', err);
    } finally {
      explicitImagePasteInflightRef.current = false;
    }
  }, [insert]);

  const handleKey = useCallback((key: KeyInfo): boolean => {
    if (!focus) {
      return false;
    }

    // FEATURE_134 v0.7.40 — explicit clipboard-image keybind. Per
    // claudecode parity: Alt+V on Windows (Ctrl+V is reserved by the
    // terminal), Ctrl+V on macOS/Linux (where Cmd+V on macOS auto-pastes
    // via bracketed-paste Source 3). Test runs in REPL — failure mode
    // is `kind: 'noop'` (no image on clipboard) which is silent.
    if (key.name === "v" && (key.ctrl || key.meta)) {
      void triggerExplicitImagePaste();
      return true;
    }

    // FEATURE_134 v0.7.40 — bracketed-paste fast path. The synthetic
    // `paste` event from `keypress-parser.ts` carries the full unwrapped
    // paste content. If `extractImagePaths` (a sync regex) finds any
    // file paths that look like images, divert to the async handler.
    // Otherwise fall through to the generic insertable branch below so
    // plain-text pastes hit the existing Issue 121 paste-store path.
    if (key.name === "paste" && key.isPasted) {
      const imagePaths = extractImagePaths(key.sequence);
      if (imagePaths.length > 0) {
        void insertImageRefsFromPaste(key.sequence);
        return true;
      }
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

      // FEATURE_149 Phase 2.1 (v0.7.38) — pop queued follow-ups back into
      // the editor when ↑ is pressed on an EMPTY buffer. The empty-buffer
      // condition guarantees we only intercept history navigation in cases
      // where there's nothing to navigate from anyway, so existing history
      // recall UX is preserved when the queue is empty (callback returns
      // `undefined`).
      if (text.length === 0 && onPopPendingInputs) {
        const popped = onPopPendingInputs();
        if (popped instanceof Promise) {
          // Host-queue pull: withdrawals settle asynchronously; land the
          // pulled text when they do. Only entries the Host actually took
          // back are returned, so nothing editable re-runs behind the user.
          void popped.then((value) => {
            if (typeof value === "string" && value.length > 0) setText(value);
          });
          return true;
        }
        if (typeof popped === "string" && popped.length > 0) {
          setText(popped);
          return true;
        }
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
    insertImageRefsFromPaste,
    triggerExplicitImagePaste,
    lines,
    killLineLeft,
    killLineRight,
    move,
    moveToOffset,
    navigateDown,
    navigateUp,
    newline,
    onExit,
    onPopPendingInputs,
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
