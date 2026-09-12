import { describe, expect, it } from "vitest";
import { ToolCallStatus } from "../types.js";
import { getStatusBarText } from "./status-bar.js";
import {
  buildSurfaceStatusBarProps,
} from "./surface-status.js";

describe("surface-status", () => {
  it("renders Host parent context, usage and iteration instead of disconnected local counters", () => {
    const options = {
      sessionId: "s1", permissionMode: "accept-edits" as const, agentMode: "sa" as const,
      provider: "zhipu-coding", model: "glm-5.3-flash", isTranscriptMode: false, isLoading: true,
      streamingState: { isThinking: false, thinkingCharCount: 0, activeToolCalls: [],
        toolInputCharCount: 0, toolInputContent: "", currentIteration: 0, isCompacting: false },
      maxIter: 20, parentContextTokens: 700, contextUsage: { currentTokens: 0, contextWindow: 1_000_000, triggerPercent: 75 },
      clientActivity: { runId: "run", parentContextTokens: 12000,
        context: { tokenCount: 900, tokenSource: "api" as const, scope: "worker" as const },
        iteration: { current: 3, maximum: 7 }, compacting: true,
        usage: { inputTokens: 11000, outputTokens: 1000, totalTokens: 12000 },
        managedTask: { phase: "worker", workerTitle: "Scout", round: 2, maximumRounds: 4, idleWaiting: true, pendingChildren: 2 } },
    };
    const props = buildSurfaceStatusBarProps(options);
    expect(props.contextUsage).toBeUndefined();
    expect(props.contextTokens).toEqual({ currentTokens: 900, scope: 'worker' });
    expect(props).toMatchObject({ currentIteration: 3, maxIter: 7, isCompacting: true,
      managedPhase: "worker", managedWorkerTitle: "Scout", managedRound: 2, managedMaxRounds: 4,
      managedIdleWaiting: true, managedIdleWaitingPendingCount: 2 });
    const text = getStatusBarText(props);
    expect(text).toContain("worker ctx 900");
    expect(text).not.toContain("900/1.0M");
    const workerBudget = buildSurfaceStatusBarProps({ ...options, clientActivity: {
      ...options.clientActivity, contextBudget: { scope: 'worker', provider: 'worker-provider', model: 'worker-model',
        contextWindow: 32_000, reservedResponseTokens: 4000, reservedMemoryTokens: 0,
        compaction: { enabled: true, triggerPercent: 75, triggerTokens: 24_000, physicalCapacityTokens: 27_000 } },
    } });
    expect(workerBudget.contextUsage).toMatchObject({ currentTokens: 900, contextWindow: 32_000, effectiveTriggerTokens: 24_000 });
    expect(text).toContain("11000→1000 (12000)");
    expect(text).toContain("Iter 3/7");
    const frozen = buildSurfaceStatusBarProps({ ...options, isTranscriptMode: true });
    expect(frozen.currentIteration).toBe(0);
    expect(frozen.isCompacting).toBe(false);
    const childOnly = buildSurfaceStatusBarProps({ ...options,
      clientActivity: { runId: "run", context: options.clientActivity.context } });
    expect(childOnly.contextUsage).toBeUndefined();
    const parentOnly = buildSurfaceStatusBarProps({ ...options,
      clientActivity: { runId: "run", context: { tokenCount: 600, tokenSource: "estimate", scope: "parent" } } });
    expect(parentOnly.contextUsage?.currentTokens).toBe(600);
    expect(parentOnly.maxIter).toBe(20);
    const finished = buildSurfaceStatusBarProps({ ...options, agentMode: 'ama', isLoading: false });
    expect(finished.contextUsage?.currentTokens).toBe(700);
    expect(finished.managedPhase).toBeUndefined();
    expect(finished.managedIdleWaiting).toBeUndefined();
    const completedSa = buildSurfaceStatusBarProps({ ...options, isLoading: false,
      clientActivity: { runId: 'run', parentContextTokens: 60,
        context: { tokenCount: 60, tokenSource: 'api', scope: 'parent' } } });
    expect(completedSa.contextUsage?.currentTokens).toBe(60);
    const fresh = buildSurfaceStatusBarProps({ ...options, clientActivity: undefined });
    expect(fresh.contextUsage?.currentTokens).toBe(700);
    const budget = buildSurfaceStatusBarProps({ ...options, agentMode: 'ama',
      clientActivity: { ...options.clientActivity, managedTask: { ...options.clientActivity.managedTask,
        harnessProfile: 'H0_DIRECT', globalWorkBudget: 12, budgetUsage: 4, budgetApprovalRequired: true } } });
    expect(budget).toMatchObject({ managedHarnessProfile: 'H0_DIRECT', managedGlobalWorkBudget: 12,
      managedBudgetUsage: 4, managedBudgetApprovalRequired: true });
    expect(getStatusBarText(budget)).toContain('Work 4/12');
  });
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
