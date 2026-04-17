/**
 * StreamingContext - Streaming Response Handling
 *
 * Reference implementation based on Gemini CLI's StreamingContext architecture - 鍙傝€?Gemini CLI 鐨?StreamingContext 鏋舵瀯瀹炵幇
 * Manages streaming response state, cancellation operations, and error handling - 绠＄悊娴佸紡鍝嶅簲鐘舵€併€佸彇娑堟搷浣滃拰閿欒澶勭悊
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
import { MAX_PENDING_INPUTS } from "../utils/pending-inputs.js";

// === Types ===

/**
 * Iteration record - 杩唬璁板綍
 * Stores a snapshot of one iteration's thinking and response - 瀛樺偍涓€杞凯浠ｇ殑 thinking 鍜屽搷搴斿揩鐓?
 */
export interface IterationRecord {
  /** Iteration number (1-based) - 杩唬搴忓彿锛堜粠1寮€濮嬶級 */
  iteration: number;
  /** Thinking content summary (truncated) - Thinking 鍐呭鎽樿锛堟埅鏂級 */
  thinkingSummary: string;
  /** Full thinking content length - 瀹屾暣 thinking 鍐呭闀垮害 */
  thinkingLength: number;
  /** Response content - 鍝嶅簲鍐呭 */
  response: string;
  /** Tools used in this iteration - 鏈疆浣跨敤鐨勫伐鍏?*/
  toolsUsed: string[];
}

/**
 * Streaming context value - 娴佸紡涓婁笅鏂囧€?
 */
export interface StreamingContextValue {
  /** 褰撳墠娴佸紡鐘舵€?*/
  state: StreamingState;

  /** 褰撳墠姝ｅ湪娴佸紡浼犺緭鐨勫搷搴?*/
  currentResponse: string;

  /** 閿欒淇℃伅 */
  error?: string;

  /** 鐢ㄤ簬鍙栨秷璇锋眰鐨?AbortController */
  abortController?: AbortController;

  /** 鏄惁姝ｅ湪 thinking */
  isThinking: boolean;

  /** Thinking 瀛楃璁℃暟 */
  thinkingCharCount: number;

  /** Thinking 鍐呭 (鐢ㄤ簬UI鏄剧ず) */
  thinkingContent: string;

  /** 褰撳墠鎵ц鐨勫伐鍏峰悕绉?*/
  currentTool?: string;

  /** 宸ュ叿杈撳叆瀛楃璁℃暟 */
  toolInputCharCount: number;

  /** 宸ュ叿杈撳叆鍐呭 (鐢ㄤ簬UI鏄剧ず鍙傛暟鎽樿) */
  toolInputContent: string;

  /** Iteration history - 杩唬鍘嗗彶 */
  iterationHistory: IterationRecord[];

  /** Current iteration number (1-based) - 褰撳墠杩唬搴忓彿锛堜粠1寮€濮嬶級 */
  currentIteration: number;

  /** Maximum iterations allowed - 鏈€澶у厑璁歌凯浠ｆ鏁?*/
  maxIter: number;

  /** 鏄惁姝ｅ湪鍘嬬缉涓婁笅鏂?*/
  isCompacting: boolean;
  pendingInputs: string[];
}

/**
 * Streaming actions interface - 娴佸紡鎿嶄綔鎺ュ彛
 */
export interface StreamingActions {
  /** 寮€濮嬫祦寮忓搷搴?*/
  startStreaming: () => void;

  /** 鍋滄娴佸紡鍝嶅簲 */
  stopStreaming: () => void;

  /** 杩藉姞鍝嶅簲鏂囨湰 */
  appendResponse: (text: string) => void;

  /** 娓呯┖鍝嶅簲 */
  clearResponse: () => void;

  /** 璁剧疆閿欒 */
  setError: (error: string | undefined) => void;

  /** 鍙栨秷褰撳墠娴佸紡鍝嶅簲 */
  abort: () => void;

  /** 閲嶇疆鐘舵€?*/
  reset: () => void;

  /** 寮€濮?thinking */
  startThinking: () => void;

  /** 杩藉姞 thinking 瀛楃鏁?*/
  appendThinkingChars: (count: number) => void;

  /** 杩藉姞 thinking 鍐呭 */
  appendThinkingContent: (text: string) => void;

  /** 缁撴潫 thinking */
  stopThinking: () => void;

  /** 娓呯┖ thinking 鍐呭 (鍝嶅簲瀹屾垚鏃惰皟鐢? */
  clearThinkingContent: () => void;

  /** 璁剧疆褰撳墠宸ュ叿 */
  setCurrentTool: (tool: string | undefined) => void;

  /** 杩藉姞宸ュ叿杈撳叆瀛楃鏁?*/
  appendToolInputChars: (count: number) => void;

  /** 杩藉姞宸ュ叿杈撳叆鍐呭 */
  appendToolInputContent: (text: string) => void;

  /** 娓呯┖宸ュ叿杈撳叆鍐呭 */
  clearToolInputContent: () => void;

  /** 鑾峰彇褰撳墠鐨?AbortSignal (鐢ㄤ簬浼犻€掔粰 API 璇锋眰) */
  getSignal: () => AbortSignal | undefined;

  /** 鑾峰彇瀹屾暣鍝嶅簲鍐呭锛堝寘鎷紦鍐插尯涓湭鍒锋柊鐨勫唴瀹癸級- 鐢ㄤ簬涓柇鏃朵繚瀛?*/
  getFullResponse: () => string;

  /** 鑾峰彇瀹屾暣 thinking 鍐呭锛堝寘鎷紦鍐插尯涓湭鍒锋柊鐨勫唴瀹癸級- 鐢ㄤ簬鎸佷箙鍖栧巻鍙茶褰?*/
  getThinkingContent: () => string;

  /** Start a new iteration - saves current content to history and clears for next round - 寮€濮嬫柊杩唬锛屼繚瀛樺綋鍓嶅唴瀹瑰埌鍘嗗彶骞舵竻绌?*/
  startNewIteration: (iteration: number) => void;

  /** Clear iteration history - 娓呯┖杩唬鍘嗗彶 */
  clearIterationHistory: () => void;

  /** Set maximum iterations - 璁剧疆鏈€澶ц凯浠ｆ鏁?*/
  setMaxIter: (maxIter: number) => void;

  /** 寮€濮嬪帇缂╀笂涓嬫枃 */
  startCompacting: () => void;

  /** 缁撴潫鍘嬬缉涓婁笅鏂?*/
  stopCompacting: () => void;
  addPendingInput: (input: string) => void;
  removeLastPendingInput: () => void;
  shiftPendingInput: () => string | undefined;
  clearPendingInputs: () => void;
  consumePendingInputs: () => string[];
}

/**
 * State change listener - 鐘舵€佸彉鏇寸洃鍚櫒
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
  maxIter: 200, // Default max iterations - 榛樿鏈€澶ц凯浠ｆ鏁?
  isCompacting: false,
  pendingInputs: [],
};

// === Streaming Manager ===

/**
 * Streaming manager interface - 娴佸紡绠＄悊鍣ㄦ帴鍙?
 */
export interface StreamingManager {
  /** 鑾峰彇褰撳墠鐘舵€?*/
  getState: () => StreamingContextValue;

  /** 璁剧疆娴佸紡鐘舵€?*/
  setState: (state: StreamingState) => void;

  /** 寮€濮嬫祦寮忓搷搴?*/
  startStreaming: () => void;

  /** 鍋滄娴佸紡鍝嶅簲 */
  stopStreaming: () => void;

  /** 杩藉姞鍝嶅簲鏂囨湰 */
  appendResponse: (text: string) => void;

  /** 娓呯┖鍝嶅簲 */
  clearResponse: () => void;

  /** 璁剧疆閿欒 */
  setError: (error: string | undefined) => void;

  /** 鍙栨秷褰撳墠娴佸紡鍝嶅簲 */
  abort: () => void;

  /** 閲嶇疆鐘舵€?*/
  reset: () => void;

  /** 鏄惁姝ｅ湪娴佸紡浼犺緭 */
  isStreaming: () => boolean;

  /** 璁㈤槄鐘舵€佸彉鏇?*/
  subscribe: (listener: StreamingStateListener) => () => void;

  /** 寮€濮?thinking */
  startThinking: () => void;

  /** 杩藉姞 thinking 瀛楃鏁?*/
  appendThinkingChars: (count: number) => void;

  /** 杩藉姞 thinking 鍐呭 */
  appendThinkingContent: (text: string) => void;

  /** 缁撴潫 thinking */
  stopThinking: () => void;

  /** 娓呯┖ thinking 鍐呭 (鍝嶅簲瀹屾垚鏃惰皟鐢? */
  clearThinkingContent: () => void;

  /** 璁剧疆褰撳墠宸ュ叿 */
  setCurrentTool: (tool: string | undefined) => void;

  /** 杩藉姞宸ュ叿杈撳叆瀛楃鏁?*/
  appendToolInputChars: (count: number) => void;

  /** 杩藉姞宸ュ叿杈撳叆鍐呭 */
  appendToolInputContent: (text: string) => void;

  /** 娓呯┖宸ュ叿杈撳叆鍐呭 */
  clearToolInputContent: () => void;

  /** 鑾峰彇褰撳墠鐨?AbortSignal */
  getSignal: () => AbortSignal | undefined;

  /** 鑾峰彇瀹屾暣鍝嶅簲鍐呭锛堝寘鎷紦鍐插尯涓湭鍒锋柊鐨勫唴瀹癸級 */
  getFullResponse: () => string;

  /** 鑾峰彇瀹屾暣 thinking 鍐呭锛堝寘鎷紦鍐插尯涓湭鍒锋柊鐨勫唴瀹癸級 */
  getThinkingContent: () => string;

  /** Start a new iteration - 寮€濮嬫柊杩唬 */
  startNewIteration: (iteration: number) => void;

  /** Clear iteration history - 娓呯┖杩唬鍘嗗彶 */
  clearIterationHistory: () => void;

  /** Set maximum iterations - 璁剧疆鏈€澶ц凯浠ｆ鏁?*/
  setMaxIter: (maxIter: number) => void;

  /** Start compacting context - 寮€濮嬪帇缂╀笂涓嬫枃 */
  startCompacting: () => void;

  /** Stop compacting context - 缁撴潫鍘嬬缉涓婁笅鏂?*/
  stopCompacting: () => void;
  addPendingInput: (input: string) => void;
  removeLastPendingInput: () => void;
  shiftPendingInput: () => string | undefined;
  clearPendingInputs: () => void;
  consumePendingInputs: () => string[];
}

/**
 * Create streaming manager - 鍒涘缓娴佸紡绠＄悊鍣?
 *
 * Issue 048 fix: Use batch updates to reduce render frequency - Issue 048 淇: 浣跨敤鎵归噺鏇存柊鍑忓皯娓叉煋棰戠巼
 * - Buffer streaming text and thinking content to 80ms cycle - 娴佸紡鏂囨湰鍜?thinking 鍐呭缂撳啿鍒?80ms 鍛ㄦ湡
 * - Sync with Spinner animation to avoid race conditions - 涓?Spinner 鍔ㄧ敾鍚屾锛岄伩鍏嶇珵鎬佹潯浠?
 */
export function createStreamingManager(): StreamingManager {
  let state: StreamingContextValue = { ...DEFAULT_STREAMING_STATE };
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
   * Flush interval (ms) - 鍒锋柊闂撮殧
   * - 80ms syncs with Spinner animation frame - 80ms 涓?Spinner 鍔ㄧ敾甯у悓姝?
   * - User perceives as instant response within 100ms - 100ms 鍐呯殑鐢ㄦ埛鎰熺煡涓哄嵆鏃跺搷搴?
   */
  const FLUSH_INTERVAL = 80;

  const notify = () => {
    for (const listener of listeners) {
      listener(state);
    }
  };

  /**
   * Immediately apply buffer content and notify - 绔嬪嵆搴旂敤缂撳啿鍖哄唴瀹瑰苟閫氱煡
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
   * Schedule delayed flush - 瀹夋帓寤惰繜鍒锋柊
   */
  const scheduleFlush = () => {
    if (!flushTimer) {
      flushTimer = setTimeout(flushPendingUpdates, FLUSH_INTERVAL);
    }
  };

  return {
    getState: () => state,

    setState: (newState: StreamingState) => {
      flushPendingUpdates(); // Flush before state change - 鐘舵€佸垏鎹㈠墠鍒锋柊
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
      };
      notify();
    },

    stopStreaming: () => {
      flushPendingUpdates(); // Flush before stopping to ensure all content displays - 鍋滄鍓嶅埛鏂帮紝纭繚鎵€鏈夊唴瀹规樉绀?
      state = {
        ...state,
        state: StreamingState.Idle,
        abortController: undefined,
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
      flushPendingUpdates(); // Flush before setting error - 閿欒鍓嶅埛鏂?
      state = {
        ...state,
        error,
        state: error ? StreamingState.Idle : state.state,
      };
      notify();
    },

    abort: () => {
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
      state = {
        ...state,
        state: StreamingState.Idle,
        abortController: undefined,
        pendingInputs: [],
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
      state = { ...DEFAULT_STREAMING_STATE };
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
      flushPendingUpdates(); // Flush before starting thinking - 寮€濮?thinking 鍓嶅埛鏂?
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
      flushPendingUpdates(); // Flush before stopping - 鍋滄鍓嶅埛鏂?
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
      // Clear thinking content when response completes - 鍝嶅簲瀹屾垚鏃舵竻闄?thinking 鍐呭
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
      // 闄愬埗鍐呭涓?~100 瀛楃鐢ㄤ簬鏄剧ず锛堟棤闇€瀛樺偍瀹屾暣杈撳叆锛?
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
      // 杩斿洖褰撳墠鍝嶅簲 + 缂撳啿鍖轰腑鏈埛鏂扮殑鍐呭
      return state.currentResponse + pendingResponseText;
    },

    getThinkingContent: () => {
      // Return current thinking + any pending buffered content
      // 杩斿洖褰撳墠 thinking + 缂撳啿鍖轰腑鏈埛鏂扮殑鍐呭
      return state.thinkingContent + pendingThinkingText;
    },

    /**
     * Start a new iteration - clears current content for next round
     * 寮€濮嬫柊杩唬 - 娓呯┖褰撳墠鍐呭鍑嗗涓嬩竴杞?
     * Note: Content is already saved to history by onIterationStart callback in InkREPL
     * 娉ㄦ剰锛氬唴瀹瑰凡缁忛€氳繃 InkREPL 鐨?onIterationStart 鍥炶皟淇濆瓨鍒?history
     */
    startNewIteration: (iteration: number) => {
      flushPendingUpdates(); // Flush before clearing - 娓呯┖鍓嶅埛鏂?

      // Just clear current content for next iteration - only clear if there's content
      // 娓呯┖褰撳墠鍐呭鍑嗗涓嬩竴杞?- 鍙湁鍦ㄦ湁鍐呭鏃舵墠娓呯┖
      if (state.thinkingContent || state.currentResponse) {
        state = {
          ...state,
          // Clear current content for next iteration - 娓呯┖褰撳墠鍐呭鍑嗗涓嬩竴杞?
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
        // No content, just update iteration number - 娌℃湁鍐呭锛屽彧鏇存柊杩唬鍙?
        state = {
          ...state,
          currentIteration: iteration,
        };
      }

      notify();
    },

    /**
     * Clear iteration history - 娓呯┖杩唬鍘嗗彶
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
     * Set maximum iterations - 璁剧疆鏈€澶ц凯浠ｆ鏁?
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
     * Start compacting context - 寮€濮嬪帇缂╀笂涓嬫枃
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

    addPendingInput: (input: string) => {
      const trimmed = input.trim();
      if (!trimmed || state.pendingInputs.length >= MAX_PENDING_INPUTS) {
        return;
      }

      flushPendingUpdates();
      state = {
        ...state,
        pendingInputs: [...state.pendingInputs, trimmed],
      };
      notify();
    },

    removeLastPendingInput: () => {
      if (state.pendingInputs.length === 0) {
        return;
      }

      flushPendingUpdates();
      state = {
        ...state,
        pendingInputs: state.pendingInputs.slice(0, -1),
      };
      notify();
    },

    shiftPendingInput: () => {
      if (state.pendingInputs.length === 0) {
        return undefined;
      }

      flushPendingUpdates();
      const [nextInput, ...rest] = state.pendingInputs;
      state = {
        ...state,
        pendingInputs: rest,
      };
      notify();
      return nextInput;
    },

    clearPendingInputs: () => {
      if (state.pendingInputs.length === 0) {
        return;
      }

      flushPendingUpdates();
      state = {
        ...state,
        pendingInputs: [],
      };
      notify();
    },

    consumePendingInputs: () => {
      if (state.pendingInputs.length === 0) {
        return [];
      }

      flushPendingUpdates();
      const pendingInputs = state.pendingInputs;
      state = {
        ...state,
        pendingInputs: [],
      };
      notify();
      return pendingInputs;
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
}

// === Provider ===

/**
 * StreamingProvider - Provides streaming response management - 鎻愪緵娴佸紡鍝嶅簲绠＄悊
 */
export function StreamingProvider({
  children,
  onStateChange,
}: StreamingProviderProps): React.ReactElement {
  const managerRef = useRef<StreamingManager>(createStreamingManager());
  const [, forceUpdate] = useReducer((x) => x + 1, 0);

  // Subscribe to state changes - 璁㈤槄鐘舵€佸彉鏇?
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

  const appendToolInputContent = useCallback((text: string) => {
    managerRef.current.appendToolInputContent(text);
  }, []);

  const clearToolInputContent = useCallback(() => {
    managerRef.current.clearToolInputContent();
  }, []);

  const getSignal = useCallback(() => {
    return managerRef.current.getSignal();
  }, []);

  const getFullResponse = useCallback(() => {
    return managerRef.current.getFullResponse();
  }, []);

  const getThinkingContent = useCallback(() => {
    return managerRef.current.getThinkingContent();
  }, []);

  const startNewIteration = useCallback((iteration: number) => {
    managerRef.current.startNewIteration(iteration);
  }, []);

  const clearIterationHistory = useCallback(() => {
    managerRef.current.clearIterationHistory();
  }, []);

  const setMaxIter = useCallback((maxIter: number) => {
    managerRef.current.setMaxIter(maxIter);
  }, []);

  const startCompacting = useCallback(() => {
    managerRef.current.startCompacting();
  }, []);

  const stopCompacting = useCallback(() => {
    managerRef.current.stopCompacting();
  }, []);

  const addPendingInput = useCallback((input: string) => {
    managerRef.current.addPendingInput(input);
  }, []);

  const removeLastPendingInput = useCallback(() => {
    managerRef.current.removeLastPendingInput();
  }, []);

  const shiftPendingInput = useCallback(() => {
    return managerRef.current.shiftPendingInput();
  }, []);

  const clearPendingInputs = useCallback(() => {
    managerRef.current.clearPendingInputs();
  }, []);

  const consumePendingInputs = useCallback(() => {
    return managerRef.current.consumePendingInputs();
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
    shiftPendingInput,
    clearPendingInputs,
    consumePendingInputs,
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
 * Get streaming state - 鑾峰彇娴佸紡鐘舵€?
 */
export function useStreamingState(): StreamingContextValue {
  const context = useContext(StreamingContextValueContext);
  if (!context) {
    throw new Error("useStreamingState must be used within a StreamingProvider");
  }
  return context;
}

/**
 * Get streaming actions - 鑾峰彇娴佸紡鎿嶄綔
 */
export function useStreamingActions(): StreamingActions {
  const context = useContext(StreamingActionsContext);
  if (!context) {
    throw new Error("useStreamingActions must be used within a StreamingProvider");
  }
  return context;
}

/**
 * Get complete streaming state and actions - 鑾峰彇瀹屾暣娴佸紡鐘舵€佸拰鎿嶄綔
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
