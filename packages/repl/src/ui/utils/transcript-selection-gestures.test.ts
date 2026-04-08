import { describe, expect, it } from "vitest";
import {
  extendTranscriptSelectionSpan,
  resolveTranscriptMultiClickState,
  resolveTranscriptSelectionSpanAt,
} from "./transcript-selection-gestures.js";

describe("transcript-selection-gestures", () => {
  it("tracks multi-click counts within the configured gesture window", () => {
    const first = resolveTranscriptMultiClickState({
      previous: { time: 0, row: -1, column: -1, count: 0 },
      time: 100,
      row: 10,
      column: 20,
    });
    expect(first.count).toBe(1);

    const second = resolveTranscriptMultiClickState({
      previous: first,
      time: 350,
      row: 10,
      column: 21,
    });
    expect(second.count).toBe(2);

    const third = resolveTranscriptMultiClickState({
      previous: second,
      time: 500,
      row: 11,
      column: 21,
    });
    expect(third.count).toBe(3);
  });

  it("resets multi-click count after a timeout or distant press", () => {
    const previous = { time: 100, row: 10, column: 20, count: 2 };

    expect(resolveTranscriptMultiClickState({
      previous,
      time: 700,
      row: 10,
      column: 20,
    }).count).toBe(1);

    expect(resolveTranscriptMultiClickState({
      previous,
      time: 200,
      row: 20,
      column: 20,
    }).count).toBe(1);
  });

  it("resolves word spans around the clicked cell", () => {
    const rows = [
      { key: "row-1", text: "run npm test" },
      { key: "row-2", text: "hello-world.ts" },
    ];

    const word = resolveTranscriptSelectionSpanAt(rows, {
      rowKey: "row-2",
      modelRowIndex: 1,
      column: 6,
    }, "word");

    expect(word).toEqual({
      kind: "word",
      start: { rowKey: "row-2", modelRowIndex: 1, column: 0 },
      end: { rowKey: "row-2", modelRowIndex: 1, column: 14 },
    });
  });

  it("resolves full-line spans", () => {
    const rows = [
      { key: "row-1", text: "line one" },
    ];

    const line = resolveTranscriptSelectionSpanAt(rows, {
      rowKey: "row-1",
      modelRowIndex: 0,
      column: 3,
    }, "line");

    expect(line).toEqual({
      kind: "line",
      start: { rowKey: "row-1", modelRowIndex: 0, column: 0 },
      end: { rowKey: "row-1", modelRowIndex: 0, column: 8 },
    });
  });

  it("extends word/line selection spans in reading order", () => {
    const anchorSpan = {
      kind: "word" as const,
      start: { rowKey: "row-2", modelRowIndex: 1, column: 5 },
      end: { rowKey: "row-2", modelRowIndex: 1, column: 10 },
    };

    expect(extendTranscriptSelectionSpan(anchorSpan, {
      kind: "word",
      start: { rowKey: "row-3", modelRowIndex: 2, column: 1 },
      end: { rowKey: "row-3", modelRowIndex: 2, column: 4 },
    })).toEqual({
      anchor: anchorSpan.start,
      focus: { rowKey: "row-3", modelRowIndex: 2, column: 4 },
    });

    expect(extendTranscriptSelectionSpan(anchorSpan, {
      kind: "word",
      start: { rowKey: "row-1", modelRowIndex: 0, column: 1 },
      end: { rowKey: "row-1", modelRowIndex: 0, column: 4 },
    })).toEqual({
      anchor: anchorSpan.end,
      focus: { rowKey: "row-1", modelRowIndex: 0, column: 1 },
    });
  });
});
