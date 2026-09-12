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
import {
  getMessageQueue,
  type MessageDelivery,
  type QueuedMessage,
} from "@kodax-ai/agent";
import { StreamingState } from "../types.js";
import { MAX_PENDING_INPUTS } from "../utils/pending-inputs.js";

/**
 * FEATURE_159 (v0.7.40) — queue-as-source-of-truth.
 *
 * Pre-FEATURE_159 (v0.7.36 FEATURE_115): React `pendingInputs: string[]`
 * was the canonical source; we drained + re-enqueued the agent-side
 * MessageQueue after every React mutation (`syncPendingInputsToQueue`).
 * That direction failed two ways: (1) when idle-yield's
 * `waitForWakeEvent` drained the queue, React state stayed stale → UI
 * showed phantom "Queue N"; (2) the next round's `runQueuedPromptSequence`
 * then re-shifted from React state → duplicate processing of an already-
 * consumed prompt.
 *
 * Post-FEATURE_159: MessageQueue is canonical. React `pendingInputs`
 * mirrors a filtered slice (current session root + user priority + mode='prompt')
 * via a `queue.subscribe` callback. The manager methods write to the
 * queue directly; the queue's notify triggers the subscribe callback,
 * which rebuilds the React slice and fires `notify()`. Any consumer
 * (wake-drain, mid-turn yield, queued-prompt-sequence, test harness)
 * that mutates the queue automatically updates the UI.
 *
 * The same session-scoped predicate is reused by manager methods that need
 * to know which prompts belong to the active REPL session.
 */
function isPendingPromptForAgent(
  message: QueuedMessage,
  agentId: string | undefined,
): boolean {
  return (
    message.agentId === agentId &&
    message.priority === "user" &&
    message.mode === "prompt"
  );
}

function getPendingPrompts(agentId: string | undefined): readonly QueuedMessage[] {
  return getMessageQueue()
    .getSnapshot()
    .filter((message) => isPendingPromptForAgent(message, agentId));
}

function getPendingPromptContents(agentId: string | undefined): string[] {
  return getPendingPrompts(agentId).map((message) => message.content);
}

// === Types ===

/**
 * Iteration record - 迭代记录
 * Stores a snapshot of one iteration's thinking and response - 存储一轮迭代的 thinking 和响应快照
 */
export interface IterationRecord {
  /** Iteration number (1-based) - 迭代序号（从1开始） */
  iteration: number;
  /** Thinking content summary (truncated) - Thinking 内容摘要（截断） */
  thinkingSummary: string;
  /** Full thinking content length - 完整 thinking 内容长度 */
  thinkingLength: number;
  /** Response content - 响应内容 */
  response: string;
  /** Tools used in this iteration - 本轮使用的工具 */
  toolsUsed: string[];
}

/**
 * Streaming context value - 流式上下文值
 */
export interface StreamingContextValue {
  /** 当前流式状态 */
  state: StreamingState;

  /** 褰撳墠姝ｅ湪娴佸紡浼犺緭鐨勫搷搴?*/
  currentResponse: string;

  /** 错误信息 */
  error?: string;

  /** 鐢ㄤ簬鍙栨秷璇锋眰鐨?AbortController */
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

  /** 工具输入内容 (用于UI显示参数摘要) */
  toolInputContent: string;

  /** Iteration history - 迭代历史 */
  iterationHistory: IterationRecord[];

  /** Current iteration number (1-based) - 当前迭代序号（从1开始） */
  currentIteration: number;

  /** Maximum iterations allowed - 最大允许迭代次数 */
  maxIter: number;

  /** 是否正在压缩上下文 */
  isCompacting: boolean;
  pendingInputs: string[];

  /**
   * v0.7.41 — wall-clock timestamp captured when the current streaming
   * round started (set by `startStreaming()`, cleared to `null` by
   * `stopStreaming()` / `abort()` / `reset()`). Powers the inline
   * spinner-row "(Ns · ↓ T tokens)" stats tail (claudecode parity,
   * `c:/Works/claudecode/src/screens/REPL.tsx:932-953`
   * `loadingStartTimeRef`).
   */
  roundStartedAt: number | null;
}

/**
 * FEATURE_149 Phase 4 (v0.7.38) — `abort()` options.
 *
 * The default (no options) preserves the v0.6.0+ contract: abort drops the
 * queued follow-ups so Esc's "cancel everything" UX stays predictable. The
 * fast-abort path in `handleSubmit` (when the in-flight tool is tagged
 * `interruptBehavior: 'cancel'`) passes `{ preservePendingInputs: true }` so
 * the freshly-submitted prompt sitting in the queue survives the abort and
 * is picked up by the next `runQueuedPromptSequence` iteration.
 */
export interface AbortOptions {
  readonly preservePendingInputs?: boolean;
}

/**
 * Streaming actions interface - 娴佸紡鎿嶄綔鎺ュ彛
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
  abort: (options?: AbortOptions) => void;

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

  /** 璁剧疆褰撳墠宸ュ叿 */
  setCurrentTool: (tool: string | undefined) => void;

  /** 追加工具输入字符数 */
  appendToolInputChars: (count: number) => void;

  /** 追加工具输入内容 */
  appendToolInputContent: (text: string) => void;

  /** 清空工具输入内容 */
  clearToolInputContent: () => void;

  /** 获取当前的 AbortSignal (用于传递给 API 请求) */
  getSignal: () => AbortSignal | undefined;

  /** 获取完整响应内容（包括缓冲区中未刷新的内容）- 用于中断时保存 */
  getFullResponse: () => string;

  /** 获取完整 thinking 内容（包括缓冲区中未刷新的内容）- 用于持久化历史记录 */
  getThinkingContent: () => string;

  /** Start a new iteration - saves current content to history and clears for next round - 开始新迭代，保存当前内容到历史并清空 */
  startNewIteration: (iteration: number) => void;

  /** Clear iteration history - 清空迭代历史 */
  clearIterationHistory: () => void;

  /** Set maximum iterations - 设置最大迭代次数 */
  setMaxIter: (maxIter: number) => void;

  /** 开始压缩上下文 */
  startCompacting: () => void;

  /** 缁撴潫鍘嬬缉涓婁笅鏂?*/
  stopCompacting: () => void;
  addPendingInput: (input: string, options?: PendingInputOptions) => void;
  removeLastPendingInput: () => void;
  peekPendingInputDelivery: () => MessageDelivery | undefined;
  shiftPendingInput: () => string | undefined;
  clearPendingInputs: () => void;
  consumePendingInputs: () => string[];
  capturePendingInputCancellation: () => () => void;
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
  toolInputContent: "",
  iterationHistory: [],
  currentIteration: 1,
  maxIter: 200, // Default max iterations - 默认最大迭代次数
  isCompacting: false,
  pendingInputs: [],
  roundStartedAt: null,
};

// === Streaming Manager ===

/**
 * Streaming manager interface - 娴佸紡绠＄悊鍣ㄦ帴鍙?
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
  abort: (options?: AbortOptions) => void;

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

  /** 璁剧疆褰撳墠宸ュ叿 */
  setCurrentTool: (tool: string | undefined) => void;

  /** 追加工具输入字符数 */
  appendToolInputChars: (count: number) => void;

  /** 追加工具输入内容 */
  appendToolInputContent: (text: string) => void;

  /** 清空工具输入内容 */
  clearToolInputContent: () => void;

  /** 鑾峰彇褰撳墠鐨?AbortSignal */
  getSignal: () => AbortSignal | undefined;

  /** 获取完整响应内容（包括缓冲区中未刷新的内容） */
  getFullResponse: () => string;

  /** 获取完整 thinking 内容（包括缓冲区中未刷新的内容） */
  getThinkingContent: () => string;

  /** Start a new iteration - 开始新迭代 */
  startNewIteration: (iteration: number) => void;

  /** Clear iteration history - 清空迭代历史 */
  clearIterationHistory: () => void;

  /** Set maximum iterations - 设置最大迭代次数 */
  setMaxIter: (maxIter: number) => void;

  /** Start compacting context - 开始压缩上下文 */
  startCompacting: () => void;

  /** Stop compacting context - 缁撴潫鍘嬬缉涓婁笅鏂?*/
  stopCompacting: () => void;
  addPendingInput: (input: string, options?: PendingInputOptions) => void;
  removeLastPendingInput: () => void;
  peekPendingInputDelivery: () => MessageDelivery | undefined;
  shiftPendingInput: () => string | undefined;
  clearPendingInputs: () => void;
  consumePendingInputs: () => string[];
  capturePendingInputCancellation: () => () => void;

  /**
   * FEATURE_159 (v0.7.40) — release the queue subscription set up at
   * construction time. Production providers call this on unmount;
   * tests call it between cases to prevent stale listeners on the
   * process-global MessageQueue singleton.
   */
  dispose: () => void;
}

/**
 * Create streaming manager - 鍒涘缓娴佸紡绠＄悊鍣?
 *
 * Issue 048 fix: Use batch updates to reduce render frequency - Issue 048 修复: 使用批量更新减少渲染频率
 * - Buffer streaming text and thinking content to 80ms cycle - 流式文本和 thinking 内容缓冲到 80ms 周期
 * - Sync with Spinner animation to avoid race conditions - 与 Spinner 动画同步，避免竞态条件
 */
export interface StreamingManagerOptions {
  /** Resolve the queue routing key at operation time so /new and /load work. */
  readonly getPendingInputAgentId?: () => string | undefined;
}

export interface PendingInputOptions {
  /** `host` keeps explicit command invocations out of runtime model drains. */
  readonly delivery?: MessageDelivery;
}

export function createStreamingManager(
  options: StreamingManagerOptions = {},
): StreamingManager {
  const getPendingInputAgentId = (): string | undefined =>
    options.getPendingInputAgentId?.();
  // FEATURE_159 (v0.7.40) — initial state seeds pendingInputs from queue
  // snapshot in case the manager is recreated mid-session (queue persists
  // across React remount; we don't want to lose pending prompts).
  let state: StreamingContextValue = {
    ...DEFAULT_STREAMING_STATE,
    pendingInputs: getPendingPromptContents(getPendingInputAgentId()),
  };
  const listeners = new Set<StreamingStateListener>();

  // === Batch update buffer (Issue 048) - 鎵归噺鏇存柊缂撳啿鍖?(Issue 048) ===
  let pendingResponseText = "";
  let pendingThinkingText = "";
  let pendingThinkingChars = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  // Issue 116: Guard flag to reject buffer writes after abort.
  // Prevents residual stream callbacks from leaking text into the next round.
  let bufferSealed = false;

  /**
   * Flush interval (ms) - 刷新间隔
   * - 80ms syncs with Spinner animation frame - 80ms 涓?Spinner 鍔ㄧ敾甯у悓姝?
   * - User perceives as instant response within 100ms - 100ms 鍐呯殑鐢ㄦ埛鎰熺煡涓哄嵆鏃跺搷搴?
   */
  const FLUSH_INTERVAL = 80;

  const notify = () => {
    for (const listener of listeners) {
      listener(state);
    }
  };

  // FEATURE_159 (v0.7.40) — queue → React mirror. Every queue mutation
  // (enqueue from `addPendingInput`, dequeue from wake-drain / shift /
  // consume / Esc-pop, clear from reset) rebuilds the REPL's slice and
  // fires `notify()`. The earlier React → queue mirror direction is
  // deleted; the queue is canonical.
  //
  // Reference-equality guard: only update state + notify when the
  // filtered slice's length OR contents changed. Without this guard,
  // out-of-slice events (subagent task-notifications, sub-agent prompts)
  // would force a no-op React rerender on every event.
  const syncReactStateFromQueue = (): void => {
    const next = getPendingPromptContents(getPendingInputAgentId());
    if (next.length === state.pendingInputs.length) {
      let equal = true;
      for (let i = 0; i < next.length; i++) {
        if (next[i] !== state.pendingInputs[i]) {
          equal = false;
          break;
        }
      }
      if (equal) return;
    }
    state = { ...state, pendingInputs: next };
    notify();
  };

  const unsubscribeFromQueue = getMessageQueue().subscribe(() => {
    syncReactStateFromQueue();
  });

  /**
   * Drain the REPL's session-root user-prompt slice and
   * return their contents. Used by `clearPendingInputs` / `consumePendingInputs`
   * / `abort(preservePendingInputs:false)` / `reset`. Out-of-slice
   * messages (subagent task-notifications, sub-agent prompts) are
   * preserved — they're not the REPL's to discard.
   */
  const drainOurSlice = (): string[] => {
    const drained = getMessageQueue().dequeue({
      agentId: getPendingInputAgentId(),
      maxPriority: "user",
      mode: "prompt",
    });
    return drained.map((m) => m.content);
  };

  /**
   * Immediately apply buffer content and notify - 立即应用缓冲区内容并通知
   */
  const flushPendingUpdates = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    const hasUpdates = pendingResponseText || pendingThinkingText
      || pendingThinkingChars > 0;
    if (hasUpdates) {
      const nextThinkingContent = state.thinkingContent + pendingThinkingText;
      // Char count: when content arrives it is authoritative (length of the
      // string we now hold); when only char signals arrive (no content body,
      // e.g. tests or summary-only deltas), accumulate them onto the prior
      // count so the indicator still advances.
      const nextThinkingCharCount = pendingThinkingText
        ? nextThinkingContent.length
        : state.thinkingCharCount + pendingThinkingChars;
      state = {
        ...state,
        currentResponse: state.currentResponse + pendingResponseText,
        thinkingContent: nextThinkingContent,
        thinkingCharCount: nextThinkingCharCount,
        ...((pendingThinkingText || pendingThinkingChars > 0)
          ? { isThinking: true }
          : {}),
      };
      pendingResponseText = "";
      pendingThinkingText = "";
      pendingThinkingChars = 0;
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
      bufferSealed = false; // Issue 116: unseal buffer for the new round
      // Issue 116: discard any residual buffer from previous aborted round
      pendingResponseText = "";
      pendingThinkingText = "";
      pendingThinkingChars = 0;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      state = {
        ...state,
        state: StreamingState.Responding,
        currentResponse: "", // Issue 116: ensure clean slate
        abortController: new AbortController(),
        error: undefined,
        // v0.7.41 — capture wall-clock for spinner-tail elapsed display.
        // Always reset on startStreaming, matching the `currentResponse: ""`
        // round-start semantics (a fresh round starts elapsed from zero).
        roundStartedAt: Date.now(),
      };
      notify();
    },

    stopStreaming: () => {
      flushPendingUpdates(); // Flush before stopping to ensure all content displays - 停止前刷新，确保所有内容显示
      state = {
        ...state,
        state: StreamingState.Idle,
        abortController: undefined,
        roundStartedAt: null,
      };
      notify();
    },

    appendResponse: (text: string) => {
      if (bufferSealed) return; // Issue 116: reject writes after abort
      pendingResponseText += text;
      scheduleFlush();
    },

    clearResponse: () => {
      flushPendingUpdates(); // Flush before clearing - 娓呯┖鍓嶅埛鏂?
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

    abort: (options?: AbortOptions) => {
      bufferSealed = true; // Issue 116: seal buffer before flush to block racing callbacks
      flushPendingUpdates();
      state.abortController?.abort();
      // Issue 116: explicitly drain residual buffer that may have slipped through
      pendingResponseText = "";
      pendingThinkingText = "";
      pendingThinkingChars = 0;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      // FEATURE_159 (v0.7.40): queue is canonical. When NOT preserving,
      // drain the REPL's slice — `syncReactStateFromQueue` will land the
      // updated `pendingInputs:[]` on the next notify (synchronous via
      // queue.subscribe). FEATURE_149 (v0.7.38) preserve-queue path
      // means we leave the slice untouched.
      if (!options?.preservePendingInputs) {
        drainOurSlice();
      }
      state = {
        ...state,
        state: StreamingState.Idle,
        abortController: undefined,
        roundStartedAt: null,
      };
      notify();
    },

    reset: () => {
      bufferSealed = true; // Issue 116: seal during reset
      flushPendingUpdates();
      state.abortController?.abort();
      pendingResponseText = "";
      pendingThinkingText = "";
      pendingThinkingChars = 0;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      // FEATURE_159 (v0.7.40): drain our queue slice as part of full
      // reset. Other agents' queue entries (subagent task-notifications)
      // are not ours to clear.
      drainOurSlice();
      state = {
        ...DEFAULT_STREAMING_STATE,
        pendingInputs: getPendingPromptContents(getPendingInputAgentId()),
      };
      bufferSealed = false;
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
      if (bufferSealed) return;
      pendingThinkingChars += count;
      scheduleFlush();
    },

    appendThinkingContent: (text: string) => {
      if (bufferSealed) return; // Issue 116: reject writes after abort
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
        // thinkingContent is preserved for display - thinkingContent 淇濈暀鐢ㄤ簬鏄剧ず
      };
      notify();
    },

    clearThinkingContent: () => {
      flushPendingUpdates(); // Flush before clearing - 娓呯┖鍓嶅埛鏂?
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
      flushPendingUpdates(); // Flush before tool switch - 宸ュ叿鍒囨崲鍓嶅埛鏂?
      state = {
        ...state,
        currentTool: tool,
        toolInputCharCount: 0,
        toolInputContent: "", // Reset tool input content when tool changes
      };
      notify();
    },

    appendToolInputChars: (count: number) => {
      // Tool input deltas are infrequent — keep immediate to stay in sync
      // with appendToolInputContent (which is also immediate with 240-char cap).
      state = {
        ...state,
        toolInputCharCount: state.toolInputCharCount + count,
      };
      notify();
    },

    appendToolInputContent: (text: string) => {
      // Limit content to ~100 chars for display (no need to store full input)
      // 限制内容为 ~100 字符用于显示（无需存储完整输入）
      if (state.toolInputContent.length < 240) {
        state = {
          ...state,
          toolInputContent: (state.toolInputContent + text).slice(0, 240),
        };
        notify();
      }
    },

    clearToolInputContent: () => {
      state = {
        ...state,
        toolInputContent: "",
      };
      notify();
    },

    getSignal: () => state.abortController?.signal,

    getFullResponse: () => {
      // Return current response + any pending buffered content
      // 返回当前响应 + 缓冲区中未刷新的内容
      return state.currentResponse + pendingResponseText;
    },

    getThinkingContent: () => {
      // Return current thinking + any pending buffered content
      // 返回当前 thinking + 缓冲区中未刷新的内容
      return state.thinkingContent + pendingThinkingText;
    },

    /**
     * Start a new iteration - clears current content for next round
     * 开始新迭代 - 清空当前内容准备下一轮
     * Note: Content is already saved to history by onIterationStart callback in InkREPL
     * 注意：内容已经通过 InkREPL 的 onIterationStart 回调保存到 history
     */
    startNewIteration: (iteration: number) => {
      flushPendingUpdates(); // Flush before clearing - 娓呯┖鍓嶅埛鏂?

      // Just clear current content for next iteration - only clear if there's content
      // 清空当前内容准备下一轮 - 只有在有内容时才清空
      if (state.thinkingContent || state.currentResponse) {
        state = {
          ...state,
          // Clear current content for next iteration - 清空当前内容准备下一轮
          thinkingContent: "",
          thinkingCharCount: 0,
          currentResponse: "",
          isThinking: false,
          currentTool: undefined,
          toolInputCharCount: 0,
          toolInputContent: "",
          currentIteration: iteration,
        };
      } else {
        // No content, just update iteration number - 没有内容，只更新迭代号
        state = {
          ...state,
          currentIteration: iteration,
        };
      }

      notify();
    },

    /**
     * Clear iteration history - 清空迭代历史
     */
    clearIterationHistory: () => {
      flushPendingUpdates();
      state = {
        ...state,
        iterationHistory: [],
        currentIteration: 1,
        maxIter: DEFAULT_STREAMING_STATE.maxIter,
        thinkingContent: "",
        thinkingCharCount: 0,
        currentResponse: "",
        currentTool: undefined,
        toolInputCharCount: 0,
        toolInputContent: "",
      };
      notify();
    },

    /**
     * Set maximum iterations - 设置最大迭代次数
     */
    setMaxIter: (maxIter: number) => {
      flushPendingUpdates();
      state = {
        ...state,
        maxIter,
      };
      notify();
    },

    /**
     * Start compacting context - 开始压缩上下文
     */
    startCompacting: () => {
      flushPendingUpdates();
      state = {
        ...state,
        isCompacting: true,
      };
      notify();
    },

    /**
     * Stop compacting context - 缁撴潫鍘嬬缉涓婁笅鏂?
     */
    stopCompacting: () => {
      flushPendingUpdates();
      state = {
        ...state,
        isCompacting: false,
      };
      notify();
    },

    // FEATURE_159 (v0.7.40) — all five pending-input methods now route
    // through the queue. The queue's `subscribe` callback handles React
    // state sync + `notify()`; manager methods don't touch `state`
    // directly. `flushPendingUpdates()` is still called so any in-flight
    // streaming buffer doesn't race the user's queue mutation.
    //
    // MAX_PENDING_INPUTS gating reads the live snapshot (queue is
    // canonical) rather than `state.pendingInputs.length`, so a stale
    // React render in the same tick can't allow over-quota enqueue.
    addPendingInput: (input: string, inputOptions?: PendingInputOptions) => {
      const trimmed = input.trim();
      if (!trimmed) return;
      if (getPendingPrompts(getPendingInputAgentId()).length >= MAX_PENDING_INPUTS) return;

      flushPendingUpdates();
      getMessageQueue().enqueue({
        agentId: getPendingInputAgentId(),
        priority: "user",
        mode: "prompt",
        delivery: inputOptions?.delivery,
        content: trimmed,
      });
    },

    removeLastPendingInput: () => {
      const prompts = getPendingPrompts(getPendingInputAgentId());
      const last = prompts[prompts.length - 1];
      if (!last) return;

      flushPendingUpdates();
      getMessageQueue().dequeue({
        agentId: getPendingInputAgentId(),
        maxPriority: "user",
        mode: "prompt",
        id: last.id,
      });
    },

    capturePendingInputCancellation: () => {
      const agentId = getPendingInputAgentId();
      const ids = getPendingPrompts(agentId).map((message) => message.id);
      return () => {
        for (const id of ids) getMessageQueue().dequeue({ agentId, maxPriority: "user", mode: "prompt", id });
      };
    },

    peekPendingInputDelivery: () => {
      return getPendingPrompts(getPendingInputAgentId())[0]?.delivery;
    },

    shiftPendingInput: () => {
      flushPendingUpdates();
      const drained = getMessageQueue().dequeue({
        agentId: getPendingInputAgentId(),
        maxPriority: "user",
        mode: "prompt",
        limit: 1,
      });
      return drained[0]?.content;
    },

    clearPendingInputs: () => {
      flushPendingUpdates();
      drainOurSlice();
    },

    consumePendingInputs: () => {
      flushPendingUpdates();
      return drainOurSlice();
    },

    dispose: () => {
      unsubscribeFromQueue();
    },
  };
}

// === Context ===

const StreamingContextValueContext = createContext<StreamingContextValue | null>(null);
const StreamingActionsContext = createContext<StreamingActions | null>(null);

// === Provider Props ===

export interface StreamingProviderProps {
  children: ReactNode;
  onStateChange?: (state: StreamingContextValue) => void;
  getPendingInputAgentId?: () => string | undefined;
}

// === Provider ===

/**
 * StreamingProvider - Provides streaming response management - 鎻愪緵娴佸紡鍝嶅簲绠＄悊
 */
export function StreamingProvider({
  children,
  onStateChange,
  getPendingInputAgentId,
}: StreamingProviderProps): React.ReactElement {
  const pendingInputAgentIdResolver = useRef(getPendingInputAgentId);
  pendingInputAgentIdResolver.current = getPendingInputAgentId;
  const managerRef = useRef<StreamingManager | undefined>(undefined);
  if (!managerRef.current) {
    managerRef.current = createStreamingManager({
      getPendingInputAgentId: () => pendingInputAgentIdResolver.current?.(),
    });
  }
  const manager = managerRef.current;
  const [, forceUpdate] = useReducer((x) => x + 1, 0);

  // Subscribe to state changes - 订阅状态变更
  useEffect(() => {
    const unsubscribe = manager.subscribe((state) => {
      forceUpdate();
      onStateChange?.(state);
    });

    return unsubscribe;
  }, [manager, onStateChange]);

  // FEATURE_159 (v0.7.40) — release the manager's queue subscription on
  // provider unmount so the process-global MessageQueue doesn't retain
  // a stale listener after hot reload / test teardown.
  useEffect(() => {
    return () => {
      manager.dispose();
    };
  }, [manager]);

  // === Actions ===

  const startStreaming = useCallback(() => {
    manager.startStreaming();
  }, []);

  const stopStreaming = useCallback(() => {
    manager.stopStreaming();
  }, []);

  const appendResponse = useCallback((text: string) => {
    manager.appendResponse(text);
  }, []);

  const clearResponse = useCallback(() => {
    manager.clearResponse();
  }, []);

  const setError = useCallback((error: string | undefined) => {
    manager.setError(error);
  }, []);

  const abort = useCallback((options?: AbortOptions) => {
    manager.abort(options);
  }, []);

  const reset = useCallback(() => {
    manager.reset();
  }, []);

  const startThinking = useCallback(() => {
    manager.startThinking();
  }, []);

  const appendThinkingChars = useCallback((count: number) => {
    manager.appendThinkingChars(count);
  }, []);

  const appendThinkingContent = useCallback((text: string) => {
    manager.appendThinkingContent(text);
  }, []);

  const stopThinking = useCallback(() => {
    manager.stopThinking();
  }, []);

  const clearThinkingContent = useCallback(() => {
    manager.clearThinkingContent();
  }, []);

  const setCurrentTool = useCallback((tool: string | undefined) => {
    manager.setCurrentTool(tool);
  }, []);

  const appendToolInputChars = useCallback((count: number) => {
    manager.appendToolInputChars(count);
  }, []);

  const appendToolInputContent = useCallback((text: string) => {
    manager.appendToolInputContent(text);
  }, []);

  const clearToolInputContent = useCallback(() => {
    manager.clearToolInputContent();
  }, []);

  const getSignal = useCallback(() => {
    return manager.getSignal();
  }, []);

  const getFullResponse = useCallback(() => {
    return manager.getFullResponse();
  }, []);

  const getThinkingContent = useCallback(() => {
    return manager.getThinkingContent();
  }, []);

  const startNewIteration = useCallback((iteration: number) => {
    manager.startNewIteration(iteration);
  }, []);

  const clearIterationHistory = useCallback(() => {
    manager.clearIterationHistory();
  }, []);

  const setMaxIter = useCallback((maxIter: number) => {
    manager.setMaxIter(maxIter);
  }, []);

  const startCompacting = useCallback(() => {
    manager.startCompacting();
  }, []);

  const stopCompacting = useCallback(() => {
    manager.stopCompacting();
  }, []);

  const addPendingInput = useCallback((input: string, inputOptions?: PendingInputOptions) => {
    manager.addPendingInput(input, inputOptions);
  }, []);

  const removeLastPendingInput = useCallback(() => {
    manager.removeLastPendingInput();
  }, []);

  const shiftPendingInput = useCallback(() => {
    return manager.shiftPendingInput();
  }, []);

  const peekPendingInputDelivery = useCallback(() => {
    return manager.peekPendingInputDelivery();
  }, []);

  const clearPendingInputs = useCallback(() => {
    manager.clearPendingInputs();
  }, []);

  const consumePendingInputs = useCallback(() => {
    return manager.consumePendingInputs();
  }, []);
  const capturePendingInputCancellation = useCallback(() => manager.capturePendingInputCancellation(), []);

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
    appendToolInputContent,
    clearToolInputContent,
    getSignal,
    getFullResponse,
    getThinkingContent,
    startNewIteration,
    clearIterationHistory,
    setMaxIter,
    startCompacting,
    stopCompacting,
    addPendingInput,
    removeLastPendingInput,
    peekPendingInputDelivery,
    shiftPendingInput,
    clearPendingInputs,
    consumePendingInputs,
    capturePendingInputCancellation,
  };

  return React.createElement(
    StreamingContextValueContext.Provider,
    { value: manager.getState() },
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
