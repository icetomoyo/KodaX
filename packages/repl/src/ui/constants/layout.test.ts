import { describe, expect, it } from "vitest";
import { HELP_BAR_SEGMENTS, HELP_BAR_TEXT } from "./layout.js";

describe("help bar layout", () => {
  it("includes the SA/AMA toggle shortcut in the help bar", () => {
    expect(HELP_BAR_TEXT).toContain("Alt+M AMA/SA");
    expect(HELP_BAR_SEGMENTS.some((segment) => segment.text === "Alt+M AMA/SA")).toBe(true);
  });
});
