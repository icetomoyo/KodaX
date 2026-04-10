import type { IterationRecord } from "../contexts/StreamingContext.js";
import type { HistoryItem, ToolCall } from "../types.js";
import type { TranscriptSurface } from "./transcript-state.js";
import type { FullscreenPolicy } from "./terminal-host-profile.js";

export interface TranscriptSnapshot {
  items: HistoryItem[];
  managedLiveEvents: HistoryItem[];
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

export interface CaptureTranscriptSnapshotOptions extends Omit<TranscriptSnapshot, "items" | "managedLiveEvents"> {
  items: readonly HistoryItem[];
  managedLiveEvents?: readonly HistoryItem[];
}

export function captureTranscriptSnapshot(
  options: CaptureTranscriptSnapshotOptions,
): TranscriptSnapshot {
  return {
    ...options,
    items: [...options.items],
    managedLiveEvents: [...(options.managedLiveEvents ?? [])],
  };
}

export interface CountPendingTranscriptUpdatesOptions {
  isTranscriptMode: boolean;
  snapshot: TranscriptSnapshot | null;
  currentItemsLength: number;
  currentManagedLiveEventsLength?: number;
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
  if ((options.currentManagedLiveEventsLength ?? 0) !== options.snapshot.managedLiveEvents.length) {
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

export function buildPromptSurfaceItems(
  items: readonly HistoryItem[],
): HistoryItem[] {
  const promptItems: HistoryItem[] = [];

  for (const item of items) {
    switch (item.type) {
      case "user":
      case "system":
      case "error":
      case "tool_group":
      case "event":
      case "info":
        promptItems.push({ ...item });
        break;
      case "assistant":
      case "thinking": {
        const { compactText: _compactText, ...fullItem } = item;
        promptItems.push(fullItem as HistoryItem);
        break;
      }
      case "hint":
      default:
        break;
    }
  }

  return promptItems;
}

export type FullscreenShellMode = "virtual" | "main-screen";

export interface TranscriptSurfaceInteractionPolicy {
  shellMode: FullscreenShellMode;
  usesAlternateScreenShell: boolean;
  usesRendererViewportShell: boolean;
  usesRendererMouseTracking: boolean;
  usesManagedMouseClicks: boolean;
  usesManagedMouseWheel: boolean;
  usesManagedSelection: boolean;
  usesManagedWheelHistory: boolean;
  usesNativeMainScreenScrollback: boolean;
}

export function resolveFullscreenShellMode(
  fullscreenPolicy: FullscreenPolicy,
  surface: TranscriptSurface,
): FullscreenShellMode {
  if (!fullscreenPolicy.enabled) {
    return "main-screen";
  }

  if (surface === "transcript") {
    return fullscreenPolicy.transcriptShell;
  }

  return fullscreenPolicy.promptShell;
}

export function shouldUseAlternateScreenShell(
  fullscreenPolicy: FullscreenPolicy,
  surface: TranscriptSurface,
): boolean {
  return resolveFullscreenShellMode(fullscreenPolicy, surface) === "virtual";
}

export function shouldUseManagedMainScreenMouseTracking(
  fullscreenPolicy: FullscreenPolicy,
  surface: TranscriptSurface,
): boolean {
  void fullscreenPolicy;
  void surface;
  return false;
}

export function shouldUseRendererViewportShell(
  fullscreenPolicy: FullscreenPolicy,
  surface: TranscriptSurface,
): boolean {
  return fullscreenPolicy.enabled
    && resolveFullscreenShellMode(fullscreenPolicy, surface) === "virtual";
}

export function resolveTranscriptInteractionPolicy(
  fullscreenPolicy: FullscreenPolicy,
  surface: TranscriptSurface,
): TranscriptSurfaceInteractionPolicy {
  const shellMode = resolveFullscreenShellMode(fullscreenPolicy, surface);
  const usesAlternateScreenShell = fullscreenPolicy.enabled && shellMode === "virtual";
  const usesRendererViewportShell = fullscreenPolicy.enabled && shellMode === "virtual";
  const usesRendererMouseTracking = usesAlternateScreenShell
    && (fullscreenPolicy.mouseWheel || fullscreenPolicy.mouseClicks);
  const usesManagedMouseClicks = usesRendererMouseTracking && fullscreenPolicy.mouseClicks;
  const usesManagedMouseWheel = usesRendererViewportShell && fullscreenPolicy.mouseWheel;

  return {
    shellMode,
    usesAlternateScreenShell,
    usesRendererViewportShell,
    usesRendererMouseTracking,
    usesManagedMouseClicks,
    usesManagedMouseWheel,
    usesManagedSelection: usesRendererViewportShell,
    usesManagedWheelHistory: usesManagedMouseWheel,
    usesNativeMainScreenScrollback: !usesRendererViewportShell,
  };
}

export function shouldOwnTranscriptViewport(
  fullscreenPolicy: FullscreenPolicy,
  surface: TranscriptSurface,
  ownsViewportByDefault: boolean,
): boolean {
  if (!shouldUseRendererViewportShell(fullscreenPolicy, surface)) {
    return false;
  }

  return surface === "transcript" || ownsViewportByDefault;
}
