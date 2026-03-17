import { describe, expect, it } from "vitest";
import { ToolCallStatus, type HistoryItem } from "../types.js";
import {
  buildDynamicTranscriptSection,
  buildHistoryItemTranscriptSections,
  buildTranscriptRows,
  buildStaticTranscriptSections,
  capHistoryByTranscriptRows,
  flattenTranscriptSections,
  getVisibleTranscriptRows,
  sliceHistoryToRecentRounds,
} from "./transcript-layout.js";

function assistant(text: string): HistoryItem {
  return {
    id: "assistant-1",
    type: "assistant",
    text,
    timestamp: Date.now(),
  };
}

function user(id: string, text: string): HistoryItem {
  return {
    id,
    type: "user",
    text,
    timestamp: Date.now(),
  };
}

describe("transcript-layout", () => {
  it("preserves the final assistant line without a trailing newline", () => {
    const rows = buildTranscriptRows({
      items: [assistant("## Verify\n\n```bash\nmysql -h 127.0.0.1 -P 13306\n```\n\nFinal line must stay visible")],
      viewportWidth: 80,
    });

    expect(rows.some((row) => row.text.includes("Final line must stay visible"))).toBe(true);
  });

  it("keeps the latest rows when slicing a transcript viewport", () => {
    const rows = buildTranscriptRows({
      items: [assistant(["one", "two", "three", "four", "five", "tail line"].join("\n"))],
      viewportWidth: 80,
    });

    const visible = getVisibleTranscriptRows(rows, 3);
    const text = visible.map((row) => row.text).join("\n");

    expect(text).toContain("tail line");
    expect(text).not.toContain("one");
  });

  it("supports scrolling upward from the bottom with an explicit offset", () => {
    const rows = buildTranscriptRows({
      items: [assistant(["one", "two", "three", "four", "five", "tail line"].join("\n"))],
      viewportWidth: 80,
    });

    const visible = getVisibleTranscriptRows(rows, 3, 3);
    const text = visible.map((row) => row.text).join("\n");

    expect(text).toContain("three");
    expect(text).not.toContain("tail line");
  });

  it("includes streaming and loading rows in a single transcript", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 60,
      isLoading: true,
      isThinking: true,
      thinkingCharCount: 42,
      thinkingContent: "thinking details",
      streamingResponse: "partial response",
      currentIteration: 2,
      iterationHistory: [
        {
          iteration: 1,
          thinkingSummary: "summary",
          thinkingLength: 120,
          response: "response snippet",
          toolsUsed: ["read_file"],
        },
      ],
      currentTool: "read_file",
      toolInputCharCount: 12,
      toolInputContent: "path/to/file",
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("Round 1");
    expect(text).toContain("thinking details");
    expect(text).toContain("partial response");
    expect(text).toContain("read_file");
  });

  it("shows thinking char counts while the model is still thinking", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 60,
      isLoading: true,
      isThinking: true,
      thinkingCharCount: 42,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("(42 chars)...");
  });

  it("formats tool rows with progress and errors", () => {
    const rows = buildTranscriptRows({
      items: [
        {
          id: "tool-group-1",
          type: "tool_group",
          timestamp: Date.now(),
          tools: [
            {
              id: "tool-1",
              name: "write_file",
              status: ToolCallStatus.Executing,
              startTime: Date.now(),
              progress: 50,
              error: "denied",
            },
          ],
        },
      ],
      viewportWidth: 80,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("write_file");
    expect(text).toContain("Progress: 50%");
    expect(text).toContain("denied");
  });

  it("builds transcript sections that preserve row order when flattened", () => {
    const staticSections = buildStaticTranscriptSections(
      [
        {
          id: "user-1",
          type: "user",
          text: "prompt",
          timestamp: Date.now(),
        },
      ],
      80
    );
    const activeSection = buildDynamicTranscriptSection("active", {
      items: [assistant("answer")],
      viewportWidth: 80,
    });

    const rows = flattenTranscriptSections([...staticSections, activeSection]);
    const text = rows.map((row) => row.text).join("\n");

    expect(staticSections).toHaveLength(1);
    expect(activeSection.rows.length).toBeGreaterThan(0);
    expect(text.indexOf("prompt")).toBeLessThan(text.indexOf("answer"));
  });

  it("creates one transcript section per history item", () => {
    const sections = buildHistoryItemTranscriptSections(
      [
        {
          id: "user-1",
          type: "user",
          text: "prompt",
          timestamp: Date.now(),
        },
        {
          id: "assistant-1",
          type: "assistant",
          text: "answer",
          timestamp: Date.now(),
        },
      ],
      80
    );

    expect(sections).toHaveLength(2);
    expect(sections[0]?.key).toBe("user-1");
    expect(sections[1]?.key).toBe("assistant-1");
    expect(sections[0]?.rows.some((row) => row.text.includes("prompt"))).toBe(true);
    expect(sections[1]?.rows.some((row) => row.text.includes("answer"))).toBe(true);
  });

  it("keeps only the most recent user-defined rounds", () => {
    const items: HistoryItem[] = [
      user("user-1", "round 1"),
      assistant("answer 1"),
      user("user-2", "round 2"),
      assistant("answer 2"),
      user("user-3", "round 3"),
      assistant("answer 3"),
    ];

    const visible = sliceHistoryToRecentRounds(items, 2);
    const text = visible.map((item) => ("text" in item ? item.text : "")).join("\n");

    expect(text).toContain("round 2");
    expect(text).toContain("round 3");
    expect(text).not.toContain("round 1");
  });

  it("caps review history by transcript row budget", () => {
    const items: HistoryItem[] = [
      assistant(["line 1", "line 2", "line 3"].join("\n")),
      assistant(["line 4", "line 5", "line 6"].join("\n")),
      assistant(["line 7", "line 8", "tail"].join("\n")),
    ];

    const visible = capHistoryByTranscriptRows(items, 80, 8);
    const text = visible.map((item) => ("text" in item ? item.text : "")).join("\n");

    expect(text).toContain("tail");
    expect(text).not.toContain("line 1");
  });
});
