import { describe, expect, it, vi } from "vitest";
import { executeTranscriptKeyboardAction } from "./transcript-interaction-controller.js";

function createHandlers() {
  return {
    disarmHistorySearchSelection: vi.fn(),
    scrollTranscriptBy: vi.fn(),
    closeHistorySearchSurface: vi.fn(),
    backspaceHistorySearchQuery: vi.fn(),
    stepHistorySearchSelection: vi.fn(),
    submitHistorySearchSelection: vi.fn(),
    appendHistorySearchQuery: vi.fn(),
    openHistorySearchSurface: vi.fn(),
    clearTranscriptSelectionFocus: vi.fn(),
    exitTranscriptModeSurface: vi.fn(),
    toggleTranscriptShowAll: vi.fn(),
    scrollTranscriptHome: vi.fn(),
    scrollTranscriptToBottom: vi.fn(),
    cycleTranscriptSelection: vi.fn(),
    copySelectedTranscriptText: vi.fn(),
    copySelectedTranscriptItem: vi.fn(),
    copySelectedTranscriptToolInput: vi.fn(),
    toggleSelectedTranscriptDetail: vi.fn(),
    navigateSearchMatch: vi.fn(),
    // FEATURE_058: dump-to-scrollback callback added in v0.7.25.
    dumpTranscriptToScrollback: vi.fn(),
  };
}

describe("transcript-interaction-controller", () => {
  it("routes transcript paging and search actions through controller callbacks", () => {
    const handlers = createHandlers();

    expect(executeTranscriptKeyboardAction({
      action: { kind: "scroll-page-up" },
      hasTranscript: true,
      isTranscriptMode: true,
      pageScrollDelta: 12,
      ...handlers,
    })).toBe(true);
    expect(handlers.disarmHistorySearchSelection).toHaveBeenCalledTimes(1);
    expect(handlers.scrollTranscriptBy).toHaveBeenCalledWith(12);

    expect(executeTranscriptKeyboardAction({
      action: { kind: "history-search-append", text: "abc" },
      hasTranscript: true,
      isTranscriptMode: true,
      pageScrollDelta: 12,
      ...handlers,
    })).toBe(true);
    expect(handlers.appendHistorySearchQuery).toHaveBeenCalledWith("abc");
  });

  it("exits transcript on scroll-end only when transcript mode owns the surface", () => {
    const transcriptHandlers = createHandlers();
    expect(executeTranscriptKeyboardAction({
      action: { kind: "scroll-end" },
      hasTranscript: true,
      isTranscriptMode: true,
      pageScrollDelta: 12,
      ...transcriptHandlers,
    })).toBe(true);
    expect(transcriptHandlers.exitTranscriptModeSurface).toHaveBeenCalledTimes(1);
    expect(transcriptHandlers.scrollTranscriptToBottom).not.toHaveBeenCalled();

    const promptHandlers = createHandlers();
    expect(executeTranscriptKeyboardAction({
      action: { kind: "scroll-end" },
      hasTranscript: true,
      isTranscriptMode: false,
      pageScrollDelta: 12,
      ...promptHandlers,
    })).toBe(true);
    expect(promptHandlers.scrollTranscriptToBottom).toHaveBeenCalledTimes(1);
    expect(promptHandlers.exitTranscriptModeSurface).not.toHaveBeenCalled();
  });

  it("clears transcript focus without exiting when requested", () => {
    const handlers = createHandlers();

    expect(executeTranscriptKeyboardAction({
      action: { kind: "clear-selection-focus" },
      hasTranscript: true,
      isTranscriptMode: true,
      pageScrollDelta: 12,
      ...handlers,
    })).toBe(true);

    expect(handlers.clearTranscriptSelectionFocus).toHaveBeenCalledTimes(1);
    expect(handlers.exitTranscriptModeSurface).not.toHaveBeenCalled();
  });

  it("toggles transcript show-all through the controller", () => {
    const handlers = createHandlers();

    expect(executeTranscriptKeyboardAction({
      action: { kind: "toggle-show-all" },
      hasTranscript: true,
      isTranscriptMode: true,
      pageScrollDelta: 12,
      ...handlers,
    })).toBe(true);

    expect(handlers.toggleTranscriptShowAll).toHaveBeenCalledTimes(1);
  });
});
