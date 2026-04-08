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
}

export interface BuildSurfaceStatusBarPropsOptions {
  sessionId: string;
  permissionMode: StatusBarProps["permissionMode"];
  agentMode: StatusBarProps["agentMode"];
  parallel?: boolean;
  provider: string;
  model: string;
  thinking?: boolean;
  reasoningMode?: StatusBarProps["reasoningMode"];
  reasoningCapability?: string;
  isTranscriptMode: boolean;
  streamingState: SurfaceStatusStreamingState;
  maxIter?: number;
  contextUsage?: SurfaceStatusContextUsage;
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
    parallel: options.parallel,
    provider: options.provider,
    model: options.model,
    currentTool: options.streamingState.currentTool,
    activeToolCount: options.streamingState.activeToolCalls.filter(
      (tool) => tool.status === ToolCallStatus.Executing,
    ).length,
    thinking: options.thinking,
    reasoningMode: options.reasoningMode,
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
  };
}
