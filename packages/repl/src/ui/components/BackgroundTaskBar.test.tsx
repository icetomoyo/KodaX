import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { BackgroundTaskBar } from "./BackgroundTaskBar.js";

describe("BackgroundTaskBar", () => {
  it("renders task pills for primary and parallel work", () => {
    const { lastFrame } = render(
      <BackgroundTaskBar
        items={[
          { id: "planner", label: "Planner active", accent: true, selected: true },
          { id: "parallel", label: "Parallel evidence pass (2)" },
        ]}
        ctaHint="PgUp history"
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Planner active");
    expect(frame).toContain("Parallel evidence pass (2)");
    expect(frame).toContain("PgUp history");
  });

  it("renders a spinner when live work is active outside the transcript lane", () => {
    const { lastFrame } = render(
      <BackgroundTaskBar
        items={[{ id: "worker", label: "Planner active", accent: true, selected: true }]}
        showSpinner
      />,
    );

    expect(lastFrame()).toContain("⠋");
    expect(lastFrame()).toContain("Planner active");
  });

  it("stays hidden when there is no summary content to show", () => {
    const { lastFrame } = render(
      <BackgroundTaskBar items={[]} />,
    );

    expect(lastFrame()).toBe("");
  });
});
