/**
 * UIStateContext - Global UI State Management
 *
 * Reference implementation based on Gemini CLI's UIStateContext architecture - 参考 Gemini CLI 的 UIStateContext 架构实现
 * Uses React Context + useReducer pattern for global state management - 使用 React Context + useReducer 模式管理全局状态
 */

import React, {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import {
  type UIState,
  type UIActions,
  type HistoryItem,
  type CreatableHistoryItem,
  type ToolCall,
  StreamingState,
  DEFAULT_UI_STATE,
} from "../types.js";

// === Action Types ===

type UIAction =
  | { type: "SET_STREAMING_STATE"; payload: StreamingState }
  | { type: "APPEND_TO_RESPONSE"; payload: string }
  | { type: "CLEAR_RESPONSE" }
  | { type: "ADD_HISTORY_ITEM"; payload: HistoryItem }
  | { type: "UPDATE_HISTORY_ITEM"; payload: { id: string; updates: Partial<HistoryItem> } }
  | { type: "CLEAR_HISTORY" }
  | { type: "ADD_TOOL_CALL"; payload: ToolCall }
  | { type: "UPDATE_TOOL_CALL"; payload: { id: string; updates: Partial<ToolCall> } }
  | { type: "CLEAR_TOOL_CALLS" }
  | { type: "SET_SESSION_ID"; payload: string }
  | { type: "SET_MODE"; payload: "code" | "ask" }
  | { type: "SET_PROVIDER"; payload: string }
  | { type: "SET_MODEL"; payload: string }
  | { type: "SET_TOKEN_USAGE"; payload: UIState["tokenUsage"] }
  | { type: "SET_ERROR"; payload: string | undefined }
  | { type: "SET_LOADING"; payload: boolean }
  | { type: "RESET_STATE" };

// === Helper Functions ===

/**
 * Generate unique ID - 生成唯一 ID
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Create history item with auto-generated ID and timestamp - 创建带自动生成 ID 和时间戳的历史项
 */
export function createHistoryItem(
  item: CreatableHistoryItem
): HistoryItem {
  return {
    ...item,
    id: generateId(),
    timestamp: Date.now(),
  } as HistoryItem;
}

/**
 * Create tool call with auto-generated ID and start time - 创建带自动生成 ID 和开始时间的工具调用
 */
export function createToolCall(
  tool: Omit<ToolCall, "id" | "startTime">
): ToolCall {
  return {
    ...tool,
    id: generateId(),
    startTime: Date.now(),
  };
}

// === Reducer ===

function uiReducer(state: UIState, action: UIAction): UIState {
  switch (action.type) {
    case "SET_STREAMING_STATE":
      return { ...state, streamingState: action.payload };

    case "APPEND_TO_RESPONSE":
      return { ...state, currentResponse: state.currentResponse + action.payload };

    case "CLEAR_RESPONSE":
      return { ...state, currentResponse: "" };

    case "ADD_HISTORY_ITEM":
      return { ...state, history: [...state.history, action.payload] };

    case "UPDATE_HISTORY_ITEM":
      return {
        ...state,
        history: state.history.map((item) =>
          item.id === action.payload.id
            ? { ...item, ...action.payload.updates } as HistoryItem
            : item
        ),
      };

    case "CLEAR_HISTORY":
      return { ...state, history: [] };

    case "ADD_TOOL_CALL":
      return { ...state, pendingToolCalls: [...state.pendingToolCalls, action.payload] };

    case "UPDATE_TOOL_CALL":
      return {
        ...state,
        pendingToolCalls: state.pendingToolCalls.map((tool) =>
          tool.id === action.payload.id
            ? { ...tool, ...action.payload.updates }
            : tool
        ),
      };

    case "CLEAR_TOOL_CALLS":
      return { ...state, pendingToolCalls: [] };

    case "SET_SESSION_ID":
      return { ...state, sessionId: action.payload };

    case "SET_PROVIDER":
      return { ...state, provider: action.payload };

    case "SET_MODEL":
      return { ...state, model: action.payload };

    case "SET_TOKEN_USAGE":
      return { ...state, tokenUsage: action.payload };

    case "SET_ERROR":
      return { ...state, error: action.payload };

    case "SET_LOADING":
      return { ...state, isLoading: action.payload };

    case "RESET_STATE":
      return { ...DEFAULT_UI_STATE, sessionId: state.sessionId };

    default:
      return state;
  }
}

// === Context ===

const UIStateContext = createContext<UIState | null>(null);
const UIActionsContext = createContext<UIActions | null>(null);

// === Provider Props ===

export interface UIStateProviderProps {
  children: ReactNode;
  initialState?: Partial<UIState>;
}

// === Provider ===

export function UIStateProvider({
  children,
  initialState,
}: UIStateProviderProps): React.ReactElement {
  const [state, dispatch] = useReducer(uiReducer, {
    ...DEFAULT_UI_STATE,
    ...initialState,
  });

  // === Actions ===

  const setStreamingState = useCallback((streamingState: StreamingState) => {
    dispatch({ type: "SET_STREAMING_STATE", payload: streamingState });
  }, []);

  const appendToResponse = useCallback((text: string) => {
    dispatch({ type: "APPEND_TO_RESPONSE", payload: text });
  }, []);

  const clearResponse = useCallback(() => {
    dispatch({ type: "CLEAR_RESPONSE" });
  }, []);

  const addHistoryItem = useCallback(
    (item: CreatableHistoryItem) => {
      const fullItem = createHistoryItem(item);
      dispatch({ type: "ADD_HISTORY_ITEM", payload: fullItem });
    },
    []
  );

  const updateHistoryItem = useCallback(
    (id: string, updates: Partial<HistoryItem>) => {
      dispatch({ type: "UPDATE_HISTORY_ITEM", payload: { id, updates } });
    },
    []
  );

  const clearHistory = useCallback(() => {
    dispatch({ type: "CLEAR_HISTORY" });
  }, []);

  const addToolCall = useCallback(
    (tool: Omit<ToolCall, "id" | "startTime">): string => {
      const fullTool = createToolCall(tool);
      dispatch({ type: "ADD_TOOL_CALL", payload: fullTool });
      return fullTool.id;
    },
    []
  );

  const updateToolCall = useCallback(
    (id: string, updates: Partial<ToolCall>) => {
      dispatch({ type: "UPDATE_TOOL_CALL", payload: { id, updates } });
    },
    []
  );

  const clearToolCalls = useCallback(() => {
    dispatch({ type: "CLEAR_TOOL_CALLS" });
  }, []);

  const setSessionId = useCallback((sessionId: string) => {
    dispatch({ type: "SET_SESSION_ID", payload: sessionId });
  }, []);

  const setMode = useCallback((mode: "code" | "ask") => {
    dispatch({ type: "SET_MODE", payload: mode });
  }, []);

  const setProvider = useCallback((provider: string) => {
    dispatch({ type: "SET_PROVIDER", payload: provider });
  }, []);

  const setModel = useCallback((model: string) => {
    dispatch({ type: "SET_MODEL", payload: model });
  }, []);

  const setTokenUsage = useCallback((usage: UIState["tokenUsage"]) => {
    dispatch({ type: "SET_TOKEN_USAGE", payload: usage });
  }, []);

  const setError = useCallback((error: string | undefined) => {
    dispatch({ type: "SET_ERROR", payload: error });
  }, []);

  const setLoading = useCallback((isLoading: boolean) => {
    dispatch({ type: "SET_LOADING", payload: isLoading });
  }, []);

  // Memoize actions to prevent unnecessary re-renders - 记忆化操作以防止不必要的重新渲染
  const actions = useMemo<UIActions>(
    () => ({
      setStreamingState,
      appendToResponse,
      clearResponse,
      addHistoryItem,
      updateHistoryItem,
      clearHistory,
      addToolCall,
      updateToolCall,
      clearToolCalls,
      setSessionId,
      setMode,
      setProvider,
      setModel,
      setTokenUsage,
      setError,
      setLoading,
    }),
    [
      setStreamingState,
      appendToResponse,
      clearResponse,
      addHistoryItem,
      updateHistoryItem,
      clearHistory,
      addToolCall,
      updateToolCall,
      clearToolCalls,
      setSessionId,
      setMode,
      setProvider,
      setModel,
      setTokenUsage,
      setError,
      setLoading,
    ]
  );

  return (
    <UIStateContext.Provider value={state}>
      <UIActionsContext.Provider value={actions}>
        {children}
      </UIActionsContext.Provider>
    </UIStateContext.Provider>
  );
}

// === Hooks ===

/**
 * Get UI state - 获取 UI 状态
 */
export function useUIState(): UIState {
  const context = useContext(UIStateContext);
  if (!context) {
    throw new Error("useUIState must be used within a UIStateProvider");
  }
  return context;
}

/**
 * Get UI actions - 获取 UI 操作
 */
export function useUIActions(): UIActions {
  const context = useContext(UIActionsContext);
  if (!context) {
    throw new Error("useUIActions must be used within a UIStateProvider");
  }
  return context;
}

/**
 * Get complete UI state and actions - 获取完整 UI 状态和操作
 */
export function useUI(): { state: UIState; actions: UIActions } {
  const state = useUIState();
  const actions = useUIActions();
  return { state, actions };
}

/**
 * Get current theme - 获取当前主题
 */
export function useTheme(): import("../types.js").Theme {
  const { getTheme } = require("../themes/index.js");
  return getTheme();
}

// === Exports ===

export { UIStateContext, UIActionsContext };
