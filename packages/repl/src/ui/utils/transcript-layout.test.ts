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

function info(id: string, text: string, icon = "\u23F3"): HistoryItem {
  return {
    id,
    type: "info",
    text,
    icon,
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

  it("renders info items in a compact single-line-first format", () => {
    const rows = buildTranscriptRows({
      items: [info("info-1", "Stream stalled · retry 1/3 in 2s")],
      viewportWidth: 80,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("\u23F3 Stream stalled · retry 1/3 in 2s");
    expect(text).not.toContain("Info");
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
    expect(text).toContain("* tools: read_file");
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
    expect(text).toContain("[Thinking] 42 chars...");
  });

  it("truncates live thinking to a 400 character preview", () => {
    const thinking = "A".repeat(450);
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 80,
      isLoading: true,
      isThinking: true,
      thinkingContent: thinking,
      thinkingCharCount: thinking.length,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("thinking truncated in live view");
    expect(text).not.toContain("A".repeat(430));
  });

  it("shows full thinking in review mode", () => {
    const thinking = "B".repeat(450);
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 80,
      isLoading: true,
      isThinking: true,
      thinkingContent: thinking,
      thinkingCharCount: thinking.length,
      showFullThinking: true,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text.replace(/\n/g, "")).toContain("B".repeat(430));
    expect(text).not.toContain("thinking truncated in live view");
  });

  it("shows AMA harness level and active worker in the live thinking row", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 80,
      isLoading: true,
      isThinking: true,
      thinkingCharCount: 42,
      managedAgentMode: "ama",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Planner",
      managedRound: 2,
      managedMaxRounds: 6,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[AMA H2 - Planner] 42 chars round 2/6...");
  });

  it("uses a neutral Scout prefix during preflight instead of leaking the final harness", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 80,
      isLoading: true,
      isThinking: true,
      thinkingCharCount: 42,
      managedAgentMode: "ama",
      managedPhase: "preflight",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Scout",
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[AMA Scout] 42 chars...");
    expect(text).not.toContain("[AMA H2");
  });

  it("uses a neutral routing prefix before Scout confirms the final harness", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 100,
      isLoading: true,
      currentTool: "changed_scope",
      managedAgentMode: "ama",
      managedPhase: "routing",
      managedHarnessProfile: "H1_EXECUTE_EVAL",
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[AMA Routing] [Tools] changed_scope...");
    expect(text).not.toContain("[AMA H1");
  });

  it("does not leak round 1/2 in the initial AMA live thinking row", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 80,
      isLoading: true,
      isThinking: true,
      thinkingCharCount: 42,
      managedAgentMode: "ama",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Planner",
      managedRound: 1,
      managedMaxRounds: 2,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[AMA H2 - Planner] 42 chars...");
    expect(text).not.toContain("round 1/2");
  });

  it("falls back to the last live activity label when thinking has no visible chars yet", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 80,
      isLoading: true,
      isThinking: true,
      lastLiveActivityLabel: "[Planner] changed_diff_bundle",
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[Thinking] [Planner] changed_diff_bundle...");
  });

  it("shows AMA harness level and active worker in the live tool row", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 80,
      isLoading: true,
      currentTool: "changed_diff",
      toolInputCharCount: 18,
      managedAgentMode: "ama",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Planner",
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[AMA H2 - Planner] [Tools] changed_diff (18 chars)...");
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
    expect(text).toContain("write_file (50%)");
    expect(text).toContain("denied");
  });

  it("formats tool summaries from structured preview text in tool groups", () => {
    const rows = buildTranscriptRows({
      items: [
        {
          id: "tool-group-2",
          type: "tool_group",
          timestamp: Date.now(),
          tools: [
            {
              id: "tool-2",
              name: "[Planner] changed_diff_bundle",
              status: ToolCallStatus.Success,
              startTime: Date.now(),
              endTime: Date.now() + 10,
              input: {
                preview: "{\"paths\":[\"packages/coding/src/task-engine.ts\"],\"limit_per_path\":120}",
              },
            },
          ],
        },
      ],
      viewportWidth: 100,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[Planner] changed_diff_bundle");
    expect(text).toContain("packages/coding/src/task-engine.ts");
    expect(text).toContain("limit=120");
    expect(text).toContain("(10ms)");
  });

  it("shows detailed tool output only when review mode is enabled", () => {
    const baseTool = {
      id: "tool-3",
      name: "[Lead] changed_diff",
      status: ToolCallStatus.Success,
      startTime: Date.now(),
      endTime: Date.now() + 10,
      input: {
        preview: "{\"path\":\"packages/coding/src/task-engine.ts\",\"offset\":1171,\"limit\":120}",
      },
      output: "Changed diff for packages/coding/src/task-engine.ts\nShowing diff lines 1171-1320 of 3096\n+ const example = true;",
    };

    const normalRows = buildTranscriptRows({
      items: [
        {
          id: "tool-group-3",
          type: "tool_group",
          timestamp: Date.now(),
          tools: [baseTool],
        },
      ],
      viewportWidth: 100,
    });

    const reviewRows = buildTranscriptRows({
      items: [
        {
          id: "tool-group-4",
          type: "tool_group",
          timestamp: Date.now(),
          tools: [baseTool],
        },
      ],
      viewportWidth: 100,
      showDetailedTools: true,
    });

    expect(normalRows.map((row) => row.text).join("\n")).not.toContain("Showing diff lines 1171-1320 of 3096");
    expect(reviewRows.map((row) => row.text).join("\n")).toContain("Showing diff lines 1171-1320 of 3096");
  });

  it("shows detailed tool input previews when the transcript is expanded", () => {
    const rows = buildTranscriptRows({
      items: [
        {
          id: "tool-group-input",
          type: "tool_group",
          timestamp: Date.now(),
          tools: [
            {
              id: "tool-input-1",
              name: "changed_diff",
              status: ToolCallStatus.Success,
              startTime: Date.now(),
              endTime: Date.now() + 10,
              input: {
                path: "packages/repl/src/ui/InkREPL.tsx",
                offset: 42,
                limit: 80,
              },
            },
          ],
        },
      ],
      viewportWidth: 100,
      showDetailedTools: true,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("input:");
    expect(text).toContain("\"path\": \"packages/repl/src/ui/InkREPL.tsx\"");
  });

  it("shows compact live tool summaries when tool input preview is available", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 100,
      isLoading: true,
      currentTool: "changed_diff_bundle",
      toolInputContent: "{\"paths\":[\"packages/coding/src/task-engine.ts\"],\"limit_per_path\":120}",
      managedAgentMode: "ama",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Planner",
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[AMA H2 - Planner] [Tools] changed_diff_bundle - packages/coding/src/task-engine.ts - limit=120...");
  });

  it("renders a live multi-tool block for concurrent tools", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 140,
      isLoading: true,
      managedAgentMode: "ama",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Scout",
      activeToolCalls: [
        {
          id: "tool-1",
          name: "[Scout] changed_scope",
          status: ToolCallStatus.Success,
          startTime: 100,
          endTime: 184,
          input: { paths: ["packages/coding/src"] },
        },
        {
          id: "tool-2",
          name: "[Scout] repo_overview",
          status: ToolCallStatus.Executing,
          startTime: 120,
          input: { path: "packages/coding/src" },
        },
        {
          id: "tool-3",
          name: "[Scout] read",
          status: ToolCallStatus.Executing,
          startTime: 130,
          input: {
            path: "packages/coding/src/task-engine.ts",
            offset: 3160,
            limit: 80,
          },
        },
      ],
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[AMA H2 - Scout] [Tools] 2 running, 1 done");
    expect(text).toContain("[Scout] changed_scope - packages/coding/src (84ms)");
    expect(text).toContain("[Scout] repo_overview - packages/coding/src");
    expect(text).toContain("[Scout] read - packages/coding/src/task-engine.ts - offset=3160 - limit=80");
  });

  it("keeps the completed live tool block visible until the response starts", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 140,
      isLoading: true,
      activeToolCalls: [
        {
          id: "tool-1",
          name: "[Scout] changed_scope",
          status: ToolCallStatus.Success,
          startTime: 100,
          endTime: 184,
          input: { paths: ["packages/coding/src"] },
        },
        {
          id: "tool-2",
          name: "[Scout] read",
          status: ToolCallStatus.Success,
          startTime: 120,
          endTime: 210,
          input: {
            path: "packages/coding/src/task-engine.ts",
            offset: 3160,
            limit: 80,
          },
        },
      ],
      lastLiveActivityLabel: "[Tools] [Scout] read - packages/coding/src/task-engine.ts - offset=3160 - limit=80 (90ms)",
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[Tools] 2 done");
    expect(text).toContain("[Scout] changed_scope - packages/coding/src (84ms)");
    expect(text).toContain("[Scout] read - packages/coding/src/task-engine.ts - offset=3160 - limit=80 (90ms)");
  });

  it("prefers the last live tool activity label while a tool is active", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 140,
      isLoading: true,
      currentTool: "changed_diff_bundle",
      toolInputContent: "{\"paths\":[\"packages/coding/src/task-engine.ts\"],\"limit_per_path\":120}",
      lastLiveActivityLabel: "[Tools] [Planner] changed_diff_bundle - 4 files - packages/repl/src/ui/utils/message-utils.ts (107ms)",
      managedAgentMode: "ama",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Planner",
    });

    const text = rows.map((row) => row.text).join("\n").replace(/\n/g, " ");
    expect(text).toContain("[AMA H2 - Planner] [Tools] changed_diff_bundle - 4 files - packages/repl/src/ui/utils/message-utils.ts (107ms)...");
    expect(text).not.toContain("[AMA H2 - Planner] [Tools] [Planner]");
  });

  it("does not repeat the active worker in AMA live tool labels", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 140,
      isLoading: true,
      currentTool: "changed_diff",
      lastLiveActivityLabel: "[Tools] [Generator] changed_diff - packages/coding/src/task-engine.ts - offset=1775 - limit=480",
      managedAgentMode: "ama",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Generator",
    });

    const text = rows.map((row) => row.text).join("\n").replace(/\n/g, " ");
    expect(text).toContain("[AMA H2 - Generator] [Tools] changed_diff - packages/coding/src/task-engine.ts - offset=1775 - limit=480...");
    expect(text).not.toContain("[AMA H2 - Generator] [Tools] [Generator]");
  });

  it("does not repeat the active worker in AMA live thinking labels", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 120,
      isLoading: true,
      isThinking: true,
      lastLiveActivityLabel: "[Thinking] [Planner]",
      managedAgentMode: "ama",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Planner",
    });

    const text = rows.map((row) => row.text).join("\n").replace(/\n/g, " ");
    expect(text).toContain("[AMA H2 - Planner] [Thinking]...");
    expect(text).not.toContain("[AMA H2 - Planner] [Thinking] [Planner]");
  });

  it("normalizes lowercase thinking activity labels to [Thinking]", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 120,
      isLoading: true,
      isThinking: true,
      lastLiveActivityLabel: "[Planner] thinking",
      managedAgentMode: "ama",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Planner",
    });

    const text = rows.map((row) => row.text).join("\n").replace(/\n/g, " ");
    expect(text).toContain("[AMA H2 - Planner] [Thinking]...");
    expect(text).not.toContain("[AMA H2 - Planner] thinking...");
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
