import type { KeyInfo } from "../types.js";

export type TranscriptKeyboardAction =
  | { kind: "none" }
  | { kind: "scroll-page-up" }
  | { kind: "scroll-page-down" }
  | { kind: "scroll-home" }
  | { kind: "scroll-end" }
  | { kind: "open-history-search" }
  | { kind: "close-history-search" }
  | { kind: "history-search-backspace" }
  | { kind: "history-search-step"; direction: "next" | "prev" }
  | { kind: "history-search-submit" }
  | { kind: "history-search-append"; text: string }
  | { kind: "clear-selection-focus" }
  | { kind: "exit-transcript" }
  | { kind: "scroll-line-down" }
  | { kind: "scroll-line-up" }
  | { kind: "jump-oldest" }
  | { kind: "jump-latest" }
  | { kind: "toggle-show-all" }
  | { kind: "cycle-selection"; direction: "prev" | "next" }
  | { kind: "copy-selection" }
  | { kind: "copy-item" }
  | { kind: "copy-tool-input" }
  | { kind: "toggle-detail" }
  | { kind: "search-match-nav"; direction: "next" | "prev" };

export interface ResolveTranscriptKeyboardActionOptions {
  key: KeyInfo;
  isTranscriptMode: boolean;
  isHistorySearchActive: boolean;
  historySearchMatchCount: number;
  hasTextSelection: boolean;
  hasFocusedItem: boolean;
  canCopySelectedItem: boolean;
  canCopySelectedToolInput: boolean;
  canToggleSelectedDetail: boolean;
  canCycleTranscriptSelection: boolean;
}

export function resolveTranscriptKeyboardAction(
  options: ResolveTranscriptKeyboardActionOptions,
): TranscriptKeyboardAction {
  const {
    key,
    isTranscriptMode,
    isHistorySearchActive,
    historySearchMatchCount,
    hasTextSelection,
    hasFocusedItem,
    canCopySelectedItem,
    canCopySelectedToolInput,
    canToggleSelectedDetail,
    canCycleTranscriptSelection,
  } = options;

  if (key.name === "pageup") {
    return { kind: "scroll-page-up" };
  }

  if (isHistorySearchActive) {
    if (key.name === "escape") {
      return { kind: "close-history-search" };
    }
    if (key.name === "backspace") {
      return { kind: "history-search-backspace" };
    }
    if (key.name === "down") {
      return { kind: "history-search-step", direction: "next" };
    }
    if (key.name === "up") {
      return { kind: "history-search-step", direction: "prev" };
    }
    if (key.name === "enter" || key.name === "return") {
      return { kind: "history-search-submit" };
    }
    if (key.insertable && key.sequence) {
      return { kind: "history-search-append", text: key.sequence };
    }
  }

  if (
    isTranscriptMode
    && !isHistorySearchActive
    && !key.ctrl
    && !key.meta
    && key.insertable
    && key.sequence === "/"
  ) {
    return { kind: "open-history-search" };
  }

  if (isTranscriptMode && !key.ctrl && !key.meta && key.name === "q") {
    return { kind: "exit-transcript" };
  }

  if (isTranscriptMode && key.name === "escape") {
    if (hasTextSelection || hasFocusedItem) {
      return { kind: "clear-selection-focus" };
    }
    return { kind: "exit-transcript" };
  }

  if (key.name === "home") {
    return { kind: "scroll-home" };
  }

  if (key.name === "pagedown") {
    return { kind: "scroll-page-down" };
  }

  if (key.name === "end") {
    return { kind: "scroll-end" };
  }

  if (!isTranscriptMode) {
    return { kind: "none" };
  }

  if (key.ctrl && !key.meta && key.name === "e") {
    return { kind: "toggle-show-all" };
  }

  if (key.name === "j" || key.name === "down") {
    return { kind: "scroll-line-down" };
  }

  if (key.name === "k" || key.name === "up") {
    return { kind: "scroll-line-up" };
  }

  if (!key.ctrl && !key.meta && key.name === "g" && key.shift) {
    return { kind: "jump-latest" };
  }

  if (!key.ctrl && !key.meta && key.name === "g" && !key.shift) {
    return { kind: "jump-oldest" };
  }

  if (key.name === "left") {
    return canCycleTranscriptSelection
      ? { kind: "cycle-selection", direction: "prev" }
      : { kind: "none" };
  }

  if (key.name === "right") {
    return canCycleTranscriptSelection
      ? { kind: "cycle-selection", direction: "next" }
      : { kind: "none" };
  }

  if (!key.ctrl && !key.meta && !key.shift && key.name === "c") {
    if (hasTextSelection) {
      return { kind: "copy-selection" };
    }
    if (canCopySelectedItem) {
      return { kind: "copy-item" };
    }
    return { kind: "none" };
  }

  if (!key.ctrl && !key.meta && !key.shift && key.name === "i") {
    return canCopySelectedToolInput
      ? { kind: "copy-tool-input" }
      : { kind: "none" };
  }

  if (!key.ctrl && !key.meta && !key.shift && key.name === "v") {
    return canToggleSelectedDetail
      ? { kind: "toggle-detail" }
      : { kind: "none" };
  }

  if (!key.ctrl && !key.meta && key.name === "n") {
    if (historySearchMatchCount === 0) {
      return { kind: "none" };
    }
    return {
      kind: "search-match-nav",
      direction: key.shift ? "prev" : "next",
    };
  }

  return { kind: "none" };
}
