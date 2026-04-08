import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { TranscriptModeSurface } from "./TranscriptModeSurface.js";
import { ToolCallStatus } from "../types.js";

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

  it("uses a controlled viewport only when the transcript surface is explicitly windowed", () => {
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
        windowed
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Newest transcript answer");
    expect(frame).not.toContain("Older transcript answer");
  });

  it("renders detailed tool output when show-all is active", () => {
    const { lastFrame } = render(
      <TranscriptModeSurface
        items={[
          {
            id: "tool-group-1",
            type: "tool_group",
            timestamp: 1,
            tools: [
              {
                id: "tool-1",
                name: "changed_diff",
                status: ToolCallStatus.Success,
                startTime: 1,
                endTime: 2,
                input: {
                  path: "packages/repl/src/ui/InkREPL.tsx",
                },
                output: "Showing diff lines 1-10",
              },
            ],
          },
        ]}
        viewportRows={12}
        viewportWidth={100}
        showDetailedTools
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("input:");
    expect(frame).toContain("Showing diff lines 1-10");
  });
});
