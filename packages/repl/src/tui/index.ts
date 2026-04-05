export {
  render,
  Box,
  Text,
  Static,
  useInput,
  useStdout,
  useStdin,
  useApp,
} from "ink";
export type { Key } from "ink";

export {
  detectTerminalRenderHost,
  detectTerminalHostProfile,
  getTerminalHostCapabilities,
  hasCursorUpViewportYankRisk,
  hasMainScreenRenderScrollRisk,
  isTmuxControlMode,
  isVsCodeTerminalHostEnv,
  resetTmuxControlModeProbeForTesting,
  resolveConfiguredTuiRendererMode,
  resolveEffectiveTuiRendererMode,
  resolveFullscreenPolicy,
  resolveInteractiveSurfacePreference,
  isOwnedRendererPreferred,
  isClassicReplForced,
} from "./runtime.js";
export type {
  EffectiveTuiRendererMode,
  FullscreenPolicy,
  InteractiveSurfacePreference,
  TerminalHostCapabilities,
  TerminalHostDetectionOptions,
  TerminalHostProfile,
  TerminalRenderHost,
  TuiRendererMode,
} from "./runtime.js";

export { AlternateScreen } from "./components/AlternateScreen.js";
export { FullscreenLayout } from "./components/FullscreenLayout.js";
export { ScrollBox } from "./components/ScrollBox.js";
export type { ScrollBoxHandle } from "./components/ScrollBox.js";
