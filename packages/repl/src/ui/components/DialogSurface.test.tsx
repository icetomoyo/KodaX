import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { DialogSurface } from "./DialogSurface.js";

describe("DialogSurface", () => {
  it("renders confirm dialogs", () => {
    const { lastFrame } = render(
      <DialogSurface confirm={{ prompt: "Apply changes?", instruction: "Press y to confirm" }} />,
    );

    const frame = lastFrame();
    expect(frame).toContain("[Confirm]");
    expect(frame).toContain("Apply changes?");
  });

  it("renders history search state", () => {
    const { lastFrame } = render(
      <DialogSurface
        historySearch={{
          query: "planner",
          matches: [{ itemId: "assistant-1", excerpt: "Planner is active" }],
          selectedIndex: 0,
        }}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("[Search]");
    expect(frame).toContain("planner");
    expect(frame).toContain("Planner is active");
  });
});
