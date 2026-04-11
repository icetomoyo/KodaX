import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolCallStatus } from "../types.js";
import {
  buildPromptActivityText,
  buildPromptActivityViewModel,
  buildPromptPlaceholderText,
} from "./surface-liveness.js";
import { setLocale } from "../../common/i18n.js";

describe("surface-liveness", () => {
  beforeEach(() => { setLocale("en"); });
  afterEach(() => { setLocale("en"); });
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

  it("treats confirmation and ui requests as waiting instead of busy", () => {
    expect(buildPromptActivityViewModel({
      isTranscriptMode: false,
      isLoading: true,
      waitingReason: "confirm",
      streamingState: {
        isThinking: true,
        thinkingCharCount: 42,
        currentTool: "write",
        activeToolCalls: [{ status: ToolCallStatus.Executing }],
        toolInputCharCount: 0,
        toolInputContent: "",
        isCompacting: false,
      },
    })).toEqual({
      kind: "waiting",
      text: "Waiting: approval required",
      showSpinner: false,
    });

    expect(buildPromptActivityViewModel({
      isTranscriptMode: false,
      isLoading: false,
      waitingReason: "input",
      streamingState: {
        isThinking: false,
        thinkingCharCount: 0,
        currentTool: undefined,
        activeToolCalls: [],
        toolInputCharCount: 0,
        toolInputContent: "",
        isCompacting: false,
      },
    })).toEqual({
      kind: "waiting",
      text: "Waiting: answer the prompt",
      showSpinner: false,
    });
  });

  it("uses waiting-aware placeholders before generic busy text", () => {
    expect(buildPromptPlaceholderText({
      isLoading: true,
      canQueueFollowUps: false,
      waitingReason: "confirm",
    })).toBe("Respond to the approval prompt above...");

    expect(buildPromptPlaceholderText({
      isLoading: true,
      canQueueFollowUps: true,
    })).toBe("Queue a follow-up for the next round...");

    expect(buildPromptPlaceholderText({
      isLoading: false,
      canQueueFollowUps: false,
    })).toBe("Type a message...");
  });
});
