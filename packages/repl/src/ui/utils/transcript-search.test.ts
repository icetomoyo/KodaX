import { describe, expect, it } from "vitest";
import { ToolCallStatus, type HistoryItem } from "../types.js";
import {
  buildTranscriptSearchSummary,
  buildTranscriptSelectionSummary,
  buildTranscriptCopyText,
  buildTranscriptToolInputCopyText,
  createTranscriptSearchIndex,
  getSelectableTranscriptItemIds,
  moveTranscriptSelection,
  resolveTranscriptSearchMatchIndex,
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

  it("resolves the nearest search match from an anchor item", () => {
    const index = createTranscriptSearchIndex([
      ...items,
      { id: "assistant-2", type: "assistant", text: "planner fallback", timestamp: Date.now() },
    ]);
    const matches = searchTranscriptIndex(index, "planner");

    expect(resolveTranscriptSearchMatchIndex(index, matches, "assistant-1")).toBe(1);
    expect(resolveTranscriptSearchMatchIndex(index, matches, "info-1")).toBe(2);
  });

  it("moves transcript selection through selectable item ids", () => {
    const ids = getSelectableTranscriptItemIds(items);

    expect(moveTranscriptSelection(ids, "user-1", "next")).toBe("assistant-1");
    expect(moveTranscriptSelection(ids, "assistant-1", "prev")).toBe("user-1");
  });

  it("builds copy text for a transcript item", () => {
    expect(buildTranscriptCopyText(items[1])).toContain("Planner is active");
  });

  it("builds a compact selection summary and copies selected tool input", () => {
    const toolItem: HistoryItem = {
      id: "tool-1",
      type: "tool_group",
      timestamp: Date.now(),
      tools: [
        {
          id: "tool-call-1",
          name: "changed_diff",
          status: ToolCallStatus.Success,
          startTime: Date.now(),
          input: { path: "packages/repl/src/ui/InkREPL.tsx", offset: 10, limit: 20 },
        },
      ],
    };

    expect(buildTranscriptSelectionSummary(toolItem)).toEqual({
      summary: "Tool call: changed_diff",
      kindLabel: "tool",
    });
    expect(buildTranscriptToolInputCopyText(toolItem)).toContain("\"path\": \"packages/repl/src/ui/InkREPL.tsx\"");
  });

  it("steps transcript matches cyclically and summarizes the current match", () => {
    const matches = searchTranscriptItems(items, "planner");

    expect(stepTranscriptSearchMatch(matches.length, 0, "next")).toBe(1);
    expect(stepTranscriptSearchMatch(matches.length, 1, "next")).toBe(0);
    expect(stepTranscriptSearchMatch(matches.length, 0, "prev")).toBe(1);
    expect(buildTranscriptSearchSummary(matches, 1)).toBe("2/2 transcript matches");
  });
});
