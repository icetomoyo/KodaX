import {
  getTerminalHostCapabilities,
  type TerminalHostProfile,
} from "./terminal-host-profile.js";

export type TranscriptVerbosity = "compact" | "verbose";
export type TranscriptFollowMode = "follow-bottom" | "browsing-history";
export type TranscriptBufferingMode = "live" | "buffered-fallback";

export interface TranscriptDisplayState {
  hostProfile: TerminalHostProfile;
  verbosity: TranscriptVerbosity;
  followMode: TranscriptFollowMode;
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
  searchReturnFollowMode?: TranscriptFollowMode;
  searchAnchorItemId?: string;
  currentMatchIndex: number;
}

export function createTranscriptDisplayState(
  hostProfile: TerminalHostProfile,
): TranscriptDisplayState {
  const capabilities = getTerminalHostCapabilities(hostProfile);
  return {
    hostProfile,
    verbosity: "compact",
    followMode: "follow-bottom",
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
    searchReturnFollowMode: undefined,
    searchAnchorItemId: undefined,
    currentMatchIndex: 0,
  };
}

export function toggleTranscriptVerbosityState(
  state: TranscriptDisplayState,
): TranscriptDisplayState {
  return {
    ...state,
    verbosity: state.verbosity === "compact" ? "verbose" : "compact",
  };
}

export function enterTranscriptHistory(
  state: TranscriptDisplayState,
): TranscriptDisplayState {
  return {
    ...state,
    followMode: "browsing-history",
    jumpToLatestAvailable: state.scrollAnchor > 0,
  };
}

export function exitTranscriptHistory(
  state: TranscriptDisplayState,
): TranscriptDisplayState {
  return {
    ...state,
    followMode: "follow-bottom",
    scrollAnchor: 0,
    jumpToLatestAvailable: false,
    selectionMode: "none",
    selectedItemId: undefined,
    searchMode: "closed",
    searchReturnFollowMode: undefined,
    searchAnchorItemId: undefined,
    currentMatchIndex: 0,
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
      state.followMode === "browsing-history" ? nextAnchor > 0 : false,
  };
}

export function jumpTranscriptToLatest(
  state: TranscriptDisplayState,
): TranscriptDisplayState {
  return {
    ...state,
    followMode: "follow-bottom",
    scrollAnchor: 0,
    jumpToLatestAvailable: false,
    selectionMode: state.selectionMode === "message" ? "message" : "none",
    searchMode: "closed",
    searchReturnFollowMode: undefined,
    searchAnchorItemId: undefined,
    currentMatchIndex: 0,
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
    followMode: "browsing-history",
    jumpToLatestAvailable:
      state.followMode === "browsing-history" ? state.scrollAnchor > 0 : false,
    searchMode: "history",
    searchReturnFollowMode: state.searchReturnFollowMode ?? state.followMode,
    searchAnchorItemId: options?.anchorItemId ?? state.selectedItemId ?? state.searchAnchorItemId,
    currentMatchIndex: Math.max(0, options?.initialMatchIndex ?? state.currentMatchIndex),
  };
}

export function closeTranscriptSearch(
  state: TranscriptDisplayState,
  options?: { restoreFollowMode?: boolean },
): TranscriptDisplayState {
  const restoreFollowMode = options?.restoreFollowMode ?? false;
  const shouldRestoreLiveFollow =
    restoreFollowMode && state.searchReturnFollowMode === "follow-bottom";

  return {
    ...state,
    followMode: shouldRestoreLiveFollow ? "follow-bottom" : state.followMode,
    scrollAnchor: shouldRestoreLiveFollow ? 0 : state.scrollAnchor,
    jumpToLatestAvailable: shouldRestoreLiveFollow
      ? false
      : state.jumpToLatestAvailable,
    selectionMode: shouldRestoreLiveFollow ? "none" : state.selectionMode,
    selectedItemId: shouldRestoreLiveFollow ? undefined : state.selectedItemId,
    searchMode: "closed",
    searchReturnFollowMode: undefined,
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
  return (
    state.supportsFullscreenLayout
    && (state.ownsViewportByDefault || state.followMode === "browsing-history")
  );
}

export function shouldPauseLiveTranscript(
  state: TranscriptDisplayState,
): boolean {
  return state.followMode === "browsing-history";
}

export function supportsTranscriptMouseHistory(
  state: TranscriptDisplayState,
): boolean {
  return state.followMode === "browsing-history" && state.supportsWheelHistory;
}

export function buildTranscriptBrowseHint(
  state: TranscriptDisplayState,
): string | undefined {
  if (state.followMode !== "browsing-history") {
    return undefined;
  }

  const wheelHint = state.supportsMouseTracking ? "Wheel/" : "";
  return `Browsing transcript history - live updates paused | ${wheelHint}PgUp/PgDn/j/k scroll | Esc/End/Ctrl+Y/Alt+Z resume`;
}
