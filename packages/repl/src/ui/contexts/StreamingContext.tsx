/**
 * StreamingContext - Streaming Response Handling
 *
 * 参考 Gemini CLI 的 StreamingContext 架构实现。
 * 管理流式响应状态、取消操作和错误处理。
 */

import React, {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from "react";
import { StreamingState } from "../types.js";

// === Types ===

/**
 * 流式上下文值
 */
export interface StreamingContextValue {
  /** 当前流式状态 */
  state: StreamingState;

  /** 当前正在流式传输的响应 */
  currentResponse: string;

  /** 错误信息 */
  error?: string;

  /** 用于取消请求的 AbortController */
  abortController?: AbortController;

  /** 是否正在 thinking */
  isThinking: boolean;

  /** Thinking 字符计数 */
  thinkingCharCount: number;

  /** Thinking 内容 (用于UI显示) */
  thinkingContent: string;

  /** 当前执行的工具名称 */
  currentTool?: string;

  /** 工具输入字符计数 */
  toolInputCharCount: number;
}

/**
 * 流式操作接口
 */
export interface StreamingActions {
  /** 开始流式响应 */
  startStreaming: () => void;

  /** 停止流式响应 */
  stopStreaming: () => void;

  /** 追加响应文本 */
  appendResponse: (text: string) => void;

  /** 清空响应 */
  clearResponse: () => void;

  /** 设置错误 */
  setError: (error: string | undefined) => void;

  /** 取消当前流式响应 */
  abort: () => void;

  /** 重置状态 */
  reset: () => void;

  /** 开始 thinking */
  startThinking: () => void;

  /** 追加 thinking 字符数 */
  appendThinkingChars: (count: number) => void;

  /** 追加 thinking 内容 */
  appendThinkingContent: (text: string) => void;

  /** 结束 thinking */
  stopThinking: () => void;

  /** 设置当前工具 */
  setCurrentTool: (tool: string | undefined) => void;

  /** 追加工具输入字符数 */
  appendToolInputChars: (count: number) => void;

  /** 获取当前的 AbortSignal (用于传递给 API 请求) */
  getSignal: () => AbortSignal | undefined;
}

/**
 * 状态变更监听器
 */
export type StreamingStateListener = (state: StreamingContextValue) => void;

// === Default State ===

const DEFAULT_STREAMING_STATE: StreamingContextValue = {
  state: StreamingState.Idle,
  currentResponse: "",
  error: undefined,
  abortController: undefined,
  isThinking: false,
  thinkingCharCount: 0,
  thinkingContent: "",
  currentTool: undefined,
  toolInputCharCount: 0,
};

// === Streaming Manager ===

/**
 * 流式管理器接口
 */
export interface StreamingManager {
  /** 获取当前状态 */
  getState: () => StreamingContextValue;

  /** 设置流式状态 */
  setState: (state: StreamingState) => void;

  /** 开始流式响应 */
  startStreaming: () => void;

  /** 停止流式响应 */
  stopStreaming: () => void;

  /** 追加响应文本 */
  appendResponse: (text: string) => void;

  /** 清空响应 */
  clearResponse: () => void;

  /** 设置错误 */
  setError: (error: string | undefined) => void;

  /** 取消当前流式响应 */
  abort: () => void;

  /** 重置状态 */
  reset: () => void;

  /** 是否正在流式传输 */
  isStreaming: () => boolean;

  /** 订阅状态变更 */
  subscribe: (listener: StreamingStateListener) => () => void;

  /** 开始 thinking */
  startThinking: () => void;

  /** 追加 thinking 字符数 */
  appendThinkingChars: (count: number) => void;

  /** 追加 thinking 内容 */
  appendThinkingContent: (text: string) => void;

  /** 结束 thinking */
  stopThinking: () => void;

  /** 设置当前工具 */
  setCurrentTool: (tool: string | undefined) => void;

  /** 追加工具输入字符数 */
  appendToolInputChars: (count: number) => void;

  /** 获取当前的 AbortSignal */
  getSignal: () => AbortSignal | undefined;
}

/**
 * 创建流式管理器
 */
export function createStreamingManager(): StreamingManager {
  let state: StreamingContextValue = { ...DEFAULT_STREAMING_STATE };
  const listeners = new Set<StreamingStateListener>();

  const notify = () => {
    for (const listener of listeners) {
      listener(state);
    }
  };

  return {
    getState: () => state,

    setState: (newState: StreamingState) => {
      state = { ...state, state: newState };
      notify();
    },

    startStreaming: () => {
      state = {
        ...state,
        state: StreamingState.Responding,
        abortController: new AbortController(),
        error: undefined,
      };
      notify();
    },

    stopStreaming: () => {
      state = {
        ...state,
        state: StreamingState.Idle,
        abortController: undefined,
      };
      notify();
    },

    appendResponse: (text: string) => {
      state = {
        ...state,
        currentResponse: state.currentResponse + text,
      };
      notify();
    },

    clearResponse: () => {
      state = {
        ...state,
        currentResponse: "",
      };
      notify();
    },

    setError: (error: string | undefined) => {
      state = {
        ...state,
        error,
        state: error ? StreamingState.Idle : state.state,
      };
      notify();
    },

    abort: () => {
      state.abortController?.abort();
      state = {
        ...state,
        state: StreamingState.Idle,
        abortController: undefined,
      };
      notify();
    },

    reset: () => {
      state.abortController?.abort();
      state = { ...DEFAULT_STREAMING_STATE };
      notify();
    },

    isStreaming: () => {
      return (
        state.state === StreamingState.Responding ||
        state.state === StreamingState.WaitingForConfirmation
      );
    },

    subscribe: (listener: StreamingStateListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    startThinking: () => {
      state = {
        ...state,
        isThinking: true,
        thinkingCharCount: 0,
        thinkingContent: "",
      };
      notify();
    },

    appendThinkingChars: (count: number) => {
      state = {
        ...state,
        isThinking: true,
        thinkingCharCount: state.thinkingCharCount + count,
      };
      notify();
    },

    appendThinkingContent: (text: string) => {
      state = {
        ...state,
        isThinking: true,
        thinkingContent: state.thinkingContent + text,
        thinkingCharCount: state.thinkingContent.length + text.length,
      };
      notify();
    },

    stopThinking: () => {
      // Don't clear thinkingContent - preserve it for display
      // Only reset isThinking flag to hide the Thinking indicator
      state = {
        ...state,
        isThinking: false,
        thinkingCharCount: 0,
        // thinkingContent is preserved for display
      };
      notify();
    },

    setCurrentTool: (tool: string | undefined) => {
      state = {
        ...state,
        currentTool: tool,
        toolInputCharCount: 0,
      };
      notify();
    },

    appendToolInputChars: (count: number) => {
      state = {
        ...state,
        toolInputCharCount: state.toolInputCharCount + count,
      };
      notify();
    },

    getSignal: () => state.abortController?.signal,
  };
}

// === Context ===

const StreamingContextValueContext = createContext<StreamingContextValue | null>(null);
const StreamingActionsContext = createContext<StreamingActions | null>(null);

// === Provider Props ===

export interface StreamingProviderProps {
  children: ReactNode;
  onStateChange?: (state: StreamingContextValue) => void;
}

// === Provider ===

/**
 * StreamingProvider - 提供流式响应管理
 */
export function StreamingProvider({
  children,
  onStateChange,
}: StreamingProviderProps): React.ReactElement {
  const managerRef = useRef<StreamingManager>(createStreamingManager());
  const [, forceUpdate] = useReducer((x) => x + 1, 0);

  // 订阅状态变更
  useEffect(() => {
    const unsubscribe = managerRef.current.subscribe((state) => {
      forceUpdate();
      onStateChange?.(state);
    });

    return unsubscribe;
  }, [onStateChange]);

  // === Actions ===

  const startStreaming = useCallback(() => {
    managerRef.current.startStreaming();
  }, []);

  const stopStreaming = useCallback(() => {
    managerRef.current.stopStreaming();
  }, []);

  const appendResponse = useCallback((text: string) => {
    managerRef.current.appendResponse(text);
  }, []);

  const clearResponse = useCallback(() => {
    managerRef.current.clearResponse();
  }, []);

  const setError = useCallback((error: string | undefined) => {
    managerRef.current.setError(error);
  }, []);

  const abort = useCallback(() => {
    managerRef.current.abort();
  }, []);

  const reset = useCallback(() => {
    managerRef.current.reset();
  }, []);

  const startThinking = useCallback(() => {
    managerRef.current.startThinking();
  }, []);

  const appendThinkingChars = useCallback((count: number) => {
    managerRef.current.appendThinkingChars(count);
  }, []);

  const appendThinkingContent = useCallback((text: string) => {
    managerRef.current.appendThinkingContent(text);
  }, []);

  const stopThinking = useCallback(() => {
    managerRef.current.stopThinking();
  }, []);

  const setCurrentTool = useCallback((tool: string | undefined) => {
    managerRef.current.setCurrentTool(tool);
  }, []);

  const appendToolInputChars = useCallback((count: number) => {
    managerRef.current.appendToolInputChars(count);
  }, []);

  const getSignal = useCallback(() => {
    return managerRef.current.getSignal();
  }, []);

  const actions: StreamingActions = {
    startStreaming,
    stopStreaming,
    appendResponse,
    clearResponse,
    setError,
    abort,
    reset,
    startThinking,
    appendThinkingChars,
    appendThinkingContent,
    stopThinking,
    setCurrentTool,
    appendToolInputChars,
    getSignal,
  };

  return React.createElement(
    StreamingContextValueContext.Provider,
    { value: managerRef.current.getState() },
    React.createElement(
      StreamingActionsContext.Provider,
      { value: actions },
      children
    )
  );
}

// === Hooks ===

/**
 * 获取流式状态
 */
export function useStreamingState(): StreamingContextValue {
  const context = useContext(StreamingContextValueContext);
  if (!context) {
    throw new Error("useStreamingState must be used within a StreamingProvider");
  }
  return context;
}

/**
 * 获取流式操作
 */
export function useStreamingActions(): StreamingActions {
  const context = useContext(StreamingActionsContext);
  if (!context) {
    throw new Error("useStreamingActions must be used within a StreamingProvider");
  }
  return context;
}

/**
 * 获取完整流式状态和操作
 */
export function useStreaming(): {
  state: StreamingContextValue;
  actions: StreamingActions;
  isStreaming: boolean;
} {
  const state = useStreamingState();
  const actions = useStreamingActions();

  const isStreaming =
    state.state === StreamingState.Responding ||
    state.state === StreamingState.WaitingForConfirmation;

  return { state, actions, isStreaming };
}

// === Exports ===

export { StreamingContextValueContext, StreamingActionsContext };
