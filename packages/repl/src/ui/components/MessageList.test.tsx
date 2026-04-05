import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { MessageList } from "./MessageList.js";
import { buildTranscriptRenderModel } from "../utils/transcript-layout.js";

describe("MessageList", () => {
  it("uses the renderer-owned window when provided", () => {
    const { lastFrame } = render(
      <MessageList
        items={[
          {
            id: "info-1",
            type: "info",
            timestamp: 1,
            text: "First line",
          },
          {
            id: "info-2",
            type: "info",
            timestamp: 2,
            text: "Second line",
          },
        ]}
        windowed
        scrollOffset={999}
        rendererWindow={{
          start: 2,
          end: 3,
          scrollTop: 0,
          scrollHeight: 4,
          viewportHeight: 1,
          viewportTop: 2,
          pendingDelta: 0,
          sticky: false,
        }}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Second line");
    expect(frame).not.toContain("First line");
  });

  it("renders a prebuilt transcript model without rebuilding owned rows in the component", () => {
    const transcriptModel = buildTranscriptRenderModel({
      items: [
        {
          id: "info-1",
          type: "info",
          timestamp: 1,
          text: "First line",
        },
        {
          id: "info-2",
          type: "info",
          timestamp: 2,
          text: "Second line",
        },
      ],
      viewportWidth: 80,
      windowed: true,
    });

    const { lastFrame } = render(
      <MessageList
        items={[
          {
            id: "info-1",
            type: "info",
            timestamp: 1,
            text: "First line",
          },
          {
            id: "info-2",
            type: "info",
            timestamp: 2,
            text: "Second line",
          },
        ]}
        transcriptModel={transcriptModel}
        visibleRowsOverride={transcriptModel.rows.slice(1)}
        windowed
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Second line");
    expect(frame).not.toContain("First line");
  });
});
