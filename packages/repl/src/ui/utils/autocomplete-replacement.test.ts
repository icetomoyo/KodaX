import { describe, expect, it } from "vitest";
import { buildAutocompleteReplacement } from "./autocomplete-replacement.js";

describe("buildAutocompleteReplacement", () => {
  it("preserves trailing text for slash commands", () => {
    expect(
      buildAutocompleteReplacement("please /he world", 10, {
        text: "/help",
        type: "command",
      })
    ).toEqual({
      start: 7,
      end: 10,
      replacement: "/help",
    });
  });

  it("preserves trailing text for file mentions", () => {
    expect(
      buildAutocompleteReplacement("look @sr today", 8, {
        text: "@src/",
        type: "file",
      })
    ).toEqual({
      start: 5,
      end: 8,
      replacement: "@src/",
    });
  });

  it("replaces only the active argument token", () => {
    expect(
      buildAutocompleteReplacement("/model anth rest", 11, {
        text: "anthropic/claude",
        type: "argument",
      })
    ).toEqual({
      start: 7,
      end: 11,
      replacement: "anthropic/claude",
    });
  });
});
