import { describe, expect, it } from "vitest";
import { ToolCallStatus } from "../types.js";
import { buildSurfaceStatusBarProps } from "./surface-status.js";

describe("surface-status", () => {
  it("builds status bar props without prompt-only busy duplication", () => {
    const props = buildSurfaceStatusBarProps({
      sessionId: "s1",
      permissionMode: "plan",
      agentMode: "ama",
      parallel: true,
      provider: "openai",
      model: "gpt-5.4",
      thinking: true,
      reasoningMode: "auto",
      reasoningCapability: "B",
      isTranscriptMode: false,
      streamingState: {
        isThinking: true,
        thinkingCharCount: 18,
        currentTool: "read_file",
        activeToolCalls: [{ status: ToolCallStatus.Executing }],
        toolInputCharCount: 20,
        toolInputContent: "path",
        currentIteration: 2,
        isCompacting: false,
      },
      maxIter: 8,
      isLoading: true,
      managedState: {
        phase: "worker",
        workerTitle: "Scout",
      },
    });

    expect(props.activeToolCount).toBe(1);
    expect(props.toolInputCharCount).toBe(0);
    expect(props.showBusyStatus).toBe(false);
    expect(props.managedWorkerTitle).toBe("Scout");
  });
});
