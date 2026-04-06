export interface TranscriptInputActivityState {
  itemsLength: number;
  currentResponse: string;
  thinkingContent: string;
  activeToolCallsLength: number;
}

export function hasTranscriptInputActivity(
  state: TranscriptInputActivityState,
): boolean {
  return state.itemsLength > 0
    || state.currentResponse.length > 0
    || state.thinkingContent.length > 0
    || state.activeToolCallsLength > 0;
}

export interface TranscriptManagedMouseOptions {
  keyName: string | undefined;
  hasMouse: boolean;
  usesManagedMouseClicks: boolean;
  supportsMouseTracking: boolean;
  usesRendererMouseTracking: boolean;
}

export function shouldHandleManagedTranscriptMouse(
  options: TranscriptManagedMouseOptions,
): boolean {
  return options.keyName === "mouse"
    && options.hasMouse
    && options.usesManagedMouseClicks
    && options.supportsMouseTracking
    && options.usesRendererMouseTracking;
}

export interface TranscriptManagedWheelOptions {
  usesManagedMouseWheel: boolean;
  supportsWheelHistory: boolean;
  hasTranscript: boolean;
}

export function shouldHandleManagedTranscriptWheel(
  options: TranscriptManagedWheelOptions,
): boolean {
  return options.usesManagedMouseWheel
    && options.supportsWheelHistory
    && options.hasTranscript;
}

export type TranscriptPointerAction =
  | { kind: "none" }
  | { kind: "consume" }
  | { kind: "scroll-by"; delta: number }
  | { kind: "mouse-phase"; phase: "press" | "drag" | "release" };

export interface ResolveTranscriptPointerActionOptions {
  keyName: string | undefined;
  hasTranscript: boolean;
  historyScrollOffset: number;
  reviewPageSize: number;
  reviewWheelStep: number;
  hasMouse: boolean;
  mouseButton?: string;
  mouseAction?: string;
  usesManagedMouseClicks: boolean;
  supportsMouseTracking: boolean;
  usesRendererMouseTracking: boolean;
  usesManagedMouseWheel: boolean;
  supportsWheelHistory: boolean;
}

export function resolveTranscriptPointerAction(
  options: ResolveTranscriptPointerActionOptions,
): TranscriptPointerAction {
  if (shouldHandleManagedTranscriptMouse({
    keyName: options.keyName,
    hasMouse: options.hasMouse,
    usesManagedMouseClicks: options.usesManagedMouseClicks,
    supportsMouseTracking: options.supportsMouseTracking,
    usesRendererMouseTracking: options.usesRendererMouseTracking,
  })) {
    if (options.mouseButton !== "left") {
      return { kind: "none" };
    }

    if (
      options.mouseAction === "press"
      || options.mouseAction === "drag"
      || options.mouseAction === "release"
    ) {
      return {
        kind: "mouse-phase",
        phase: options.mouseAction,
      };
    }
  }

  if (options.keyName === "pageup") {
    return options.hasTranscript
      ? { kind: "scroll-by", delta: options.reviewPageSize }
      : { kind: "consume" };
  }

  if (options.keyName === "wheelup") {
    if (!shouldHandleManagedTranscriptWheel({
      usesManagedMouseWheel: options.usesManagedMouseWheel,
      supportsWheelHistory: options.supportsWheelHistory,
      hasTranscript: options.hasTranscript,
    })) {
      return { kind: "none" };
    }

    return { kind: "scroll-by", delta: options.reviewWheelStep };
  }

  if (options.keyName === "wheeldown") {
    if (!shouldHandleManagedTranscriptWheel({
      usesManagedMouseWheel: options.usesManagedMouseWheel,
      supportsWheelHistory: options.supportsWheelHistory,
      hasTranscript: options.hasTranscript,
    })) {
      return { kind: "none" };
    }

    return options.historyScrollOffset === 0
      ? { kind: "consume" }
      : { kind: "scroll-by", delta: -options.reviewWheelStep };
  }

  return { kind: "none" };
}

export interface TranscriptCopyKeyOptions {
  hasTextSelection: boolean;
  canCopySelectedItem: boolean;
}

export function resolveTranscriptCopyKeyAction(
  options: TranscriptCopyKeyOptions,
): "selection" | "item" | "none" {
  if (options.hasTextSelection) {
    return "selection";
  }
  if (options.canCopySelectedItem) {
    return "item";
  }
  return "none";
}

export interface TranscriptInterruptPriorityOptions {
  isTranscriptMode: boolean;
  hasTextSelection: boolean;
}

export function shouldDeferInterruptToTranscriptSelectionCopy(
  options: TranscriptInterruptPriorityOptions,
): boolean {
  return options.isTranscriptMode && options.hasTextSelection;
}

export type StreamingInterruptAction =
  | { kind: "none" }
  | { kind: "interrupt" }
  | { kind: "pop-pending-input" }
  | { kind: "arm-double-escape" };

export interface ResolveStreamingInterruptActionOptions {
  keyName: string | undefined;
  ctrl: boolean;
  isTranscriptMode: boolean;
  isAwaitingUserInteraction: boolean;
  isInputEmpty: boolean;
  pendingInputCount: number;
  hasTranscriptTextSelection: boolean;
  timeSinceLastEscapeMs: number;
  doubleEscapeIntervalMs: number;
}

export function resolveStreamingInterruptAction(
  options: ResolveStreamingInterruptActionOptions,
): StreamingInterruptAction {
  if (options.ctrl && options.keyName === "c") {
    return shouldDeferInterruptToTranscriptSelectionCopy({
      isTranscriptMode: options.isTranscriptMode,
      hasTextSelection: options.hasTranscriptTextSelection,
    })
      ? { kind: "none" }
      : { kind: "interrupt" };
  }

  if (options.keyName !== "escape") {
    return { kind: "none" };
  }

  if (options.isTranscriptMode || options.isAwaitingUserInteraction) {
    return { kind: "none" };
  }

  if (options.isInputEmpty && options.pendingInputCount > 0) {
    return { kind: "pop-pending-input" };
  }

  if (!options.isInputEmpty) {
    return { kind: "none" };
  }

  return options.timeSinceLastEscapeMs < options.doubleEscapeIntervalMs
    ? { kind: "interrupt" }
    : { kind: "arm-double-escape" };
}
