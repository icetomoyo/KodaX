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
        showFullThinking
        showDetailedTools
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Detailed transcript answer");
    expect(frame).not.toContain("Transcript Mode");
    expect(frame).not.toContain("Search transcript");
    expect(frame).not.toContain("Wheel/PgUp/PgDn");
  });
});
