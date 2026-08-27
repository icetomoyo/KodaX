/**
 * Mutation-tool main-row summary tests.
 *
 * edit / write / multi_edit / insert_after_anchor tool results embed
 * "File edited: <path> / (+N lines, -M lines)" preambles. These tests lock
 * the output-derived main-row summary (path + change counts) that
 * `summarizeToolOutputDetails` produces, and the collapseToolCalls grouping
 * consequence: output-derived details make repeated same-file edits
 * distinct, so each edit keeps its own diff rows instead of collapsing
 * to "x2" (which previously hid all but the last diff).
 *
 * The @kodax-ai/agent runtime import is mocked: the real entry fails to
 * collect under the local Vitest transform (KNOWN_ISSUES #141 family), and
 * no fixture here touches memory-badge behavior.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@kodax-ai/agent", () => ({
  getAgentConfigPath: () => "/mock/agent-config",
  isAutoManagedMemoryFile: () => false,
  parseMemoryTypeFromFilename: () => undefined,
}));

import { ToolCallStatus, type ToolCall } from "../types.js";
import { collapseToolCalls, formatToolCallInlineText } from "./tool-display.js";

function mutationTool(name: string, output: string): ToolCall {
  return {
    id: `${name}-1`,
    name,
    status: ToolCallStatus.Success,
    startTime: 100,
    endTime: 118,
    input: { path: "ignored-input-path.ts" },
    output,
  };
}

describe("mutation-tool main-row summary", () => {
  it("shows path and +N -M for an edit result", () => {
    const tool = mutationTool("edit", [
      "File edited: src/foo.ts",
      "  (+2 lines, -1 lines)",
      "",
      "--- src/foo.ts",
      "+++ src/foo.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"));
    expect(formatToolCallInlineText(tool)).toBe("edit - src/foo.ts - +2 -1 (18ms)");
  });

  it("strips the (N replacements) suffix from the path", () => {
    const tool = mutationTool("edit", "File edited: src/foo.ts (3 replacements)\n  (+3 lines, -3 lines)");
    expect(formatToolCallInlineText(tool)).toContain("edit - src/foo.ts - +3 -3");
    expect(formatToolCallInlineText(tool)).not.toContain("replacements");
  });

  it("handles multi_edit's (N edits, M replacements) preamble suffix", () => {
    const tool = mutationTool("multi_edit", "File edited: src/foo.ts (2 edits, 5 replacements)\n  (+5 lines, -5 lines)");
    expect(formatToolCallInlineText(tool)).toContain("multi_edit - src/foo.ts - +5 -5");
  });

  it("shows new-file line count for a File created write", () => {
    const tool = mutationTool("write", "File created: src/new.ts\n  (12 lines written)");
    expect(formatToolCallInlineText(tool)).toBe("write - src/new.ts - new, 12 lines (18ms)");
  });

  it("shows +N -M for a File updated write", () => {
    const tool = mutationTool("write", "File updated: src/foo.ts\n  (+3 lines, -1 lines)");
    expect(formatToolCallInlineText(tool)).toContain("write - src/foo.ts - +3 -1");
  });

  it("shows 'no changes' for a no-op write", () => {
    const tool = mutationTool("write", "File written: src/foo.ts (no changes)");
    expect(formatToolCallInlineText(tool)).toBe("write - src/foo.ts - no changes (18ms)");
  });

  it("handles insert_after_anchor's longer preamble wording", () => {
    const tool = mutationTool("insert_after_anchor", "Content inserted after anchor in: src/foo.ts\n  (+5 lines, -0 lines)");
    expect(formatToolCallInlineText(tool)).toContain("insert_after_anchor - src/foo.ts - +5 -0");
  });

  it("degrades to the input-based summary when no preamble matches (managed truncation)", () => {
    const tool = mutationTool("edit", "[output truncated: stored to file]");
    expect(formatToolCallInlineText(tool)).toContain("edit - ignored-input-path.ts");
  });
});

describe("mutation-tool collapse grouping", () => {
  it("does not collapse repeated same-file edits — each keeps its own diff", () => {
    const first = mutationTool("edit", "File edited: src/foo.ts\n  (+1 lines, -1 lines)");
    const second = { ...mutationTool("edit", "File edited: src/foo.ts\n  (+2 lines, -2 lines)"), id: "edit-2" };
    const groups = collapseToolCalls([first, second]);
    // Previously both shared the input-derived summary key and collapsed to
    // one "x2" group (hiding the first edit's diff). Output-derived change
    // counts intentionally keep them distinct.
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.count === 1)).toBe(true);
  });
});
