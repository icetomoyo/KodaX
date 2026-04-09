import { describe, expect, it } from "vitest";
import {
  buildBaseFooterNotices,
  buildFooterNotifications,
  buildPromptFooterNotices,
  buildStashNoticeText,
  buildTranscriptFooterBudgetNotices,
  buildTranscriptFooterSecondaryText,
  buildTranscriptFooterViewModel,
} from "./surface-chrome.js";

describe("surface-chrome", () => {
  it("builds prompt footer notices and notifications", () => {
    expect(buildBaseFooterNotices({
      historySearchQuery: "tool",
      pendingInputCount: 2,
    })).toEqual([
      "Search: tool",
      "Queued follow-ups: 2",
    ]);

    expect(buildFooterNotifications({
      historySearchQuery: "tool",
      isHistorySearchActive: true,
      historySearchMatchCount: 0,
      pendingInputCount: 8,
      maxPendingInputs: 8,
    })).toEqual([
      { id: "search-empty", text: "No transcript matches yet", tone: "info" },
      { id: "queue-full", text: "Queued follow-up limit reached (8)", tone: "warning" },
    ]);

    expect(buildPromptFooterNotices(["Queued follow-ups: 1"])).toEqual([
      "Queued follow-ups: 1",
    ]);
  });

  it("builds transcript footer text without leaking prompt-only search notices", () => {
    expect(buildTranscriptFooterSecondaryText({
      isHistorySearchActive: false,
      historySearchDetailText: "should not show",
      selectionSummary: "1 line selected",
      actionSummary: "C copy | V details",
      showAllActive: false,
      baseFooterNotices: ["Search: abc", "Queued follow-ups: 1"],
    })).toBe("1 line selected | C copy | V details");

    expect(buildTranscriptFooterBudgetNotices("1 line selected | C copy")).toEqual([
      "1 line selected | C copy",
    ]);

    expect(buildTranscriptFooterSecondaryText({
      isHistorySearchActive: false,
      historySearchDetailText: undefined,
      selectionSummary: undefined,
      actionSummary: undefined,
      showAllActive: false,
      baseFooterNotices: [],
    })).toBe("\u2190/\u2192 enter select mode | Ctrl+E show all | Mouse drag selects text");

    expect(buildTranscriptFooterSecondaryText({
      isHistorySearchActive: true,
      historySearchDetailText: undefined,
      selectionSummary: undefined,
      actionSummary: undefined,
      showAllActive: false,
      baseFooterNotices: [],
    })).toBe("\u2190/\u2192 enter select mode | Ctrl+E show all | Mouse drag selects text");
  });

  it("builds transcript footer view model from selection and search state", () => {
    expect(buildTranscriptFooterViewModel({
      textSelection: undefined,
      selectionState: {
        itemSummary: "Assistant response",
        itemKind: "assistant",
        position: { current: 2, total: 4 },
        detailState: "compact",
        copyCapabilities: {
          message: true,
          toolInput: false,
          copyOnSelect: true,
        },
        toggleDetail: true,
        navigationCapabilities: {
          selection: true,
        },
      },
      isHistorySearchActive: false,
      historySearchDetailText: undefined,
      historySearchHasMatches: true,
      showAllActive: false,
      baseFooterNotices: ["Queued follow-ups: 1"],
    })).toEqual({
      selectionSummary: undefined,
      actionSummary: "\u2190/\u2192 browse | C copy | Mouse select copies | V details | Esc clear",
      secondaryText: "\u2190/\u2192 browse | C copy | Mouse select copies | V details | Esc clear",
      budgetNotices: [
        "\u2190/\u2192 browse | C copy | Mouse select copies | V details | Esc clear",
      ],
    });
  });

  it("keeps transcript footer compact when no item is focused", () => {
    expect(buildTranscriptFooterViewModel({
      textSelection: undefined,
      selectionState: undefined,
      isHistorySearchActive: false,
      historySearchDetailText: undefined,
      historySearchHasMatches: true,
      showAllActive: false,
      baseFooterNotices: ["Queued follow-ups: 1"],
    })).toEqual({
      selectionSummary: undefined,
      actionSummary: undefined,
      secondaryText: "\u2190/\u2192 enter select mode | Ctrl+E show all | Mouse drag selects text",
      budgetNotices: [
        "\u2190/\u2192 enter select mode | Ctrl+E show all | Mouse drag selects text",
      ],
    });
  });

  it("shows collapse guidance when show-all is active", () => {
    expect(buildTranscriptFooterViewModel({
      textSelection: undefined,
      selectionState: undefined,
      isHistorySearchActive: false,
      historySearchDetailText: undefined,
      historySearchHasMatches: true,
      showAllActive: true,
      baseFooterNotices: [],
    })).toEqual({
      selectionSummary: undefined,
      actionSummary: undefined,
      secondaryText: "\u2190/\u2192 enter select mode | Ctrl+E collapse | Mouse drag selects text",
      budgetNotices: [
        "\u2190/\u2192 enter select mode | Ctrl+E collapse | Mouse drag selects text",
      ],
    });
  });

  it("shows stash notice only when draft is preserved away from prompt mode", () => {
    expect(buildStashNoticeText({
      inputText: "draft",
      isTranscriptMode: true,
      isHistorySearchActive: false,
    })).toBe("Draft preserved while viewing transcript");

    expect(buildStashNoticeText({
      inputText: "draft",
      isTranscriptMode: false,
      isHistorySearchActive: false,
    })).toBeUndefined();
  });
});
