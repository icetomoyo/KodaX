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

export type PromptWaitingReason = "confirm" | "select" | "input";

export interface PromptActivityViewModel {
  kind: "busy" | "waiting";
  text: string;
  showSpinner: boolean;
}

export interface BuildPromptActivityTextOptions {
  isTranscriptMode: boolean;
  isLoading: boolean;
  streamingState: SurfaceLivenessStreamingState;
  managedState?: SurfaceLivenessManagedState;
  waitingReason?: PromptWaitingReason;
}

function formatPromptWaitingText(reason: PromptWaitingReason): string {
  switch (reason) {
    case "confirm":
      return "Waiting: approval required";
    case "select":
      return "Waiting: choose an option";
    case "input":
      return "Waiting: answer the prompt";
  }
}

export interface BuildPromptPlaceholderTextOptions {
  isLoading: boolean;
  canQueueFollowUps: boolean;
  waitingReason?: PromptWaitingReason;
}

export function buildPromptPlaceholderText(
  options: BuildPromptPlaceholderTextOptions,
): string {
  if (options.waitingReason === "confirm") {
    return "Respond to the approval prompt above...";
  }
  if (options.waitingReason === "select") {
    return "Choose an option above...";
  }
  if (options.waitingReason === "input") {
    return "Answer the prompt above...";
  }
  if (options.isLoading) {
    return options.canQueueFollowUps
      ? "Queue a follow-up for the next round..."
      : "Agent is busy...";
  }
  return "Type a message...";
}

export function buildPromptActivityViewModel(
  options: BuildPromptActivityTextOptions,
): PromptActivityViewModel | undefined {
  if (options.isTranscriptMode) {
    return undefined;
  }

  if (options.waitingReason) {
    return {
      kind: "waiting",
      text: formatPromptWaitingText(options.waitingReason),
      showSpinner: false,
    };
  }

  if (!options.isLoading) {
    return undefined;
  }

  const text = buildBusyStatusText({
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

  return text
    ? {
        kind: "busy",
        text,
        showSpinner: true,
      }
    : undefined;
}

export function buildPromptActivityText(
  options: BuildPromptActivityTextOptions,
): string | undefined {
  return buildPromptActivityViewModel(options)?.text;
}
