import { describe, expect, it } from "vitest";
import { ToolCallStatus } from "../types.js";
import { buildPromptActivityText } from "./surface-liveness.js";

describe("surface-liveness", () => {
  it("only emits prompt activity text for loading prompt surfaces", () => {
    expect(buildPromptActivityText({
      isTranscriptMode: true,
      isLoading: true,
      streamingState: {
        isThinking: true,
        thinkingCharCount: 12,
        currentTool: undefined,
        activeToolCalls: [],
        toolInputCharCount: 0,
        toolInputContent: "",
        isCompacting: false,
      },
    })).toBeUndefined();

    expect(buildPromptActivityText({
      isTranscriptMode: false,
      isLoading: false,
      streamingState: {
        isThinking: true,
        thinkingCharCount: 12,
        currentTool: undefined,
        activeToolCalls: [],
        toolInputCharCount: 0,
        toolInputContent: "",
        isCompacting: false,
      },
    })).toBeUndefined();
  });

  it("formats prompt activity from tool/thinking state", () => {
    expect(buildPromptActivityText({
      isTranscriptMode: false,
      isLoading: true,
      streamingState: {
        isThinking: false,
        thinkingCharCount: 0,
        currentTool: "read_file",
        activeToolCalls: [{ status: ToolCallStatus.Executing }],
        toolInputCharCount: 0,
        toolInputContent: "",
        isCompacting: false,
      },
    })).toBe("1 tool running");

    expect(buildPromptActivityText({
      isTranscriptMode: false,
      isLoading: true,
      streamingState: {
        isThinking: true,
        thinkingCharCount: 42,
        currentTool: undefined,
        activeToolCalls: [],
        toolInputCharCount: 0,
        toolInputContent: "",
        isCompacting: false,
      },
    })).toContain("Thinking");
  });
});
