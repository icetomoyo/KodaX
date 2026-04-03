import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { PromptSuggestionsSurface } from "./PromptSuggestionsSurface.js";

describe("PromptSuggestionsSurface", () => {
  it("reserves inline space without an autocomplete provider", () => {
    const { lastFrame } = render(
      <PromptSuggestionsSurface reserveSpace width={80} />,
    );

    expect(lastFrame()).toBeTruthy();
  });

  it("hides itself when requested", () => {
    const { lastFrame } = render(
      <PromptSuggestionsSurface reserveSpace width={80} hidden />,
    );

    expect(lastFrame()).toBe("");
  });
});
