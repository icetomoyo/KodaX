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

  it("prefers renderer viewport semantics over stale start/end bounds", () => {
    const firstRow = { key: "row-1", text: "First line", itemId: "info-1" };
    const secondRow = { key: "row-2", text: "Second line", itemId: "info-2" };
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
        transcriptModel={{
          staticSections: [],
          sections: [
            { key: "info-1", rows: [firstRow] },
            { key: "info-2", rows: [secondRow] },
          ],
          rows: [firstRow, secondRow],
          previewSections: [],
          previewRows: [],
        }}
        windowed
        rendererWindow={{
          start: 0,
          end: 1,
          scrollTop: 0,
          scrollHeight: 2,
          viewportHeight: 1,
          viewportTop: 1,
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

  it("does not inject filler rows for windowed transcript content without a renderer window", () => {
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
    expect(footerIndex).toBeGreaterThanOrEqual(rowIndex + 1);
    expect(footerIndex).toBeLessThanOrEqual(rowIndex + 2);
  });

  it("keeps renderer-window transcript output tight without synthetic filler rows", () => {
    const { lastFrame } = render(
      <Box flexDirection="column">
        <MessageList
          items={[
            {
              id: "info-1",
              type: "info",
              timestamp: 1,
              text: "Row 1",
            },
            {
              id: "info-2",
              type: "info",
              timestamp: 2,
              text: "Row 2",
            },
          ]}
          windowed
          viewportRows={8}
          rendererWindow={{
            start: 0,
            end: 2,
            scrollTop: 0,
            scrollHeight: 2,
            viewportHeight: 2,
            viewportTop: 0,
            pendingDelta: 0,
            sticky: true,
          }}
        />
        <Text>FOOTER</Text>
      </Box>,
    );

    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    const footerIndex = lines.findIndex((line) => line.includes("FOOTER"));

    expect(footerIndex).toBeGreaterThanOrEqual(2);
    expect(footerIndex).toBeLessThanOrEqual(2);
  });

  it("renders transcript text selections using grapheme-aware ranges", () => {
    const row = { key: "assistant-1-body-0", text: "浣犲ソA", itemId: "assistant-1" };
    const { lastFrame } = render(
      <MessageList
        items={[
          {
            id: "assistant-1",
            type: "assistant",
            timestamp: 1,
            text: "浣犲ソA",
          },
        ]}
        transcriptModel={{
          staticSections: [],
          sections: [
            {
              key: "assistant-1",
              rows: [row],
            },
          ],
          rows: [row],
          previewSections: [],
          previewRows: [],
        }}
        visibleRowsOverride={[row]}
        selectedTextRanges={new Map([
          ["assistant-1-body-0", { start: 1, end: 2 }],
        ])}
        windowed
      />,
    );

    expect(lastFrame()).toContain("浣犲ソA");
  });
  it("does not duplicate preview rows when a renderer-owned visible window is supplied", () => {
    const previewRow = { key: "streaming-body-0", text: "Preview row", itemId: "assistant-live" };
    const { lastFrame } = render(
      <MessageList
        items={[]}
        isLoading
        transcriptModel={{
          staticSections: [],
          sections: [],
          rows: [],
          previewSections: [
            {
              key: "preview",
              rows: [previewRow],
            },
          ],
          previewRows: [previewRow],
        }}
        visibleRowsOverride={[previewRow]}
        windowed
      />,
    );

    const frame = lastFrame() ?? "";
    expect((frame.match(/Preview row/g) ?? [])).toHaveLength(1);
  });

  it("derives renderer-owned visible rows from the shared transcript model", () => {
    const snapshot: { rows: string[]; allRows: string[] }[] = [];
    const stableRow = { key: "stable-0", text: "Stable row", itemId: "assistant-1" };
    const previewRow = { key: "preview-0", text: "Preview row", itemId: "assistant-live" };

    render(
      <MessageList
        items={[]}
        transcriptModel={{
          staticSections: [],
          sections: [{ key: "stable", rows: [stableRow] }],
          rows: [stableRow],
          previewSections: [{ key: "preview", rows: [previewRow] }],
          previewRows: [previewRow],
        }}
        windowed
        rendererWindow={{
          start: 1,
          end: 2,
          scrollTop: 0,
          scrollHeight: 2,
          viewportHeight: 1,
          viewportTop: 1,
          pendingDelta: 0,
          sticky: false,
        }}
        onVisibleRowsChange={(next) => {
          snapshot.push({
            rows: next.rows.map((row) => row.key),
            allRows: next.allRows.map((row) => row.key),
          });
        }}
      />,
    );

    expect(snapshot.at(-1)).toEqual({
      rows: ["preview-0"],
      allRows: ["stable-0", "preview-0"],
    });
  });
});
