/**
 * StreamingContext - Streaming Response Handling
 *
 * Reference implementation based on Gemini CLI's StreamingContext architecture - 参考 Gemini CLI 的 StreamingContext 架构实现
 * Manages streaming response state, cancellation operations, and error handling - 管理流式响应状态、取消操作和错误处理
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
 * Streaming context value - 流式上下文值
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
 * Streaming actions interface - 流式操作接口
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

  /** 清空 thinking 内容 (响应完成时调用) */
  clearThinkingContent: () => void;

  /** 设置当前工具 */
  setCurrentTool: (tool: string | undefined) => void;

  /** 追加工具输入字符数 */
  appendToolInputChars: (count: number) => void;

  /** 获取当前的 AbortSignal (用于传递给 API 请求) */
  getSignal: () => AbortSignal | undefined;
}

/**
 * State change listener - 状态变更监听器
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
 * Streaming manager interface - 流式管理器接口
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

  /** 清空 thinking 内容 (响应完成时调用) */
  clearThinkingContent: () => void;

  /** 设置当前工具 */
  setCurrentTool: (tool: string | undefined) => void;

  /** 追加工具输入字符数 */
  appendToolInputChars: (count: number) => void;

  /** 获取当前的 AbortSignal */
  getSignal: () => AbortSignal | undefined;
}

/**
 * Create streaming manager - 创建流式管理器
 *
 * Issue 048 fix: Use batch updates to reduce render frequency - Issue 048 修复: 使用批量更新减少渲染频率
 * - Buffer streaming text and thinking content to 80ms cycle - 流式文本和 thinking 内容缓冲到 80ms 周期
 * - Sync with Spinner animation to avoid race conditions - 与 Spinner 动画同步，避免竞态条件
 */
export function createStreamingManager(): StreamingManager {
  let state: StreamingContextValue = { ...DEFAULT_STREAMING_STATE };
  const listeners = new Set<StreamingStateListener>();

  // === Batch update buffer (Issue 048) - 批量更新缓冲区 (Issue 048) ===
  let pendingResponseText = "";
  let pendingThinkingText = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Flush interval (ms) - 刷新间隔
   * - 80ms syncs with Spinner animation frame - 80ms 与 Spinner 动画帧同步
   * - User perceives as instant response within 100ms - 100ms 内的用户感知为即时响应
   */
  const FLUSH_INTERVAL = 80;

  const notify = () => {
    for (const listener of listeners) {
      listener(state);
    }
  };

  /**
   * Immediately apply buffer content and notify - 立即应用缓冲区内容并通知
   */
  const flushPendingUpdates = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    const hasUpdates = pendingResponseText || pendingThinkingText;
    if (hasUpdates) {
      state = {
        ...state,
        currentResponse: state.currentResponse + pendingResponseText,
        thinkingContent: state.thinkingContent + pendingThinkingText,
        thinkingCharCount: state.thinkingContent.length + pendingThinkingText.length,
      };
      pendingResponseText = "";
      pendingThinkingText = "";
      notify();
    }
  };

  /**
   * Schedule delayed flush - 安排延迟刷新
   */
  const scheduleFlush = () => {
    if (!flushTimer) {
      flushTimer = setTimeout(flushPendingUpdates, FLUSH_INTERVAL);
    }
  };

  return {
    getState: () => state,

    setState: (newState: StreamingState) => {
      flushPendingUpdates(); // Flush before state change - 状态切换前刷新
      state = { ...state, state: newState };
      notify();
    },

    startStreaming: () => {
      flushPendingUpdates(); // Flush before starting - 开始前刷新
      state = {
        ...state,
        state: StreamingState.Responding,
        abortController: new AbortController(),
        error: undefined,
      };
      notify();
    },

    stopStreaming: () => {
      flushPendingUpdates(); // Flush before stopping to ensure all content displays - 停止前刷新，确保所有内容显示
      state = {
        ...state,
        state: StreamingState.Idle,
        abortController: undefined,
      };
      notify();
    },

    appendResponse: (text: string) => {
      pendingResponseText += text;
      scheduleFlush();
    },

    clearResponse: () => {
      flushPendingUpdates(); // Flush before clearing - 清空前刷新
      state = {
        ...state,
        currentResponse: "",
      };
      notify();
    },

    setError: (error: string | undefined) => {
      flushPendingUpdates(); // Flush before setting error - 错误前刷新
      state = {
        ...state,
        error,
        state: error ? StreamingState.Idle : state.state,
      };
      notify();
    },

    abort: () => {
      flushPendingUpdates(); // Flush before aborting to ensure received content displays - 中断前刷新，确保已接收内容显示
      state.abortController?.abort();
      state = {
        ...state,
        state: StreamingState.Idle,
        abortController: undefined,
      };
      notify();
    },

    reset: () => {
      flushPendingUpdates(); // Flush before resetting - 重置前刷新
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
      flushPendingUpdates(); // Flush before starting thinking - 开始 thinking 前刷新
      state = {
        ...state,
        isThinking: true,
        thinkingCharCount: 0,
        thinkingContent: "",
      };
      notify();
    },

    appendThinkingChars: (count: number) => {
      // Character count doesn't need batch update, update directly - 字符计数不需要批量更新，直接更新
      state = {
        ...state,
        isThinking: true,
        thinkingCharCount: state.thinkingCharCount + count,
      };
      notify();
    },

    appendThinkingContent: (text: string) => {
      pendingThinkingText += text;
      scheduleFlush();
    },

    stopThinking: () => {
      flushPendingUpdates(); // Flush before stopping - 停止前刷新
      // Don't clear thinkingContent - preserve it for display
      // Only reset isThinking flag to hide the Thinking indicator
      state = {
        ...state,
        isThinking: false,
        thinkingCharCount: 0,
        // thinkingContent is preserved for display - thinkingContent 保留用于显示
      };
      notify();
    },

    clearThinkingContent: () => {
      flushPendingUpdates(); // Flush before clearing - 清空前刷新
      // Clear thinking content when response completes - 响应完成时清除 thinking 内容
      state = {
        ...state,
        isThinking: false,
        thinkingCharCount: 0,
        thinkingContent: "",
      };
      notify();
    },

    setCurrentTool: (tool: string | undefined) => {
      flushPendingUpdates(); // Flush before tool switch - 工具切换前刷新
      state = {
        ...state,
        currentTool: tool,
        toolInputCharCount: 0,
      };
      notify();
    },

    appendToolInputChars: (count: number) => {
      // Character count doesn't need batch update, update directly - 字符计数不需要批量更新，直接更新
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
 * StreamingProvider - Provides streaming response management - 提供流式响应管理
 */
export function StreamingProvider({
  children,
  onStateChange,
}: StreamingProviderProps): React.ReactElement {
  const managerRef = useRef<StreamingManager>(createStreamingManager());
  const [, forceUpdate] = useReducer((x) => x + 1, 0);

  // Subscribe to state changes - 订阅状态变更
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

  const clearThinkingContent = useCallback(() => {
    managerRef.current.clearThinkingContent();
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
    clearThinkingContent,
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
 * Get streaming state - 获取流式状态
 */
export function useStreamingState(): StreamingContextValue {
  const context = useContext(StreamingContextValueContext);
  if (!context) {
    throw new Error("useStreamingState must be used within a StreamingProvider");
  }
  return context;
}

/**
 * Get streaming actions - 获取流式操作
 */
export function useStreamingActions(): StreamingActions {
  const context = useContext(StreamingActionsContext);
  if (!context) {
    throw new Error("useStreamingActions must be used within a StreamingProvider");
  }
  return context;
}

/**
 * Get complete streaming state and actions - 获取完整流式状态和操作
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
