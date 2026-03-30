import { describe, expect, it } from "vitest";
import { buildInterruptedPersistenceItems } from "./InkREPL.js";
import { ToolCallStatus } from "./types.js";

describe("buildInterruptedPersistenceItems", () => {
  it("persists both unsaved thinking and a truncated assistant reply", () => {
    expect(buildInterruptedPersistenceItems(
      "Need to inspect one more file.",
      "Partial answer to the user.",
    )).toEqual([
      {
        type: "thinking",
        text: "Need to inspect one more file.",
      },
      {
        type: "assistant",
        text: "Partial answer to the user.\n\n[Interrupted]",
      },
    ]);
  });

  it("drops control-plane-only assistant text while preserving thinking", () => {
    expect(buildInterruptedPersistenceItems(
      "Need one more check.",
      "[Managed Task] additional work budget approved (+200). Continuing the run.",
    )).toEqual([
      {
        type: "thinking",
        text: "Need one more check.",
      },
    ]);
  });

  it("returns an empty list when there is nothing user-facing to persist", () => {
    expect(buildInterruptedPersistenceItems("   ", "   ")).toEqual([]);
  });

  it("preserves tool calls and the latest managed breadcrumb on interrupt", () => {
    expect(buildInterruptedPersistenceItems(
      "",
      "",
      {
        infoItems: ["> AMA Scout - Planner starting"],
        toolCalls: [
          {
            id: "tool-1",
            name: "changed_diff_bundle",
            status: ToolCallStatus.Success,
            input: { paths: ["packages/coding/src/task-engine.ts"] },
          },
        ] as never,
      },
    )).toEqual([
      {
        type: "info",
        text: "> AMA Scout - Planner starting",
      },
      {
        type: "tool_group",
        tools: [
          {
            id: "tool-1",
            name: "changed_diff_bundle",
            status: ToolCallStatus.Success,
            input: { paths: ["packages/coding/src/task-engine.ts"] },
          },
        ],
      },
    ]);
  });
});
