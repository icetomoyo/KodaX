import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { PromptTranscriptSurface } from "./PromptTranscriptSurface.js";

describe("PromptTranscriptSurface", () => {
  it("renders prompt transcript rows without transcript-mode chrome", () => {
    const { lastFrame } = render(
      <PromptTranscriptSurface
        items={[
          {
            id: "assistant-1",
            type: "assistant",
            timestamp: 1,
            text: "Latest answer",
          },
        ]}
        viewportRows={10}
        viewportWidth={80}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Latest answer");
    expect(frame).not.toContain("Transcript Mode");
    expect(frame).not.toContain("Search transcript");
  });
});
