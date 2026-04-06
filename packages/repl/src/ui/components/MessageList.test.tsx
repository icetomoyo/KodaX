import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { MessageList } from "./MessageList.js";
import { buildTranscriptRenderModel } from "../utils/transcript-layout.js";
import { Box, Text } from "../tui.js";

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

  it("reserves viewport rows for windowed transcript content so footer chrome stays at the bottom", () => {
    const { lastFrame } = render(
      <Box flexDirection="column">
        <MessageList
          items={[
            {
              id: "info-1",
              type: "info",
              timestamp: 1,
              text: "Only row",
            },
          ]}
          windowed
          viewportRows={4}
          viewportWidth={80}
        />
        <Text>FOOTER</Text>
      </Box>,
    );

    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    const rowIndex = lines.findIndex((line) => line.includes("Only row"));
    const footerIndex = lines.findIndex((line) => line.includes("FOOTER"));

    expect(rowIndex).toBeGreaterThanOrEqual(0);
    expect(footerIndex).toBeGreaterThan(rowIndex + 2);
  });
});
