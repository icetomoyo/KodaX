import { describe, expect, it } from "vitest";
import { ToolCallStatus, type ToolCall } from "../types.js";
import {
  collapseToolCalls,
  formatCollapsedToolInlineText,
  formatLiveToolLabel,
  formatToolCallInlineText,
  formatToolFailureExplanation,
  formatToolSummary,
} from "./tool-display.js";

describe("tool-display", () => {
  it("formats changed_diff_bundle summaries with file counts and limits", () => {
    expect(formatToolSummary(
      "[Planner] changed_diff_bundle",
      { preview: "{\"paths\":[\"packages/a.ts\",\"packages/b.ts\"],\"limit_per_path\":120}" },
    )).toBe("[Planner] changed_diff_bundle - 2 files - packages/a.ts - limit=120");
  });

  it("formats changed_diff summaries with path, offset, and limit", () => {
    expect(formatToolSummary(
      "changed_diff",
      { preview: "{\"path\":\"packages/coding/src/task-engine.ts\",\"offset\":220,\"limit\":120}" },
    )).toBe("changed_diff - packages/coding/src/task-engine.ts - offset=220 - limit=120");
  });

  it("formats inline tool text with compact duration", () => {
    const tool: ToolCall = {
      id: "tool-1",
      name: "[Planner] changed_diff_bundle",
      status: ToolCallStatus.Success,
      startTime: 100,
      endTime: 218,
      input: {
        preview: "{\"paths\":[\"packages/coding/src/task-engine.ts\"],\"limit_per_path\":120}",
      },
    };

    expect(formatToolCallInlineText(tool))
      .toBe("[Planner] changed_diff_bundle - packages/coding/src/task-engine.ts - limit=120 (118ms)");
  });

  it("formats awaiting-approval tool text with explicit status detail", () => {
    const tool: ToolCall = {
      id: "tool-awaiting",
      name: "write_file",
      status: ToolCallStatus.AwaitingApproval,
      startTime: 100,
    };

    expect(formatToolCallInlineText(tool)).toBe("write_file (awaiting approval)");
  });

  it("formats completed diff tools from their output details", () => {
    const tool: ToolCall = {
      id: "tool-2",
      name: "[Lead] Lead:changed_diff",
      status: ToolCallStatus.Success,
      startTime: 100,
      endTime: 211,
      input: {
        preview: "{\"path\":\"packages/coding/src/task-engine.ts\",\"offset\":1171,\"limit\":150}",
      },
      output: [
        "Changed diff for packages/coding/src/task-engine.ts",
        "Context lines: 3",
        "Showing diff lines 1171-1320 of 3096",
      ].join("\n"),
    };

    expect(formatToolCallInlineText(tool))
      .toBe("[Lead] changed_diff - packages/coding/src/task-engine.ts - 1171-1320/3096 (111ms)");
  });

  it("formats live tool labels from streamed input previews", () => {
    expect(formatLiveToolLabel(
      "changed_diff_bundle",
      "{\"paths\":[\"packages/coding/src/task-engine.ts\"],\"limit_per_path\":120}",
      72,
    )).toBe("[Tools] changed_diff_bundle - packages/coding/src/task-engine.ts - limit=120");
  });

  it("formats bash summaries with the exact command", () => {
    expect(formatToolSummary(
      "bash",
      { command: "git status --short" },
    )).toBe("bash - cmd=git status --short");
  });

  it("keeps longer command targets visible in bash summaries", () => {
    const command = "node scripts/run-task.js --workspace packages/repl --file packages/repl/src/ui/InkREPL.tsx --pattern activeToolCalls";

    expect(formatToolSummary("bash", { command })).toContain("packages/repl/src/ui/InkREPL.tsx");
  });

  it("formats glob summaries with pattern and scope", () => {
    expect(formatToolSummary(
      "glob",
      { pattern: "**/*.ts", path: "packages/coding/src" },
    )).toBe("glob - pattern=**/*.ts - packages/coding/src");
  });

  it("formats grep summaries with pattern and scope", () => {
    expect(formatToolSummary(
      "grep",
      { pattern: "H2_PLAN_EXECUTE_EVAL", path: "packages/coding/src" },
    )).toBe("grep - pattern=H2_PLAN_EXECUTE_EVAL - packages/coding/src");
  });

  it("formats web_search summaries with query and provider", () => {
    expect(formatToolSummary(
      "web_search",
      { query: "kodax ama tactical fanout", provider_id: "web-cap" },
    )).toBe("web_search - query=kodax ama tactical fanout - provider=web-cap");
  });

  it("formats web_fetch summaries with url", () => {
    expect(formatToolSummary(
      "web_fetch",
      { url: "https://example.com/spec" },
    )).toBe("web_fetch - https://example.com/spec");
  });

  it("formats semantic_lookup summaries with query and target path", () => {
    expect(formatToolSummary(
      "semantic_lookup",
      { query: "NameService", target_path: "packages/app" },
    )).toBe("semantic_lookup - query=NameService - packages/app");
  });

  it("formats code_search summaries with provider", () => {
    expect(formatToolSummary(
      "code_search",
      { query: "NameService", provider_id: "provider-1" },
    )).toBe("code_search - query=NameService - provider=provider-1");
  });

  it("formats mcp_search summaries with server and kind", () => {
    expect(formatToolSummary(
      "mcp_search",
      { query: "filesystem", server: "local-fs", kind: "tool", limit: 4 },
    )).toBe("mcp_search - query=filesystem - server=local-fs - kind=tool - limit=4");
  });

  it("formats mcp_describe summaries with capability id", () => {
    expect(formatToolSummary(
      "mcp_describe",
      { id: "mcp:local-fs:tool:read_file" },
    )).toBe("mcp_describe - mcp:local-fs:tool:read_file");
  });

  it("formats mcp_call summaries with arg count", () => {
    expect(formatToolSummary(
      "mcp_call",
      { id: "mcp:local-fs:tool:read_file", args: { path: "README.md", mode: "text" } },
    )).toBe("mcp_call - mcp:local-fs:tool:read_file - args=2");
  });

  it("collapses repeated tool calls into a single summary", () => {
    const groups = collapseToolCalls([
      {
        id: "tool-1",
        name: "changed_diff_bundle",
        status: ToolCallStatus.Executing,
        startTime: 100,
        input: {
          preview: "{\"paths\":[\"packages/coding/src/task-engine.ts\"],\"limit_per_path\":120}",
        },
      },
      {
        id: "tool-2",
        name: "changed_diff_bundle",
        status: ToolCallStatus.Success,
        startTime: 120,
        endTime: 238,
        input: {
          preview: "{\"paths\":[\"packages/coding/src/task-engine.ts\"],\"limit_per_path\":120}",
        },
      },
    ]);

    expect(groups).toHaveLength(1);
    expect(formatCollapsedToolInlineText(groups[0]!))
      .toBe("changed_diff_bundle - packages/coding/src/task-engine.ts - limit=120 (118ms) x2");
  });

  it("builds compact failure explanations from error and output", () => {
    const tool: ToolCall = {
      id: "tool-fail",
      name: "bash",
      status: ToolCallStatus.Error,
      startTime: 100,
      error: "permission denied",
      output: "fatal: permission denied\nsee more details in debug log",
    };

    expect(formatToolFailureExplanation(tool)).toEqual([
      "Error: permission denied",
      "Last output: fatal: permission denied",
    ]);
  });
});
