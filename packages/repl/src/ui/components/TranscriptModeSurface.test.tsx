import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { TranscriptModeSurface } from "./TranscriptModeSurface.js";

describe("TranscriptModeSurface", () => {
  it("renders transcript rows without legacy viewport chrome", () => {
    const { lastFrame } = render(
      <TranscriptModeSurface
        items={[
          {
            id: "assistant-1",
            type: "assistant",
            timestamp: 1,
            text: "Detailed transcript answer",
          },
        ]}
        viewportRows={10}
        viewportWidth={80}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Detailed transcript answer");
    expect(frame).not.toContain("Transcript Mode");
    expect(frame).not.toContain("Search transcript");
    expect(frame).not.toContain("Wheel/PgUp/PgDn");
  });

  it("uses a controlled viewport in transcript mode even without a renderer window", () => {
    const { lastFrame } = render(
      <TranscriptModeSurface
        items={[
          {
            id: "assistant-1",
            type: "assistant",
            timestamp: 1,
            text: "Older transcript answer",
          },
          {
            id: "assistant-2",
            type: "assistant",
            timestamp: 2,
            text: "Newest transcript answer",
          },
        ]}
        viewportRows={3}
        viewportWidth={80}
        scrollOffset={0}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Newest transcript answer");
    expect(frame).not.toContain("Older transcript answer");
  });
});
