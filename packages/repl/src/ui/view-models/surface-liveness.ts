import { ToolCallStatus } from "../types.js";
import { buildBusyStatusText } from "./status-bar.js";
import { t } from "../../common/i18n.js";

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
      return t("waiting.confirm");
    case "select":
      return t("waiting.select");
    case "input":
      return t("waiting.input");
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
    return t("placeholder.confirm");
  }
  if (options.waitingReason === "select") {
    return t("placeholder.select");
  }
  if (options.waitingReason === "input") {
    return t("placeholder.input");
  }
  if (options.isLoading) {
    return options.canQueueFollowUps
      ? t("placeholder.queue")
      : t("placeholder.busy");
  }
  return t("placeholder.idle");
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
