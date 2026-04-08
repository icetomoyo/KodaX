import { describe, expect, it } from "vitest";
import { buildTranscriptScreenSelection, buildTranscriptScreenSelectionSummary } from "./selection.js";

describe("transcript screen selection", () => {
  const rows = [
    { key: "row-1", text: "Alpha" },
    { key: "row-2", text: "Beta" },
    { key: "row-3", text: "Gamma" },
  ];

  it("builds multi-line selections using absolute row indices", () => {
    const selection = buildTranscriptScreenSelection(
      rows,
      { rowKey: "row-1", modelRowIndex: 0, column: 2 },
      { rowKey: "row-3", modelRowIndex: 2, column: 3 },
    );

    expect(selection?.text).toBe("pha\nBeta\nGam");
    expect(selection?.rowRanges.get("row-1")).toEqual({ start: 2, end: 5 });
    expect(selection?.rowRanges.get("row-2")).toEqual({ start: 0, end: 4 });
    expect(selection?.rowRanges.get("row-3")).toEqual({ start: 0, end: 3 });
    expect(buildTranscriptScreenSelectionSummary(selection)).toBe("Selected 10 chars across 3 lines");
  });

  it("does not convert a click into a whole-row copy by default", () => {
    const selection = buildTranscriptScreenSelection(
      rows,
      { rowKey: "row-2", modelRowIndex: 1, column: 1 },
      { rowKey: "row-2", modelRowIndex: 1, column: 1 },
    );

    expect(selection).toBeUndefined();
  });
});
