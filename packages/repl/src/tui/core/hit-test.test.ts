import { describe, expect, it } from "vitest";
import { buildTranscriptScreenBuffer } from "./screen.js";
import { clampTranscriptScreenHit, hitTestTranscriptScreen } from "./hit-test.js";

describe("transcript hit test", () => {
  const buffer = buildTranscriptScreenBuffer([
    { key: "row-1", text: "alpha" },
    { key: "row-2", text: "beta", indent: 2 },
  ], {
    topOffsetRows: 1,
  });

  it("maps terminal coordinates onto transcript screen points", () => {
    const hit = hitTestTranscriptScreen(buffer, 2, 4);
    expect(hit?.point).toEqual({
      rowKey: "row-1",
      modelRowIndex: 0,
      column: 3,
    });
  });

  it("clamps off-viewport rows to the nearest visible transcript row", () => {
    expect(clampTranscriptScreenHit(buffer, 1, 1)?.point.rowKey).toBe("row-1");
    expect(clampTranscriptScreenHit(buffer, 10, 1)?.point.rowKey).toBe("row-2");
  });

  it("maps wide-character cells onto grapheme indices instead of UTF-16 columns", () => {
    const wideBuffer = buildTranscriptScreenBuffer([
      { key: "row-cjk", text: "你好A" },
    ]);

    expect(hitTestTranscriptScreen(wideBuffer, 1, 1)?.point.column).toBe(0);
    expect(hitTestTranscriptScreen(wideBuffer, 1, 2)?.point.column).toBe(0);
    expect(hitTestTranscriptScreen(wideBuffer, 1, 3)?.point.column).toBe(1);
    expect(hitTestTranscriptScreen(wideBuffer, 1, 5)?.point.column).toBe(2);
    expect(hitTestTranscriptScreen(wideBuffer, 1, 6)?.point.column).toBe(3);
  });
});
