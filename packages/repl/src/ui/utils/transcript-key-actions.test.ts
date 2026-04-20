import { describe, expect, it } from "vitest";
import type { KeyInfo } from "../types.js";
import { resolveTranscriptKeyboardAction } from "./transcript-key-actions.js";

function createKey(overrides: Partial<KeyInfo>): KeyInfo {
  return {
    name: "",
    sequence: "",
    ctrl: false,
    meta: false,
    shift: false,
    insertable: false,
    ...overrides,
  };
}

describe("transcript-key-actions", () => {
  it("opens transcript search only in transcript mode", () => {
    expect(resolveTranscriptKeyboardAction({
      key: createKey({ name: "/", sequence: "/", insertable: true }),
      isTranscriptMode: true,
      isHistorySearchActive: false,
      historySearchMatchCount: 0,
      hasTextSelection: false,
      hasFocusedItem: false,
      canCopySelectedItem: false,
      canCopySelectedToolInput: false,
      canToggleSelectedDetail: false,
      canCycleTranscriptSelection: false,
    })).toEqual({ kind: "open-history-search" });

    expect(resolveTranscriptKeyboardAction({
      key: createKey({ name: "/", sequence: "/", insertable: true }),
      isTranscriptMode: false,
      isHistorySearchActive: false,
      historySearchMatchCount: 0,
      hasTextSelection: false,
      hasFocusedItem: false,
      canCopySelectedItem: false,
      canCopySelectedToolInput: false,
      canToggleSelectedDetail: false,
      canCycleTranscriptSelection: false,
    })).toEqual({ kind: "none" });
  });

  it("maps history search keys to dedicated actions", () => {
    expect(resolveTranscriptKeyboardAction({
      key: createKey({ name: "down" }),
      isTranscriptMode: true,
      isHistorySearchActive: true,
      historySearchMatchCount: 2,
      hasTextSelection: false,
      hasFocusedItem: false,
      canCopySelectedItem: false,
      canCopySelectedToolInput: false,
      canToggleSelectedDetail: false,
      canCycleTranscriptSelection: false,
    })).toEqual({ kind: "history-search-step", direction: "next" });

    expect(resolveTranscriptKeyboardAction({
      key: createKey({ name: "return" }),
      isTranscriptMode: true,
      isHistorySearchActive: true,
      historySearchMatchCount: 2,
      hasTextSelection: false,
      hasFocusedItem: false,
      canCopySelectedItem: false,
      canCopySelectedToolInput: false,
      canToggleSelectedDetail: false,
      canCycleTranscriptSelection: false,
    })).toEqual({ kind: "history-search-submit" });
  });

  it("prefers text selection copy over item copy", () => {
    expect(resolveTranscriptKeyboardAction({
      key: createKey({ name: "c" }),
      isTranscriptMode: true,
      isHistorySearchActive: false,
      historySearchMatchCount: 0,
      hasTextSelection: true,
      hasFocusedItem: false,
      canCopySelectedItem: true,
      canCopySelectedToolInput: false,
      canToggleSelectedDetail: false,
      canCycleTranscriptSelection: false,
    })).toEqual({ kind: "copy-selection" });

    expect(resolveTranscriptKeyboardAction({
      key: createKey({ name: "c" }),
      isTranscriptMode: true,
      isHistorySearchActive: false,
      historySearchMatchCount: 0,
      hasTextSelection: false,
      hasFocusedItem: true,
      canCopySelectedItem: true,
      canCopySelectedToolInput: false,
      canToggleSelectedDetail: false,
      canCycleTranscriptSelection: false,
    })).toEqual({ kind: "copy-item" });
  });

  it("handles transcript-only navigation and match stepping", () => {
    expect(resolveTranscriptKeyboardAction({
      key: createKey({ name: "j" }),
      isTranscriptMode: true,
      isHistorySearchActive: false,
      historySearchMatchCount: 0,
      hasTextSelection: false,
      hasFocusedItem: false,
      canCopySelectedItem: false,
      canCopySelectedToolInput: false,
      canToggleSelectedDetail: false,
      canCycleTranscriptSelection: false,
    })).toEqual({ kind: "scroll-line-down" });

    expect(resolveTranscriptKeyboardAction({
      key: createKey({ name: "n", shift: true }),
      isTranscriptMode: true,
      isHistorySearchActive: false,
      historySearchMatchCount: 3,
      hasTextSelection: false,
      hasFocusedItem: false,
      canCopySelectedItem: false,
      canCopySelectedToolInput: false,
      canToggleSelectedDetail: false,
      canCycleTranscriptSelection: false,
    })).toEqual({ kind: "search-match-nav", direction: "prev" });
  });

  it("maps Ctrl+E to toggle show all in transcript mode", () => {
    expect(resolveTranscriptKeyboardAction({
      key: createKey({ name: "e", ctrl: true }),
      isTranscriptMode: true,
      isHistorySearchActive: false,
      historySearchMatchCount: 0,
      hasTextSelection: false,
      hasFocusedItem: false,
      canCopySelectedItem: false,
      canCopySelectedToolInput: false,
      canToggleSelectedDetail: false,
      canCycleTranscriptSelection: false,
    })).toEqual({ kind: "toggle-show-all" });

    expect(resolveTranscriptKeyboardAction({
      key: createKey({ name: "e", ctrl: true }),
      isTranscriptMode: false,
      isHistorySearchActive: false,
      historySearchMatchCount: 0,
      hasTextSelection: false,
      hasFocusedItem: false,
      canCopySelectedItem: false,
      canCopySelectedToolInput: false,
      canToggleSelectedDetail: false,
      canCycleTranscriptSelection: false,
    })).toEqual({ kind: "none" });
  });

  it("uses escape to clear selection/focus before exiting transcript", () => {
    expect(resolveTranscriptKeyboardAction({
      key: createKey({ name: "escape" }),
      isTranscriptMode: true,
      isHistorySearchActive: false,
      historySearchMatchCount: 0,
      hasTextSelection: true,
      hasFocusedItem: false,
      canCopySelectedItem: false,
      canCopySelectedToolInput: false,
      canToggleSelectedDetail: false,
      canCycleTranscriptSelection: false,
    })).toEqual({ kind: "clear-selection-focus" });

    expect(resolveTranscriptKeyboardAction({
      key: createKey({ name: "escape" }),
      isTranscriptMode: true,
      isHistorySearchActive: false,
      historySearchMatchCount: 0,
      hasTextSelection: false,
      hasFocusedItem: true,
      canCopySelectedItem: true,
      canCopySelectedToolInput: true,
      canToggleSelectedDetail: true,
      canCycleTranscriptSelection: true,
    })).toEqual({ kind: "clear-selection-focus" });

    expect(resolveTranscriptKeyboardAction({
      key: createKey({ name: "escape" }),
      isTranscriptMode: true,
      isHistorySearchActive: false,
      historySearchMatchCount: 0,
      hasTextSelection: false,
      hasFocusedItem: false,
      canCopySelectedItem: false,
      canCopySelectedToolInput: false,
      canToggleSelectedDetail: false,
      canCycleTranscriptSelection: false,
    })).toEqual({ kind: "exit-transcript" });
  });

  describe("dump-to-scrollback (FEATURE_058)", () => {
    it("maps plain 's' in transcript mode to dump-to-scrollback", () => {
      expect(resolveTranscriptKeyboardAction({
        key: createKey({ name: "s" }),
        isTranscriptMode: true,
        isHistorySearchActive: false,
        historySearchMatchCount: 0,
        hasTextSelection: false,
        hasFocusedItem: false,
        canCopySelectedItem: false,
        canCopySelectedToolInput: false,
        canToggleSelectedDetail: false,
        canCycleTranscriptSelection: false,
      })).toEqual({ kind: "dump-to-scrollback" });
    });

    it("does not trigger dump-to-scrollback outside transcript mode", () => {
      expect(resolveTranscriptKeyboardAction({
        key: createKey({ name: "s" }),
        isTranscriptMode: false,
        isHistorySearchActive: false,
        historySearchMatchCount: 0,
        hasTextSelection: false,
        hasFocusedItem: false,
        canCopySelectedItem: false,
        canCopySelectedToolInput: false,
        canToggleSelectedDetail: false,
        canCycleTranscriptSelection: false,
      })).toEqual({ kind: "none" });
    });

    it("does not match Ctrl+S or Shift+S (avoid flow-control conflict)", () => {
      expect(resolveTranscriptKeyboardAction({
        key: createKey({ name: "s", ctrl: true }),
        isTranscriptMode: true,
        isHistorySearchActive: false,
        historySearchMatchCount: 0,
        hasTextSelection: false,
        hasFocusedItem: false,
        canCopySelectedItem: false,
        canCopySelectedToolInput: false,
        canToggleSelectedDetail: false,
        canCycleTranscriptSelection: false,
      })).toEqual({ kind: "none" });

      expect(resolveTranscriptKeyboardAction({
        key: createKey({ name: "s", shift: true }),
        isTranscriptMode: true,
        isHistorySearchActive: false,
        historySearchMatchCount: 0,
        hasTextSelection: false,
        hasFocusedItem: false,
        canCopySelectedItem: false,
        canCopySelectedToolInput: false,
        canToggleSelectedDetail: false,
        canCycleTranscriptSelection: false,
      })).toEqual({ kind: "none" });
    });

    it("does not trigger when history search is active", () => {
      expect(resolveTranscriptKeyboardAction({
        key: createKey({ name: "s", sequence: "s", insertable: true }),
        isTranscriptMode: true,
        isHistorySearchActive: true,
        historySearchMatchCount: 0,
        hasTextSelection: false,
        hasFocusedItem: false,
        canCopySelectedItem: false,
        canCopySelectedToolInput: false,
        canToggleSelectedDetail: false,
        canCycleTranscriptSelection: false,
      })).toEqual({ kind: "history-search-append", text: "s" });
    });
  });
});
