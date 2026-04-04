import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { QueuedCommandsSurface } from "./QueuedCommandsSurface.js";

describe("QueuedCommandsSurface", () => {
  it("renders queued follow-up summary when pending inputs exist", () => {
    const { lastFrame } = render(
      <QueuedCommandsSurface pendingInputs={["check tests too", "verify docs"]} />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Queued 2 follow-ups");
  });

  it("renders nothing when there are no queued prompts", () => {
    const { lastFrame } = render(
      <QueuedCommandsSurface pendingInputs={[]} />,
    );

    expect(lastFrame()).toBe("");
  });
});
