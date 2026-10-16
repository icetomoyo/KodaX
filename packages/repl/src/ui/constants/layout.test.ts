import { describe, expect, it } from "vitest";
import { buildHelpBarSegments, buildHelpBarText, buildHelpMenuSections } from "./layout.js";

describe("help bar layout", () => {
  it("omits the retired mode toggle while retaining editing help", () => {
    const helpText = buildHelpBarText();
    const helpSegments = buildHelpBarSegments();
    expect(helpText).not.toContain("Alt+M");
    expect(helpSegments.some((segment) => segment.text.includes("AMA/SA"))).toBe(false);
    expect(helpText).not.toContain("AMAW");
    expect(helpText).toContain("Ctrl+W/K/U edit");
  });

  it("keeps the help menu focused on high-signal shortcuts", () => {
    const helpSections = buildHelpMenuSections();
    const editingSection = helpSections.find((section) => section.id === "editing");
    const flattenedLabels = helpSections.flatMap((section) => section.items.map((item) => item.label));

    expect(editingSection?.items.some((item) => item.label.includes("Ctrl+K"))).toBe(true);
    expect(flattenedLabels.some((label) => label === "Backspace Backspace")).toBe(false);
    expect(flattenedLabels.some((label) => label === "Delete Delete")).toBe(false);
    expect(flattenedLabels.some((label) => label === "Left Move Left")).toBe(false);
    expect(flattenedLabels.some((label) => label === "Right Move Right")).toBe(false);
  });
});
