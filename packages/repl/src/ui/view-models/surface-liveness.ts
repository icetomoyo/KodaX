import { ToolCallStatus } from "../types.js";
import { buildBusyStatusText } from "./status-bar.js";

export interface SurfaceLivenessStreamingState {
  isThinking: boolean;
  thinkingCharCount: number;
  currentTool?: string;
  activeToolCalls: Array<{ status: ToolCallStatus }>;
  toolInputCharCount: number;
  toolInputContent: string;
  isCompacting: boolean;
}

export interface SurfaceLivenessManagedState {
  phase?: "starting" | "routing" | "preflight" | "round" | "worker" | "upgrade" | "completed";
  harnessProfile?: string;
  workerTitle?: string;
}

export interface BuildPromptActivityTextOptions {
  isTranscriptMode: boolean;
  isLoading: boolean;
  streamingState: SurfaceLivenessStreamingState;
  managedState?: SurfaceLivenessManagedState;
}

export function buildPromptActivityText(
  options: BuildPromptActivityTextOptions,
): string | undefined {
  if (options.isTranscriptMode || !options.isLoading) {
    return undefined;
  }

  return buildBusyStatusText({
    activeToolCount: options.streamingState.activeToolCalls.filter(
      (tool) => tool.status === ToolCallStatus.Executing,
    ).length,
    currentTool: options.streamingState.currentTool,
    isThinkingActive: options.streamingState.isThinking,
    thinkingCharCount: options.streamingState.thinkingCharCount,
    isCompacting: options.streamingState.isCompacting,
    toolInputCharCount: options.streamingState.toolInputCharCount,
    toolInputContent: options.streamingState.toolInputContent,
    managedPhase: options.managedState?.phase,
    managedHarnessProfile: options.managedState?.harnessProfile,
    managedWorkerTitle: options.managedState?.workerTitle,
  });
}
