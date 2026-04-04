import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { PromptHelpMenu } from "./PromptHelpMenu.js";

describe("PromptHelpMenu", () => {
  it("renders a dedicated help surface from help bar segments", () => {
    const { lastFrame } = render(
      <PromptHelpMenu
        sections={[
          {
            id: "global",
            title: "Global",
            items: [
              { id: "verbosity", label: "Ctrl+O Toggle Transcript Detail" },
              { id: "search", label: "Ctrl+F Search Transcript" },
            ],
          },
          {
            id: "transcript",
            title: "Transcript",
            items: [{ id: "history", label: "PgUp history browse" }],
          },
        ]}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Help");
    expect(frame).toContain("Global");
    expect(frame).toContain("Ctrl+O Toggle Transcript Detail");
    expect(frame).toContain("Ctrl+F Search Transcript");
    expect(frame).toContain("Transcript");
    expect(frame).toContain("PgUp history browse");
  });
});
