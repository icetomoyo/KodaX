import { describe, expect, it } from "vitest";
import type { HistoryItem } from "../types.js";
import {
  buildTranscriptSearchSummary,
  buildTranscriptCopyText,
  createTranscriptSearchIndex,
  getSelectableTranscriptItemIds,
  moveTranscriptSelection,
  searchTranscriptIndex,
  searchTranscriptItems,
  stepTranscriptSearchMatch,
} from "./transcript-search.js";

const items: HistoryItem[] = [
  { id: "user-1", type: "user", text: "look at planner", timestamp: Date.now() },
  { id: "assistant-1", type: "assistant", text: "Planner is active", timestamp: Date.now() },
  { id: "info-1", type: "info", text: "queued follow-up", timestamp: Date.now() },
];

describe("transcript-search", () => {
  it("finds transcript items by text query", () => {
    const matches = searchTranscriptItems(items, "planner");

    expect(matches).toHaveLength(2);
    expect(matches.map((match) => match.itemId)).toEqual(["user-1", "assistant-1"]);
  });

  it("reuses a warmed transcript search index", () => {
    const index = createTranscriptSearchIndex(items);
    const matches = searchTranscriptIndex(index, "planner");

    expect(matches).toHaveLength(2);
    expect(matches[0]?.itemId).toBe("user-1");
  });

  it("moves transcript selection through selectable item ids", () => {
    const ids = getSelectableTranscriptItemIds(items);

    expect(moveTranscriptSelection(ids, "user-1", "next")).toBe("assistant-1");
    expect(moveTranscriptSelection(ids, "assistant-1", "prev")).toBe("user-1");
  });

  it("builds copy text for a transcript item", () => {
    expect(buildTranscriptCopyText(items[1])).toContain("Planner is active");
  });

  it("steps transcript matches cyclically and summarizes the current match", () => {
    const matches = searchTranscriptItems(items, "planner");

    expect(stepTranscriptSearchMatch(matches.length, 0, "next")).toBe(1);
    expect(stepTranscriptSearchMatch(matches.length, 1, "next")).toBe(0);
    expect(stepTranscriptSearchMatch(matches.length, 0, "prev")).toBe(1);
    expect(buildTranscriptSearchSummary(matches, 1)).toBe("2/2 transcript matches");
  });
});
