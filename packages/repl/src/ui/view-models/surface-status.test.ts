import { describe, expect, it } from "vitest";
import { ToolCallStatus } from "../types.js";
import {
  buildSurfaceStatusBarProps,
} from "./surface-status.js";

describe("surface-status", () => {
  it("builds status bar props without prompt-only busy duplication", () => {
    const props = buildSurfaceStatusBarProps({
      sessionId: "s1",
      permissionMode: "plan",
      agentMode: "ama",
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

  // v0.7.38 FEATURE_156 — idle-wait field passthrough from
  // managedTaskStatus into StatusBarProps. Gated on `isLoading`
  // like every other managedState passthrough so a finished run
  // doesn't leak stale idle-wait state.
  it("threads idleWaiting fields from managedState into StatusBarProps when loading", () => {
    const props = buildSurfaceStatusBarProps({
      sessionId: "s1",
      permissionMode: "accept-edits",
      agentMode: "ama",
      provider: "anthropic",
      model: "sonnet",
      isTranscriptMode: false,
      streamingState: {
        isThinking: false,
        thinkingCharCount: 0,
        currentTool: undefined,
        activeToolCalls: [],
        toolInputCharCount: 0,
        toolInputContent: "",
        currentIteration: 1,
        isCompacting: false,
      },
      isLoading: true,
      managedState: {
        phase: "worker",
        harnessProfile: "H0_DIRECT",
        workerTitle: "Worker",
        idleWaiting: true,
        idleWaitingPendingCount: 2,
      },
    });

    expect(props.managedIdleWaiting).toBe(true);
    expect(props.managedIdleWaitingPendingCount).toBe(2);
  });

  it("clears idleWaiting fields when not loading (finished run)", () => {
    const props = buildSurfaceStatusBarProps({
      sessionId: "s1",
      permissionMode: "accept-edits",
      agentMode: "ama",
      provider: "anthropic",
      model: "sonnet",
      isTranscriptMode: false,
      streamingState: {
        isThinking: false,
        thinkingCharCount: 0,
        currentTool: undefined,
        activeToolCalls: [],
        toolInputCharCount: 0,
        toolInputContent: "",
        currentIteration: 1,
        isCompacting: false,
      },
      isLoading: false,  // run finished
      managedState: {
        phase: "completed",
        idleWaiting: true,  // stale state from a prior idle-wait
        idleWaitingPendingCount: 5,
      },
    });

    expect(props.managedIdleWaiting).toBeUndefined();
    expect(props.managedIdleWaitingPendingCount).toBeUndefined();
  });
});
