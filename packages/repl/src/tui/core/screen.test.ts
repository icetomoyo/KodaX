import { describe, expect, it } from "vitest";
import { buildTranscriptRowIndexByKey, buildTranscriptScreenBuffer } from "./screen.js";

describe("transcript screen buffer", () => {
  it("builds screen rows with stable absolute indices", () => {
    const allRows = [
      { key: "row-1", text: "alpha" },
      { key: "row-2", text: "beta", indent: 2 },
      { key: "row-3", text: "gamma", spinner: true },
    ];

    const buffer = buildTranscriptScreenBuffer(allRows.slice(1), {
      allRows,
      rowIndexByKey: buildTranscriptRowIndexByKey(allRows),
      topOffsetRows: 2,
      animateSpinners: true,
    });

    expect(buffer.topRow).toBe(3);
    expect(buffer.bottomRow).toBe(4);
    expect(buffer.rows[0]).toMatchObject({
      key: "row-2",
      modelRowIndex: 1,
      screenRow: 3,
      textStartColumn: 3,
    });
    expect(buffer.rows[1]).toMatchObject({
      key: "row-3",
      modelRowIndex: 2,
      screenRow: 4,
      textStartColumn: 3,
    });
  });

  it("tracks transcript row display width using rendered cell width, not UTF-16 length", () => {
    const buffer = buildTranscriptScreenBuffer([
      { key: "row-cjk", text: "浣犲ソA" },
    ]);

    expect(buffer.rows[0]).toMatchObject({
      key: "row-cjk",
      textLength: 3,
      textStartColumn: 1,
      textEndColumn: 6,
    });
  });

  it("keeps absolute indices aligned when visible rows include trailing preview rows", () => {
    const allRows = [
      { key: "stable-1", text: "prompt" },
      { key: "stable-2", text: "previous answer" },
      { key: "preview-thinking", text: "Thinking" },
      { key: "preview-assistant", text: "Partial answer" },
    ];

    const renderedRows = allRows.slice(1);
    const buffer = buildTranscriptScreenBuffer(renderedRows, {
      allRows,
      rowIndexByKey: buildTranscriptRowIndexByKey(allRows),
      topOffsetRows: 1,
      animateSpinners: false,
    });

    expect(buffer.rows.map((row) => row.modelRowIndex)).toEqual([1, 2, 3]);
    expect(buffer.rows.map((row) => row.key)).toEqual([
      "stable-2",
      "preview-thinking",
      "preview-assistant",
    ]);
    expect(buffer.rows.map((row) => row.screenRow)).toEqual([2, 3, 4]);
  });
});
