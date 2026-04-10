import { describe, expect, it } from "vitest";
import {
  buildTranscriptSelectionRuntimeState,
  buildTranscriptSearchViewModel,
  buildTranscriptSelectionViewModel,
} from "./transcript-viewport.js";

describe("transcript-viewport view model", () => {
  it("normalizes transcript selection and action capabilities from the owned browsing path", () => {
    expect(buildTranscriptSelectionRuntimeState({
      state: {
        surface: "prompt",
        supportsSelection: true,
        supportsCopyOnSelect: false,
      },
      selectableItemIds: ["assistant-1", "tool-1", "assistant-2"],
      selectedItemId: "tool-1",
      selectedItemType: "tool_group",
      isExpanded: true,
    })).toEqual({
      selectionEnabled: true,
      selectedItemId: "tool-1",
      selectedItemIndex: 1,
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

  it("hides transcript selection capabilities when the host cannot support selection", () => {
    const runtime = buildTranscriptSelectionRuntimeState({
      state: {
        surface: "prompt",
        supportsSelection: false,
        supportsCopyOnSelect: true,
      },
      selectableItemIds: ["assistant-1", "assistant-2", "assistant-3"],
      selectedItemId: "assistant-1",
      selectedItemType: "assistant",
      isExpanded: false,
    });

    expect(runtime).toEqual({
      selectionEnabled: false,
      selectedItemId: undefined,
      selectedItemIndex: -1,
      position: undefined,
      detailState: "compact",
      copyCapabilities: {
        message: false,
        toolInput: false,
        copyOnSelect: false,
      },
      toggleDetail: false,
      navigationCapabilities: {
        selection: false,
      },
    });

    expect(buildTranscriptSelectionViewModel({
      runtime,
      itemSummary: { summary: "Assistant response", kindLabel: "assistant" },
    })).toBeUndefined();
  });

  it("keeps transcript item chrome hidden until an item is explicitly focused", () => {
    const runtime = buildTranscriptSelectionRuntimeState({
      state: {
        surface: "transcript",
        supportsSelection: true,
        supportsCopyOnSelect: false,
      },
      selectableItemIds: ["assistant-1", "assistant-2"],
      selectedItemId: undefined,
      selectedItemType: "assistant",
      isExpanded: false,
    });

    expect(runtime.navigationCapabilities.selection).toBe(false);

    expect(buildTranscriptSelectionViewModel({
      runtime,
      itemSummary: { summary: "Assistant response", kindLabel: "assistant" },
    })).toBeUndefined();
  });

  it("keeps transcript item chrome hidden when there are no selectable items", () => {
    const runtime = buildTranscriptSelectionRuntimeState({
      state: {
        surface: "transcript",
        supportsSelection: true,
        supportsCopyOnSelect: false,
      },
      selectableItemIds: [],
      selectedItemId: undefined,
      selectedItemType: "assistant",
      isExpanded: false,
    });

    expect(runtime.navigationCapabilities.selection).toBe(false);
    expect(buildTranscriptSelectionViewModel({
      runtime,
      itemSummary: { summary: "Assistant response", kindLabel: "assistant" },
    })).toBeUndefined();
  });

  it("keeps transcript item navigation available as a secondary capability once items exist", () => {
    const runtime = buildTranscriptSelectionRuntimeState({
      state: {
        surface: "transcript",
        supportsSelection: true,
        supportsCopyOnSelect: false,
      },
      selectableItemIds: ["assistant-1", "tool-1"],
      selectedItemId: "tool-1",
      selectedItemType: "tool_group",
      isExpanded: false,
    });

    expect(runtime.navigationCapabilities.selection).toBe(true);
  });

  it("builds copy and navigation capabilities from host-aware selection truth", () => {
    expect(buildTranscriptSelectionViewModel({
      runtime: buildTranscriptSelectionRuntimeState({
        state: {
          surface: "transcript",
          supportsSelection: true,
          supportsCopyOnSelect: false,
        },
        selectableItemIds: ["assistant-1", "tool-1", "assistant-2"],
        selectedItemId: "tool-1",
        selectedItemType: "tool_group",
        isExpanded: true,
      }),
      itemSummary: { summary: "Tool call: changed_diff", kindLabel: "tool" },
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
