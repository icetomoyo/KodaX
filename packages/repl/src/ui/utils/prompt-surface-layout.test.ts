import { describe, expect, it } from "vitest";
import { ToolCallStatus } from "../types.js";
import { buildPromptSurfaceRenderModel } from "./prompt-surface-layout.js";

describe("prompt-surface-layout", () => {
  it("keeps tool and info rows visible while excluding thinking rows", () => {
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
          id: "info-1",
          type: "info",
          timestamp: 4,
          text: "Scout is preparing context",
        },
      ] as any,
      viewportWidth: 80,
      streamingResponse: "",
      isLoading: false,
    });

    const text = model.rows.map((row) => row.text).join("\n");
    expect(text).toContain("Tools");
    expect(text).toContain("read_file");
    expect(text).toContain("Scout is preparing context");
    expect(text).toContain("Thinking");
    expect(text).toContain("First reasoning step");
    expect(text).not.toContain("Fifth reasoning step");
  });

  it("adds only a single live assistant block for streaming prompt text", () => {
    const model = buildPromptSurfaceRenderModel({
      items: [],
      viewportWidth: 80,
      streamingResponse: "Partial answer",
      isLoading: true,
    });

    const text = model.rows.map((row) => row.text).join("\n");
    expect(text).toContain("Assistant");
    expect(text).toContain("Partial answer");
    expect(text).not.toContain("Thinking");
    expect(text).not.toContain("[Tools]");
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

    const text = model.rows.map((row) => row.text).join("\n");
    expect(text).toContain("Thinking");
    expect(text).toContain("Reasoning about the repository state");
    expect(text).not.toContain("Assistant");
  });
});
