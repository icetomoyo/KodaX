import { describe, expect, it } from "vitest";
import {
  calculateVisualCursorFromLayout,
  calculateVisualLayout,
  splitAtVisualColumn,
} from "./textUtils.js";

describe("textUtils", () => {
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
