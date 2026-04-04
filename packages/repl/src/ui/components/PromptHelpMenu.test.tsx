import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { PromptHelpMenu } from "./PromptHelpMenu.js";

describe("PromptHelpMenu", () => {
  it("renders a dedicated help surface from help bar segments", () => {
    const { lastFrame } = render(
      <PromptHelpMenu
        segments={[
          { text: "Ctrl+O transcript" },
          { text: "  " },
          { text: "Ctrl+F search" },
        ]}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Help");
    expect(frame).toContain("Ctrl+O transcript");
    expect(frame).toContain("Ctrl+F search");
  });
});
