import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { StatusNoticesSurface } from "./StatusNoticesSurface.js";

describe("StatusNoticesSurface", () => {
  it("renders non-empty footer notices", () => {
    const { lastFrame } = render(
      <StatusNoticesSurface notices={["Search: planner", "", "Queued 2 follow-ups"]} />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Search: planner");
    expect(frame).toContain("Queued 2 follow-ups");
  });

  it("renders nothing when all notices are empty", () => {
    const { lastFrame } = render(
      <StatusNoticesSurface notices={["", "   "]} />,
    );

    expect(lastFrame()).toBe("");
  });
});
