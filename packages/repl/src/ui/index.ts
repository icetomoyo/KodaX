/**
 * KodaX UI - Ink-based Terminal UI Component Library - Ink-based 终端 UI 组件库
 *
 * Provides multiline input, message list, status bar and other components - 提供多行输入、消息列表、状态栏等组件
 */

// Root component - 根组件
export { App, SimpleApp } from "./App.js";
export type { AppHandle } from "./App.js";

// Ink REPL adapter - Ink REPL 适配器
export { runInkInteractiveMode } from "./InkREPL.js";
export { runSessionPicker } from "./SessionPicker.js";
export type {
  InkREPLOptions,
  InkRuntimeStatusProvider,
  InkTransientNotice,
} from "./InkREPL.js";
export type { SessionPickerItem } from "./SessionPicker.js";

// CLI event handler - CLI 事件处理器
export { createCliEvents } from "./cli-events.js";
export {
  answerClientPlaneInteraction,
  clientViewToHistoryItems,
  firstActiveRunId,
  mintInkInputId,
  runClientPlaneRound,
  viewRunsActive,
} from "./client-plane.js";
export type {
  ClientPlaneDialogSurface,
  ClientRoundOutcome,
  ClientViewItemMemo,
  InkClientPlane,
} from "./client-plane.js";
export { createJsonEvents } from "./json-events.js";

// Contexts - 上下文 (unique exports not in hooks)
export {
  UIStateProvider,
  useUIState,
  useUIActions,
  useUI,
  generateId,
  createHistoryItem,
  createToolCall,
  KeypressProvider,
  useKeypressManager,
  createKeypressManager,
  KeyMatchers,
  StreamingProvider,
  useStreamingState,
  useStreamingActions,
  useStreaming,
  createStreamingManager,
} from "./contexts/index.js";
export type {
  UIStateProviderProps,
  KeypressProviderProps,
  KeypressManager,
  StreamingContextValue,
  StreamingActions,
  StreamingProviderProps,
  StreamingStateListener,
  StreamingManager,
  CreatableHistoryItem,
} from "./contexts/index.js";

// Components - 组件
export * from "./components/index.js";

// Hooks
export * from "./hooks/index.js";

// Utils
export * from "./utils/index.js";

// Themes
export * from "./themes/index.js";

// Types
export * from "./types.js";
