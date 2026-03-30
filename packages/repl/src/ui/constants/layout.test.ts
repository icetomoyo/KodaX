import { describe, expect, it } from "vitest";
import { buildHelpBarSegments, buildHelpBarText } from "./layout.js";

describe("help bar layout", () => {
  it("includes the SA/AMA toggle shortcut in the help bar", () => {
    const helpText = buildHelpBarText();
    const helpSegments = buildHelpBarSegments();
    expect(helpText).toContain("Alt+M AMA/SA");
    expect(helpSegments.some((segment) => segment.text === "Alt+M AMA/SA")).toBe(true);
  });
});
