import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { BackgroundTaskBar } from "./BackgroundTaskBar.js";

describe("BackgroundTaskBar", () => {
  it("renders task pills for primary and parallel work", () => {
    const { lastFrame } = render(
      <BackgroundTaskBar primaryText="Planner active" parallelText="Parallel evidence pass (2)" />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Planner active");
    expect(frame).toContain("Parallel evidence pass (2)");
  });
});
