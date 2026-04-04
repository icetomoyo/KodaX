import { describe, expect, it } from "vitest";
import {
  buildTranscriptSearchViewModel,
  buildTranscriptSelectionViewModel,
} from "./transcript-viewport.js";

describe("transcript-viewport view model", () => {
  it("hides transcript selection capabilities outside the owned browsing path", () => {
    expect(buildTranscriptSelectionViewModel({
      state: {
        followMode: "follow-bottom",
        supportsSelection: true,
        supportsCopyOnSelect: true,
      },
      itemSummary: { summary: "Assistant response", kindLabel: "assistant" },
      selectedItemId: "assistant-1",
      selectedItemIndex: 0,
      selectableCount: 3,
      canCopyToolInput: false,
      isExpanded: false,
    })).toBeUndefined();
  });

  it("builds copy and navigation capabilities from host-aware selection truth", () => {
    expect(buildTranscriptSelectionViewModel({
      state: {
        followMode: "browsing-history",
        supportsSelection: true,
        supportsCopyOnSelect: false,
      },
      itemSummary: { summary: "Tool call: changed_diff", kindLabel: "tool" },
      selectedItemId: "tool-1",
      selectedItemIndex: 1,
      selectableCount: 3,
      canCopyToolInput: true,
      isExpanded: true,
    })).toEqual({
      itemSummary: "Tool call: changed_diff",
      itemKind: "tool",
      position: { current: 2, total: 3 },
      detailState: "expanded",
      copyCapabilities: {
        message: true,
        toolInput: true,
        copyOnSelect: false,
      },
      toggleDetail: true,
      navigationCapabilities: {
        selection: true,
      },
    });
  });

  it("keeps inline search status out of overlay viewports", () => {
    expect(buildTranscriptSearchViewModel({
      query: "router",
      matches: [{ itemId: "assistant-1", itemIndex: 1, excerpt: "router found" }],
      currentMatchIndex: 0,
      anchorItemId: "assistant-1",
      statusText: "1/1 transcript matches",
      useOverlaySurface: true,
    }).statusText).toBeUndefined();
  });
});
