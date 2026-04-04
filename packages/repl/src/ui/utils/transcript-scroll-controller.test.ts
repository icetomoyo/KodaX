import { describe, expect, it } from "vitest";
import {
  buildTranscriptChromeModel,
  incrementTranscriptScrollOffset,
  resolveTranscriptPageSize,
  resolveTranscriptSearchAnchorItemId,
  resolveTranscriptSelectionOffset,
  resolveTranscriptWheelStep,
} from "./transcript-scroll-controller.js";
import {
  createTranscriptDisplayState,
  enterTranscriptHistory,
  setTranscriptScrollAnchor,
  setTranscriptStickyPromptVisible,
} from "./transcript-state.js";
import type { HistoryItem } from "../types.js";

describe("transcript-scroll-controller", () => {
  it("builds sticky and jump chrome for owned browsing transcript state", () => {
    const browsing = setTranscriptStickyPromptVisible(
      setTranscriptScrollAnchor(
        enterTranscriptHistory(createTranscriptDisplayState("native_vt")),
        8,
      ),
      true,
    );

    const model = buildTranscriptChromeModel({
      state: browsing,
      ownsViewport: true,
      isAwaitingUserInteraction: false,
      isHistorySearchActive: false,
      isReviewingHistory: true,
      historySearchQuery: "",
    });

    expect(model.browseHintText).toContain("Browsing transcript history");
    expect(model.stickyHeader).toEqual({
      visible: true,
      label: "Browsing transcript history",
    });
    expect(model.jumpToLatest).toEqual({
      visible: true,
      label: "Jump to latest",
      hint: "End",
      tone: "accent",
    });
  });

  it("prefers transcript search chrome text while search is active", () => {
    const state = setTranscriptStickyPromptVisible(
      createTranscriptDisplayState("native_vt"),
      true,
    );

    const model = buildTranscriptChromeModel({
      state,
      ownsViewport: true,
      isAwaitingUserInteraction: false,
      isHistorySearchActive: true,
      isReviewingHistory: true,
      historySearchQuery: "router",
    });

    expect(model.stickyHeader).toEqual({
      visible: true,
      label: 'Searching transcript for "router"',
    });
  });

  it("resolves page and wheel steps from viewport rows", () => {
    expect(resolveTranscriptPageSize(12)).toBe(10);
    expect(resolveTranscriptWheelStep(10)).toBe(3);
    expect(incrementTranscriptScrollOffset(2, -4)).toBe(0);
    expect(incrementTranscriptScrollOffset(2, 4)).toBe(6);
  });

  it("uses the selected item as the preferred search anchor", () => {
    const items = [
      { id: "user-1", type: "user", text: "hello", timestamp: Date.now() },
      { id: "assistant-1", type: "assistant", text: "world", timestamp: Date.now() },
    ] satisfies HistoryItem[];

    expect(resolveTranscriptSearchAnchorItemId({
      items,
      selectedItemId: "user-1",
    })).toBe("user-1");
    expect(resolveTranscriptSearchAnchorItemId({ items })).toBe("assistant-1");
  });

  it("anchors transcript search to the current viewport when browsing history", () => {
    const items = [
      { id: "user-1", type: "user", text: "first", timestamp: Date.now() },
      { id: "assistant-1", type: "assistant", text: "second", timestamp: Date.now() },
      { id: "user-2", type: "user", text: "third", timestamp: Date.now() },
    ] satisfies HistoryItem[];

    expect(resolveTranscriptSearchAnchorItemId({
      items,
      terminalWidth: 80,
      transcriptMaxLines: 1000,
      viewportRows: 3,
      scrollOffset: 3,
      preferViewportAnchor: true,
    })).toBe("assistant-1");
  });

  it("calculates a stable selection offset for transcript browsing", () => {
    const items = [
      { id: "user-1", type: "user", text: "question", timestamp: Date.now() },
      {
        id: "assistant-1",
        type: "assistant",
        text: "line 1\nline 2\nline 3\nline 4",
        timestamp: Date.now(),
      },
      { id: "user-2", type: "user", text: "follow up", timestamp: Date.now() },
    ] satisfies HistoryItem[];

    const offset = resolveTranscriptSelectionOffset({
      items,
      terminalWidth: 80,
      transcriptMaxLines: 1000,
      viewportRows: 5,
      itemId: "assistant-1",
    });

    expect(offset).toBeGreaterThanOrEqual(0);
  });
});
