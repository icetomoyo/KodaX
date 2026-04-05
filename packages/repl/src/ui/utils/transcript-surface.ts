import type { IterationRecord } from "../contexts/StreamingContext.js";
import type { HistoryItem, ToolCall } from "../types.js";
import type { TranscriptSurface } from "./transcript-state.js";

export interface TranscriptSnapshot {
  items: HistoryItem[];
  isLoading: boolean;
  isThinking: boolean;
  thinkingCharCount: number;
  thinkingContent: string;
  currentResponse: string;
  currentTool?: string;
  activeToolCalls: ToolCall[];
  toolInputCharCount: number;
  toolInputContent: string;
  lastLiveActivityLabel?: string;
  workStripText?: string;
  iterationHistory: IterationRecord[];
  currentIteration: number;
  isCompacting: boolean;
}

export interface CaptureTranscriptSnapshotOptions extends Omit<TranscriptSnapshot, "items"> {
  items: readonly HistoryItem[];
}

export function captureTranscriptSnapshot(
  options: CaptureTranscriptSnapshotOptions,
): TranscriptSnapshot {
  return {
    ...options,
    items: [...options.items],
  };
}

export interface CountPendingTranscriptUpdatesOptions {
  isTranscriptMode: boolean;
  snapshot: TranscriptSnapshot | null;
  currentItemsLength: number;
  isLoading: boolean;
  currentResponse: string;
  thinkingContent: string;
  activeToolCallsLength: number;
}

export function countPendingTranscriptUpdates(
  options: CountPendingTranscriptUpdatesOptions,
): number {
  if (!options.isTranscriptMode || !options.snapshot) {
    return 0;
  }

  let pending = Math.max(0, options.currentItemsLength - options.snapshot.items.length);
  if (options.isLoading !== options.snapshot.isLoading) {
    pending += 1;
  }
  if (options.currentResponse !== options.snapshot.currentResponse) {
    pending += 1;
  }
  if (options.thinkingContent !== options.snapshot.thinkingContent) {
    pending += 1;
  }
  if (options.activeToolCallsLength !== options.snapshot.activeToolCalls.length) {
    pending += 1;
  }

  return pending;
}

export interface ResolveTranscriptSurfaceItemsOptions {
  surface: TranscriptSurface;
  snapshot: TranscriptSnapshot | null;
  promptItems: readonly HistoryItem[];
  transcriptItems: readonly HistoryItem[];
}

export function resolveTranscriptSurfaceItems(
  options: ResolveTranscriptSurfaceItemsOptions,
): HistoryItem[] {
  if (options.snapshot) {
    return [...options.snapshot.items];
  }

  return options.surface === "transcript"
    ? [...options.transcriptItems]
    : [...options.promptItems];
}

export function shouldUseAlternateScreenShell(
  fullscreenEnabled: boolean,
  surface: TranscriptSurface,
): boolean {
  return fullscreenEnabled && surface !== "transcript";
}

export function shouldUseManagedMainScreenMouseTracking(
  fullscreenEnabled: boolean,
  surface: TranscriptSurface,
): boolean {
  if (!fullscreenEnabled) {
    return true;
  }

  return surface !== "transcript";
}
