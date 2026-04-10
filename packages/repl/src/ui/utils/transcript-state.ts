import {
  getTerminalHostCapabilities,
  type TerminalHostProfile,
  type EffectiveTuiRendererMode,
} from "./terminal-host-profile.js";

export type TranscriptSurface = "prompt" | "transcript";
export type TranscriptBufferingMode = "live" | "buffered-fallback";

export interface TranscriptDisplayState {
  hostProfile: TerminalHostProfile;
  surface: TranscriptSurface;
  buffering: TranscriptBufferingMode;
  ownsViewportByDefault: boolean;
  supportsMouseTracking: boolean;
  supportsFullscreenLayout: boolean;
  supportsOverlaySurface: boolean;
  supportsSelection: boolean;
  supportsCopyOnSelect: boolean;
  supportsWheelHistory: boolean;
  supportsViewportChrome: boolean;
  supportsSearchViewport: boolean;
  supportsStickyPrompt: boolean;
  scrollAnchor: number;
  jumpToLatestAvailable: boolean;
  stickyPromptVisible: boolean;
  selectionMode: "none" | "message";
  selectedItemId?: string;
  searchMode: "closed" | "history";
  searchAnchorItemId?: string;
  currentMatchIndex: number;
  pendingLiveUpdates: number;
}

export type TranscriptSelectionCapabilityState = Pick<
  TranscriptDisplayState,
  "surface" | "supportsSelection" | "supportsCopyOnSelect"
>;

export interface TranscriptDisplayStateOptions {
  rendererMode?: EffectiveTuiRendererMode;
}

export function createTranscriptDisplayState(
  hostProfile: TerminalHostProfile,
  options: TranscriptDisplayStateOptions = {},
): TranscriptDisplayState {
  const capabilities = getTerminalHostCapabilities(hostProfile, {
    rendererMode: options.rendererMode ?? "owned",
  });
  return {
    hostProfile,
    surface: "prompt",
    buffering: capabilities.bufferingMode,
    ownsViewportByDefault: capabilities.ownsViewportByDefault,
    supportsMouseTracking: capabilities.supportsMouseTracking,
    supportsFullscreenLayout: capabilities.supportsFullscreenLayout,
    supportsOverlaySurface: capabilities.supportsOverlaySurface,
    supportsSelection: capabilities.supportsSelection,
    supportsCopyOnSelect: capabilities.supportsCopyOnSelect,
    supportsWheelHistory: capabilities.supportsWheelHistory,
    supportsViewportChrome: capabilities.supportsViewportChrome,
    supportsSearchViewport: capabilities.supportsSearchViewport,
    supportsStickyPrompt: capabilities.supportsStickyPrompt,
    scrollAnchor: 0,
    jumpToLatestAvailable: false,
    stickyPromptVisible: false,
    selectionMode: "none",
    selectedItemId: undefined,
    searchMode: "closed",
    searchAnchorItemId: undefined,
    currentMatchIndex: 0,
    pendingLiveUpdates: 0,
  };
}

export function enterTranscriptMode(
  state: TranscriptDisplayState,
): TranscriptDisplayState {
  return {
    ...state,
    surface: "transcript",
    jumpToLatestAvailable: state.pendingLiveUpdates > 0,
  };
}

export function exitTranscriptMode(
  state: TranscriptDisplayState,
): TranscriptDisplayState {
  return {
    ...state,
    surface: "prompt",
    scrollAnchor: 0,
    jumpToLatestAvailable: false,
    selectionMode: "none",
    selectedItemId: undefined,
    searchMode: "closed",
    searchAnchorItemId: undefined,
    currentMatchIndex: 0,
    pendingLiveUpdates: 0,
  };
}

export function setTranscriptPendingLiveUpdates(
  state: TranscriptDisplayState,
  pendingLiveUpdates: number,
): TranscriptDisplayState {
  const nextPendingUpdates = Math.max(0, pendingLiveUpdates);
  return {
    ...state,
    pendingLiveUpdates: nextPendingUpdates,
    jumpToLatestAvailable:
      state.surface === "transcript"
        ? nextPendingUpdates > 0
        : state.scrollAnchor > 0,
  };
}

export function setTranscriptScrollAnchor(
  state: TranscriptDisplayState,
  scrollAnchor: number,
): TranscriptDisplayState {
  const nextAnchor = Math.max(0, scrollAnchor);
  return {
    ...state,
    scrollAnchor: nextAnchor,
    jumpToLatestAvailable:
      state.surface === "transcript"
        ? state.pendingLiveUpdates > 0
        : nextAnchor > 0,
  };
}

export function jumpTranscriptToLatest(
  state: TranscriptDisplayState,
): TranscriptDisplayState {
  return {
    ...state,
    surface: "prompt",
    scrollAnchor: 0,
    jumpToLatestAvailable: false,
    selectionMode: "none",
    selectedItemId: undefined,
    searchMode: "closed",
    searchAnchorItemId: undefined,
    currentMatchIndex: 0,
    pendingLiveUpdates: 0,
  };
}

export function setTranscriptStickyPromptVisible(
  state: TranscriptDisplayState,
  visible: boolean,
): TranscriptDisplayState {
  return {
    ...state,
    stickyPromptVisible: visible,
  };
}

export function setTranscriptSelectedItem(
  state: TranscriptDisplayState,
  selectedItemId: string | undefined,
): TranscriptDisplayState {
  return {
    ...state,
    selectedItemId,
    selectionMode: selectedItemId ? "message" : "none",
  };
}

export function openTranscriptSearch(
  state: TranscriptDisplayState,
  options?: { anchorItemId?: string; initialMatchIndex?: number },
): TranscriptDisplayState {
  return {
    ...state,
    surface: "transcript",
    searchMode: "history",
    searchAnchorItemId: options?.anchorItemId ?? state.selectedItemId ?? state.searchAnchorItemId,
    currentMatchIndex: Math.max(0, options?.initialMatchIndex ?? state.currentMatchIndex),
    jumpToLatestAvailable: state.pendingLiveUpdates > 0,
  };
}

export function closeTranscriptSearch(
  state: TranscriptDisplayState,
): TranscriptDisplayState {
  return {
    ...state,
    searchMode: "closed",
    searchAnchorItemId: undefined,
    currentMatchIndex: 0,
  };
}

export function setTranscriptSearchAnchor(
  state: TranscriptDisplayState,
  searchAnchorItemId: string | undefined,
): TranscriptDisplayState {
  return {
    ...state,
    searchAnchorItemId,
  };
}

export function setTranscriptSearchMatchIndex(
  state: TranscriptDisplayState,
  currentMatchIndex: number,
): TranscriptDisplayState {
  return {
    ...state,
    currentMatchIndex: Math.max(-1, currentMatchIndex),
  };
}

export function shouldWindowTranscript(
  state: TranscriptDisplayState,
): boolean {
  return state.supportsFullscreenLayout && state.ownsViewportByDefault;
}

export function shouldPauseLiveTranscript(
  state: TranscriptDisplayState,
): boolean {
  return state.surface === "transcript";
}

export function supportsTranscriptMouseHistory(
  state: TranscriptDisplayState,
): boolean {
  return state.supportsWheelHistory;
}

export function ownsTranscriptSelectionPath(
  state: TranscriptSelectionCapabilityState,
): boolean {
  return state.supportsSelection;
}

export function resolveTranscriptSelectedItemId(
  state: TranscriptSelectionCapabilityState,
  selectableItemIds: readonly string[],
  selectedItemId: string | undefined,
): string | undefined {
  if (!ownsTranscriptSelectionPath(state) || !selectedItemId) {
    return undefined;
  }

  return selectableItemIds.includes(selectedItemId) ? selectedItemId : undefined;
}

export function supportsPassiveTranscriptCopyOnSelect(
  state: TranscriptSelectionCapabilityState,
): boolean {
  return state.supportsSelection && state.supportsCopyOnSelect;
}

export function buildTranscriptBrowseHint(
  state: TranscriptDisplayState,
): string | undefined {
  if (state.surface !== "transcript") {
    return undefined;
  }

  return "Transcript | PgUp/PgDn page | j/k scroll | \u2190/\u2192 select | / search | n/N matches | q/Esc/Ctrl+O back";
}
