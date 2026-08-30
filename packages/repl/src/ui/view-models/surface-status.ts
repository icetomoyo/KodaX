import { ToolCallStatus } from "../types.js";
import type { StatusBarProps } from "../types.js";

export interface SurfaceStatusStreamingState {
  isThinking: boolean;
  thinkingCharCount: number;
  currentTool?: string;
  activeToolCalls: Array<{ status: ToolCallStatus }>;
  toolInputCharCount: number;
  toolInputContent: string;
  currentIteration?: number;
  isCompacting: boolean;
}

export interface SurfaceStatusContextUsage {
  currentTokens: number;
  contextWindow: number;
  triggerPercent: number;
  triggerTokens?: number;
  reservedResponseTokens?: number;
}

export interface SurfaceStatusManagedState {
  phase?: StatusBarProps["managedPhase"];
  harnessProfile?: string;
  workerTitle?: string;
  round?: number;
  maxRounds?: number;
  globalWorkBudget?: number;
  budgetUsage?: number;
  budgetApprovalRequired?: boolean;
  /** v0.7.38 FEATURE_156 — surfaces idle-yield wait in the status bar. */
  idleWaiting?: boolean;
  /** v0.7.38 FEATURE_156 — child count surfaced in idle-wait label. */
  idleWaitingPendingCount?: number;
}

export interface BuildSurfaceStatusBarPropsOptions {
  sessionId: string;
  permissionMode: StatusBarProps["permissionMode"];
  agentMode: StatusBarProps["agentMode"];
  provider: string;
  model: string;
  thinking?: boolean;
  reasoningMode?: StatusBarProps["reasoningMode"];
  effort?: string;
  reasoningEffortLabel?: string;
  reasoningCapability?: string;
  isTranscriptMode: boolean;
  streamingState: SurfaceStatusStreamingState;
  maxIter?: number;
  contextUsage?: SurfaceStatusContextUsage;
  learning?: StatusBarProps["learning"];
  isLoading: boolean;
  managedState?: SurfaceStatusManagedState;
}

export function buildSurfaceStatusBarProps(
  options: BuildSurfaceStatusBarPropsOptions,
): StatusBarProps {
  return {
    sessionId: options.sessionId,
    permissionMode: options.permissionMode,
    agentMode: options.agentMode,
    provider: options.provider,
    model: options.model,
    currentTool: options.streamingState.currentTool,
    activeToolCount: options.streamingState.activeToolCalls.filter(
      (tool) => tool.status === ToolCallStatus.Executing,
    ).length,
    thinking: options.thinking,
    reasoningMode: options.reasoningMode,
    effort: options.effort,
    reasoningEffortLabel: options.reasoningEffortLabel,
    reasoningCapability: options.reasoningCapability,
    isThinkingActive: options.streamingState.isThinking,
    thinkingCharCount: options.streamingState.thinkingCharCount,
    toolInputCharCount: options.isTranscriptMode
      ? options.streamingState.toolInputCharCount
      : 0,
    toolInputContent: options.isTranscriptMode
      ? options.streamingState.toolInputContent
      : "",
    currentIteration: options.streamingState.currentIteration,
    maxIter: options.maxIter,
    contextUsage: options.contextUsage,
    learning: options.learning,
    isCompacting: options.streamingState.isCompacting,
    showBusyStatus: false,
    managedPhase: options.isLoading ? options.managedState?.phase : undefined,
    managedHarnessProfile: options.isLoading ? options.managedState?.harnessProfile : undefined,
    managedWorkerTitle: options.isLoading ? options.managedState?.workerTitle : undefined,
    managedRound: options.isLoading ? options.managedState?.round : undefined,
    managedMaxRounds: options.isLoading ? options.managedState?.maxRounds : undefined,
    managedGlobalWorkBudget: options.isLoading ? options.managedState?.globalWorkBudget : undefined,
    managedBudgetUsage: options.isLoading ? options.managedState?.budgetUsage : undefined,
    managedBudgetApprovalRequired: options.isLoading
      ? options.managedState?.budgetApprovalRequired
      : undefined,
    // v0.7.38 FEATURE_156 — gated on `isLoading` like every other
    // managedState passthrough above: when the run finishes the idle
    // state is no longer meaningful, so we clear it the same way the
    // sibling fields are cleared.
    managedIdleWaiting: options.isLoading
      ? options.managedState?.idleWaiting
      : undefined,
    managedIdleWaitingPendingCount: options.isLoading
      ? options.managedState?.idleWaitingPendingCount
      : undefined,
  };
}
