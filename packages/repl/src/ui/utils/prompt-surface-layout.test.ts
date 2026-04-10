import { describe, expect, it } from "vitest";
import { ToolCallStatus } from "../types.js";
import { buildPromptSurfaceRenderModel } from "./prompt-surface-layout.js";

function visibleText(model: ReturnType<typeof buildPromptSurfaceRenderModel>): string {
  return [...model.rows, ...model.previewRows].map((row) => row.text).join("\n");
}

describe("prompt-surface-layout", () => {
  it("keeps tool, event, and info rows visible while excluding full thinking rows", () => {
    const model = buildPromptSurfaceRenderModel({
      items: [
        {
          id: "user-1",
          type: "user",
          timestamp: 1,
          text: "hello",
        },
        {
          id: "tools-1",
          type: "tool_group",
          timestamp: 2,
          tools: [
            { id: "tool-1", name: "read_file", status: ToolCallStatus.Success },
          ],
        },
        {
          id: "thinking-1",
          type: "thinking",
          timestamp: 3,
          text: "First reasoning step\nSecond reasoning step\nThird reasoning step\nFourth reasoning step\nFifth reasoning step",
        },
        {
          id: "event-1",
          type: "event",
          timestamp: 4,
          text: "Planner completed: full multiline detail that should not dominate the prompt surface.",
          compactText: "Planner completed: compact summary",
        },
        {
          id: "info-1",
          type: "info",
          timestamp: 5,
          text: "Scout is preparing context",
        },
      ] as any,
      viewportWidth: 80,
      streamingResponse: "",
      isLoading: false,
    });

    const text = visibleText(model);
    expect(text).toContain("Tools");
    expect(text).toContain("read_file");
    expect(text).toContain("Planner completed: compact summary");
    expect(text).not.toContain("full multiline detail");
    expect(text).toContain("Scout is preparing context");
    expect(text).toContain("Thinking");
    expect(text).toContain("First reasoning step");
    expect(text).not.toContain("Fifth reasoning step");
    expect(text).toContain("thinking truncated; press Ctrl+O to inspect full reasoning");
  });

  it("renders compact tool progress explanations on the prompt surface", () => {
    const model = buildPromptSurfaceRenderModel({
      items: [
        {
          id: "tools-approval",
          type: "tool_group",
          timestamp: 2,
          tools: [
            { id: "tool-1", name: "write_file", status: ToolCallStatus.AwaitingApproval, startTime: 1 },
          ],
        },
      ] as any,
      viewportWidth: 80,
      streamingResponse: "",
      isLoading: true,
    });

    const text = visibleText(model);
    expect(text).toContain("write_file (awaiting approval)");
    expect(text).toContain("Waiting: approval required before execution");
  });

  it("adds only a single live assistant block for streaming prompt text", () => {
    const model = buildPromptSurfaceRenderModel({
      items: [],
      viewportWidth: 80,
      streamingResponse: "Partial answer",
      isLoading: true,
    });

    const text = visibleText(model);
    expect(text).toContain("Assistant");
    expect(text).toContain("Partial answer");
    expect(text).not.toContain("Thinking");
    expect(text).not.toContain("[Tools]");
  });

  it("keeps the live thinking preview visible after assistant text starts streaming", () => {
    const model = buildPromptSurfaceRenderModel({
      items: [],
      viewportWidth: 80,
      streamingResponse: "Partial answer",
      isLoading: true,
      isThinking: false,
      thinkingContent: "Tracing the renderer boundary\nChecking why the prompt surface drops thinking rows",
    });

    const text = visibleText(model);
    expect(text).toContain("Thinking");
    expect(text).toContain("Tracing the renderer boundary");
    expect(text).toContain("Assistant");
    expect(text).toContain("Partial answer");
    expect(text.indexOf("Assistant")).toBeLessThan(text.indexOf("Thinking"));
  });

  it("shows a compact live thinking preview before assistant text exists", () => {
    const model = buildPromptSurfaceRenderModel({
      items: [],
      viewportWidth: 80,
      streamingResponse: "",
      isThinking: true,
      thinkingContent: "Reasoning about the repository state\nLooking at the prompt surface behavior\nChecking transcript interactions",
      isLoading: true,
    });

    const text = visibleText(model);
    expect(text).toContain("Thinking");
    expect(text).toContain("Reasoning about the repository state");
    expect(text).not.toContain("Assistant");
  });

  it("adds a transcript-oriented hint when live thinking is truncated", () => {
    const model = buildPromptSurfaceRenderModel({
      items: [],
      viewportWidth: 80,
      streamingResponse: "",
      isThinking: true,
      thinkingContent: Array.from({ length: 8 }, (_, index) => `reason ${index + 1}`).join("\n"),
      isLoading: true,
    });

    const text = visibleText(model);
    expect(text).toContain("thinking truncated; press Ctrl+O to inspect full reasoning");
  });

  it("keeps managed worker progress out of the prompt live preview", () => {
    const model = buildPromptSurfaceRenderModel({
      items: [],
      viewportWidth: 80,
      streamingResponse: "",
      isLoading: true,
      lastLiveActivityLabel: "[Scout] analyzing task complexity",
    });

    const text = visibleText(model);
    expect(text).toBe("");
  });

  it("keeps managed live events out of the prompt live preview while preserving actual streaming content", () => {
    const model = buildPromptSurfaceRenderModel({
      items: [],
      managedLiveEvents: [
        {
          id: "event-1",
          type: "event",
          timestamp: 1,
          icon: ">",
          text: "Planner narrowed the review to two high-risk files.\nDetailed evidence handoff is ready.",
          compactText: "Planner narrowed the review to two high-risk files.",
        },
      ] as any,
      viewportWidth: 80,
      streamingResponse: "Found 2 must-fix issues.",
      thinkingContent: "Checking whether the reducer keeps the findings-first structure intact.",
      isThinking: true,
      isLoading: true,
    });

    const text = visibleText(model);
    expect(text).toContain("Thinking");
    expect(text).toContain("Checking whether the reducer");
    expect(text).toContain("Assistant");
    expect(text).toContain("Found 2 must-fix issues.");
    expect(text).not.toContain("Planner narrowed the review to two high-risk files.");
  });

  it("does not surface managed live thinking and assistant summaries on the prompt live preview", () => {
    const model = buildPromptSurfaceRenderModel({
      items: [],
      managedLiveEvents: [
        {
          id: "managed-thinking-1",
          type: "thinking",
          timestamp: 1,
          text: "Scout thinking: full hidden reasoning detail that should stay available for expansion.",
          compactText: "Scout thinking: checking the task-engine fallback path.",
        },
        {
          id: "managed-assistant-1",
          type: "assistant",
          timestamp: 2,
          text: "Planner: full hidden worker summary detail that should remain available in transcript show-all mode.",
          compactText: "Planner: narrowed the review to task-engine.ts and InkREPL.tsx.",
        },
      ] as any,
      viewportWidth: 80,
      streamingResponse: "",
      isLoading: true,
    });

    const text = visibleText(model);
    expect(text).toBe("");
  });
});
