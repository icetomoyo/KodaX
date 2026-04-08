import { describe, expect, it } from "vitest";
import {
  buildTranscriptTextSelection,
  buildTranscriptTextSelectionSummary,
  resolveTranscriptTextColumn,
} from "./transcript-text-selection.js";
import type { TranscriptRow } from "./transcript-layout.js";

const rows: TranscriptRow[] = [
  { key: "row-1", text: "Alpha", itemId: "item-1" },
  { key: "row-2", text: "Beta", itemId: "item-2", indent: 2 },
  { key: "row-3", text: "Gamma", itemId: "item-3", spinner: true },
];

describe("transcript text selection", () => {
  it("maps terminal columns into transcript text columns", () => {
    expect(resolveTranscriptTextColumn(rows[0]!, 1)).toBe(0);
    expect(resolveTranscriptTextColumn(rows[0]!, 4)).toBe(3);
    expect(resolveTranscriptTextColumn(rows[1]!, 3)).toBe(0);
    expect(resolveTranscriptTextColumn(rows[2]!, 3, { animateSpinners: true })).toBe(0);
  });

  it("builds a multi-line text selection from rendered coordinates", () => {
    const selection = buildTranscriptTextSelection(
      rows,
      { rowIndex: 0, column: 3 },
      { rowIndex: 2, column: 6 },
      { animateSpinners: true },
    );

    expect(selection?.text).toBe("pha\nBeta\nGam");
    expect(selection?.rowCount).toBe(3);
    expect(selection?.charCount).toBe(10);
    expect(selection?.rowRanges.get("row-1")).toEqual({ start: 2, end: 5 });
    expect(selection?.rowRanges.get("row-2")).toEqual({ start: 0, end: 4 });
    expect(selection?.rowRanges.get("row-3")).toEqual({ start: 0, end: 3 });
  });

  it("can fall back to selecting a whole row on a collapsed click", () => {
    const selection = buildTranscriptTextSelection(
      rows,
      { rowIndex: 1, column: 4 },
      { rowIndex: 1, column: 4 },
      { selectFullRowOnCollapsed: true },
    );

    expect(selection?.text).toBe("Beta");
    expect(buildTranscriptTextSelectionSummary(selection)).toBe("Selected 4 chars");
  });
});
