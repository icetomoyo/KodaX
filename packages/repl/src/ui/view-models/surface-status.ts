import { ToolCallStatus } from "../types.js";
import type { StatusBarProps } from "../types.js";
import type { ClientSessionActivity } from "@kodax-ai/coding/client-contract";

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
  clientActivity?: ClientSessionActivity;
  parentContextTokens?: number;
}

export function buildSurfaceStatusBarProps(
  options: BuildSurfaceStatusBarPropsOptions,
): StatusBarProps {
  const activity = options.clientActivity;
  const parentTokens = activity?.parentContextTokens
    ?? (activity?.context?.scope === 'parent' ? activity.context.tokenCount : undefined)
    ?? options.parentContextTokens;
  const currentTokens = options.isLoading
    ? activity?.context?.tokenCount ?? parentTokens
    : options.agentMode === 'sa' ? parentTokens : options.parentContextTokens ?? parentTokens;
  const liveActivity = options.isTranscriptMode ? undefined : activity;
  const managed = liveActivity?.managedTask;
  const phase = managed?.phase;
  const managedState: SurfaceStatusManagedState | undefined = managed ? {
    phase: phase === 'starting' || phase === 'routing' || phase === 'preflight' || phase === 'round'
      || phase === 'worker' || phase === 'upgrade' || phase === 'verifying' || phase === 'completed' ? phase : undefined,
    workerTitle: managed.workerTitle, round: managed.round, maxRounds: managed.maximumRounds,
    harnessProfile: managed.harnessProfile, globalWorkBudget: managed.globalWorkBudget,
    budgetUsage: managed.budgetUsage, budgetApprovalRequired: managed.budgetApprovalRequired,
    idleWaiting: managed.idleWaiting, idleWaitingPendingCount: managed.pendingChildren,
  } : options.managedState;
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
    currentIteration: liveActivity?.iteration?.current ?? options.streamingState.currentIteration,
    maxIter: liveActivity?.iteration?.maximum ?? options.maxIter,
    contextUsage: options.contextUsage && currentTokens !== undefined
      ? { ...options.contextUsage, currentTokens } : options.contextUsage,
    tokenUsage: activity?.usage ? { input: activity.usage.inputTokens,
      output: activity.usage.outputTokens, total: activity.usage.totalTokens } : undefined,
    learning: options.learning,
    isCompacting: liveActivity?.compacting ?? options.streamingState.isCompacting,
    showBusyStatus: false,
    managedPhase: options.isLoading ? managedState?.phase : undefined,
    managedHarnessProfile: options.isLoading ? managedState?.harnessProfile : undefined,
    managedWorkerTitle: options.isLoading ? managedState?.workerTitle : undefined,
    managedRound: options.isLoading ? managedState?.round : undefined,
    managedMaxRounds: options.isLoading ? managedState?.maxRounds : undefined,
    managedGlobalWorkBudget: options.isLoading ? managedState?.globalWorkBudget : undefined,
    managedBudgetUsage: options.isLoading ? managedState?.budgetUsage : undefined,
    managedBudgetApprovalRequired: options.isLoading
      ? managedState?.budgetApprovalRequired
      : undefined,
    // v0.7.38 FEATURE_156 — gated on `isLoading` like every other
    // managedState passthrough above: when the run finishes the idle
    // state is no longer meaningful, so we clear it the same way the
    // sibling fields are cleared.
    managedIdleWaiting: options.isLoading
      ? managedState?.idleWaiting
      : undefined,
    managedIdleWaitingPendingCount: options.isLoading
      ? managedState?.idleWaitingPendingCount
      : undefined,
  };
}
