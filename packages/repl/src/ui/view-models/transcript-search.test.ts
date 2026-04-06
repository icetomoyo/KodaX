import { describe, expect, it } from "vitest";
import {
  buildTranscriptSearchChrome,
  buildTranscriptSearchDetailText,
  clampTranscriptSearchSelectedIndex,
} from "./transcript-search.js";

describe("transcript-search view model", () => {
  it("clamps selected index across empty and negative states", () => {
    expect(clampTranscriptSearchSelectedIndex(0, 4)).toBe(0);
    expect(clampTranscriptSearchSelectedIndex(3, -1)).toBe(-1);
    expect(clampTranscriptSearchSelectedIndex(3, 5)).toBe(2);
  });

  it("builds search detail text for idle, empty, and navigable states", () => {
    expect(buildTranscriptSearchDetailText({
      isHistorySearchActive: false,
      historySearchQuery: "foo",
      matches: [],
      clampedSelectedIndex: 0,
    })).toBeUndefined();

    expect(buildTranscriptSearchDetailText({
      isHistorySearchActive: true,
      historySearchQuery: " ",
      matches: [],
      clampedSelectedIndex: 0,
    })).toBe("Type to search transcript");

    expect(buildTranscriptSearchDetailText({
      isHistorySearchActive: true,
      historySearchQuery: "foo",
      matches: [{ itemId: "a", itemIndex: 0, excerpt: "match excerpt" }],
      clampedSelectedIndex: 0,
    })).toBe("match excerpt");
  });

  it("builds combined transcript search chrome state", () => {
    const model = buildTranscriptSearchChrome({
      isHistorySearchActive: true,
      historySearchQuery: "tool",
      matches: [
        { itemId: "item-1", itemIndex: 0, excerpt: "tool match" },
        { itemId: "item-2", itemIndex: 1, excerpt: "second match" },
      ],
      selectedIndex: -1,
      anchorItemId: "item-1",
      useOverlaySurface: false,
    });

    expect(model.clampedSelectedIndex).toBe(-1);
    expect(model.statusText).toBe("2 transcript matches");
    expect(model.detailText).toBe("2 matches | use n/N or Enter to jump");
    expect(model.searchState.query).toBe("tool");
    expect(model.searchState.matches).toHaveLength(2);
  });
});
