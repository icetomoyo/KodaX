export {
  render,
  Box,
  Text,
  Static,
  useInput,
  useStdout,
  useStdin,
  useApp,
  useTerminalOutput,
  useTerminalSize,
  useTerminalWrite,
  useTerminalInput,
} from "./renderer-runtime.js";
export type { Key, TerminalInputOptions, TerminalSize } from "./renderer-runtime.js";
export { createRoot } from "./root.js";
export type { RenderOptions, RenderInstance, TuiRoot } from "./root.js";

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
export type { ScrollBoxHandle, ScrollBoxWindow } from "./components/ScrollBox.js";
