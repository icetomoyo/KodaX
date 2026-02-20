/**
 * Contexts 导出
 */

// UIStateContext
export {
  UIStateProvider,
  useUIState,
  useUIActions,
  useUI,
  generateId,
  createHistoryItem,
  createToolCall,
} from "./UIStateContext.js";
export type {
  UIStateProviderProps,
} from "./UIStateContext.js";

// KeypressContext
export {
  KeypressProvider,
  useKeypressManager,
  useKeypress,
  createKeypressManager,
  createKeyMatcher,
  KeyMatchers,
} from "./KeypressContext.js";
export type {
  KeypressProviderProps,
  KeypressManager,
} from "./KeypressContext.js";

// StreamingContext
export {
  StreamingProvider,
  useStreamingState,
  useStreamingActions,
  useStreaming,
  createStreamingManager,
} from "./StreamingContext.js";
export type {
  StreamingContextValue,
  StreamingActions,
  StreamingProviderProps,
  StreamingStateListener,
  StreamingManager,
} from "./StreamingContext.js";

// Re-export types from types.ts
export {
  type CreatableHistoryItem,
} from "../types.js";
