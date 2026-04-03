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
  };
}

export function exitTranscriptHistory(
  state: TranscriptDisplayState,
): TranscriptDisplayState {
  return {
    ...state,
    followMode: "follow-bottom",
  };
}

export function shouldWindowTranscript(
  state: TranscriptDisplayState,
): boolean {
  return state.ownsViewportByDefault || state.followMode === "browsing-history";
}

export function shouldPauseLiveTranscript(
  state: TranscriptDisplayState,
): boolean {
  return state.followMode === "browsing-history";
}

export function supportsTranscriptMouseHistory(
  state: TranscriptDisplayState,
): boolean {
  return state.followMode === "browsing-history" && state.supportsMouseTracking;
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
