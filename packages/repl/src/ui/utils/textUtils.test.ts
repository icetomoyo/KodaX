import { describe, expect, it } from "vitest";
import {
  calculateVisualCursorFromLayout,
  calculateVisualLayout,
  getCharAtCodePoint,
  getCodePointLength,
  getVisualWidth,
  splitAtVisualColumn,
  splitByCodePoints,
} from "./textUtils.js";

describe("textUtils", () => {
  it("segments a long Unicode line without blocking for seconds", () => {
    const expected = Array.from({ length: 30_000 }, () => ["🦊", "中", "文", " "]).flat();
    const text = expected.join("");
    const before = performance.now();
    const actual = splitByCodePoints(text);
    const elapsed = performance.now() - before;
    expect(actual).toEqual(expected);
    expect(elapsed).toBeLessThan(5_000);
  });

  it.each([
    "e\u0301", "👩🏽‍💻", "👨‍👩‍👧‍👦", "🇦🇧🇨🇩🇪", "\r\n",
    "\u1100\u1161\u11a8", "\u0600a", "क्‍क", "a\ud800b\udc00c",
    "e" + "\u0301".repeat(5_000), "🇦".repeat(2_601),
  ])("preserves native grapheme boundaries across long-text windows: %s", sample => {
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    for (const padding of [1023, 2045, 2046, 2047, 2048, 4095]) {
      const text = "x".repeat(padding) + sample + "終";
      const expected = Array.from(segmenter.segment(text), item => item.segment);
      expect(splitByCodePoints(text)).toEqual(expected);
      expect(getCodePointLength(text)).toBe(expected.length);
      expect(getCharAtCodePoint(text, padding)).toBe(expected[padding]);
    }
  });

  it("keeps counting, indexing and display width consistent for long combined text", () => {
    const text = "e\u0301中👩‍💻".repeat(3_000);
    expect(getCodePointLength(text)).toBe(9_000);
    expect(getVisualWidth(text)).toBe(15_000);
    expect(getCharAtCodePoint(text, 8_999)).toBe("👩‍💻");
    expect(getCharAtCodePoint(text, 9_000)).toBe("");
    expect(splitByCodePoints("")).toEqual([]);
  });

  it("keeps wrapped cursor columns relative to the current visual segment", () => {
    const layout = calculateVisualLayout(["abcdefghij"], 5, 0, 7);

    expect(layout.visualLines).toEqual(["abcde", "fghij"]);
    expect(calculateVisualCursorFromLayout(layout, [0, 7])).toEqual([1, 2]);
  });

  it("calculates visual columns correctly for wide characters", () => {
    const layout = calculateVisualLayout(["你好世界"], 4, 0, 1);

    expect(layout.visualLines).toEqual(["你好", "世界"]);
    expect(calculateVisualCursorFromLayout(layout, [0, 1])).toEqual([0, 2]);
  });

  it("splits a visual line using display width instead of string index", () => {
    expect(splitAtVisualColumn("你好世界", 2)).toEqual({
      before: "你",
      current: "好",
      after: "世界",
    });
  });
});
