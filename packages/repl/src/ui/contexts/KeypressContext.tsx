/**
 * KeypressContext - Priority-based Keyboard Event Handling
 *
 * Reference implementation based on Gemini CLI's KeypressContext architecture - 鍙傝€?Gemini CLI 鐨?KeypressContext 鏋舵瀯瀹炵幇
 * Uses priority system to allow different components to handle the same key - 浣跨敤浼樺厛绾х郴缁熷厑璁镐笉鍚岀粍浠跺鐞嗙浉鍚岀殑鎸夐敭
 *
 * Key improvements - 鍏抽敭鏀硅繘锛?
 * - Use custom KeypressParser instead of Ink's useInput - 浣跨敤鑷畾涔?KeypressParser 鏇夸唬 Ink 鐨?useInput
 * - Correctly handle Backspace/Delete key confusion - 姝ｇ‘澶勭悊 Backspace/Delete 閿贩娣嗛棶棰?
 * - Add insertable property support - 娣诲姞 insertable 灞炴€ф敮鎸?
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { useStdin } from "../tui.js";
import { KeypressParser } from "../utils/keypress-parser.js";
import {
  KeypressHandlerPriority,
  type KeyInfo,
  type KeypressHandler,
} from "../types.js";

// === Constants ===

/** ESC sequence timeout in milliseconds - ESC 搴忓垪瓒呮椂鏃堕棿锛堟绉掞級 */
const ESC_TIMEOUT = 50;

// === Types ===

/**
 * Keyboard event manager interface - 閿洏浜嬩欢绠＄悊鍣ㄦ帴鍙?
 */
export interface KeypressManager {
  /**
   * 娉ㄥ唽閿洏浜嬩欢澶勭悊鍣?
   * @param priority 澶勭悊鍣ㄤ紭鍏堢骇
   * @param handler 澶勭悊鍑芥暟锛岃繑鍥?true 琛ㄧず娑堣垂浜嬩欢
   * @returns 娉ㄩ攢鍑芥暟
   */
  register: (priority: number, handler: KeypressHandler) => () => void;

  /**
   * 鍒嗗彂閿洏浜嬩欢鍒板鐞嗗櫒
   * @param event 閿洏浜嬩欢
   * @returns 鏄惁琚秷璐?
   */
  dispatch: (event: KeyInfo) => boolean;

  /**
   * 鑾峰彇褰撳墠娉ㄥ唽鐨勫鐞嗗櫒鏁伴噺
   */
  size: () => number;
}

// === Keypress Manager Implementation ===

/**
 * Create keyboard event manager - 鍒涘缓閿洏浜嬩欢绠＄悊鍣?
 *
 * Uses MultiMap-style priority management - 浣跨敤 MultiMap 椋庢牸鐨勪紭鍏堢骇绠＄悊锛?
 * - Higher priority handlers execute first - 楂樹紭鍏堢骇鐨勫鐞嗗櫒鍏堟墽琛?
 * - Within same priority, later registered handlers execute first (LIFO) - 鍚屼紭鍏堢骇鍐呭悗娉ㄥ唽鐨勫厛鎵ц (LIFO)
 * - Handlers returning true prevent subsequent handlers from executing - 杩斿洖 true 鐨勫鐞嗗櫒浼氶樆姝㈠悗缁鐞嗗櫒鎵ц
 */
export function createKeypressManager(): KeypressManager {
  // Use Map to store priority -> handler array mapping - 浣跨敤 Map 瀛樺偍浼樺厛绾?-> 澶勭悊鍣ㄦ暟缁勭殑鏄犲皠
  const handlers = new Map<number, KeypressHandler[]>();
  // Cache sorted priorities - 缂撳瓨鎺掑簭鍚庣殑浼樺厛绾?
  let sortedPrioritiesCache: number[] | null = null;

  const getSortedPriorities = (): number[] => {
    if (sortedPrioritiesCache === null) {
      sortedPrioritiesCache = [...handlers.keys()].sort((a, b) => b - a);
    }
    return sortedPrioritiesCache;
  };

  return {
    register(priority: number, handler: KeypressHandler): () => void {
      if (!handlers.has(priority)) {
        handlers.set(priority, []);
      }
      const priorityHandlers = handlers.get(priority)!;
      priorityHandlers.push(handler);

      // Invalidate cache - 浣跨紦瀛樺け鏁?
      sortedPrioritiesCache = null;

      return () => {
        const arr = handlers.get(priority);
        if (arr) {
          const index = arr.indexOf(handler);
          if (index !== -1) {
            arr.splice(index, 1);
          }
          if (arr.length === 0) {
            handlers.delete(priority);
          }
        }
        // Invalidate cache - 浣跨紦瀛樺け鏁?
        sortedPrioritiesCache = null;
      };
    },

    dispatch(event: KeyInfo): boolean {
      // Traverse from high to low priority - 鎸変紭鍏堢骇浠庨珮鍒颁綆閬嶅巻
      const sortedPriorities = getSortedPriorities();

      for (const priority of sortedPriorities) {
        const priorityHandlers = handlers.get(priority);
        if (!priorityHandlers) continue;

        // Traverse from back to front within same priority (LIFO) - 鍚屼紭鍏堢骇鍐呬粠鍚庡線鍓嶉亶鍘?(LIFO)
        for (let i = priorityHandlers.length - 1; i >= 0; i--) {
          const handler = priorityHandlers[i];
          if (!handler) continue;

          const result = handler(event);
          if (result === true) {
            return true; // Event consumed - 浜嬩欢琚秷璐?
          }
        }
      }

      return false; // Event not consumed - 浜嬩欢鏈娑堣垂
    },

    size(): number {
      let count = 0;
      for (const arr of handlers.values()) {
        count += arr.length;
      }
      return count;
    },
  };
}

// === Context ===

const KeypressManagerContext = createContext<KeypressManager | null>(null);

// === Provider Props ===

export interface KeypressProviderProps {
  children: ReactNode;
  enabled?: boolean;
}

// === Provider ===

/**
 * KeypressProvider - Provides global keyboard event management - 鎻愪緵鍏ㄥ眬閿洏浜嬩欢绠＄悊
 *
 * Must be used within Ink component tree - 蹇呴』鍦?Ink 缁勪欢鏍戝唴浣跨敤
 * Uses custom KeypressParser instead of Ink's useInput to fix Backspace/Delete confusion - 浣跨敤鑷畾涔?KeypressParser 鏇夸唬 Ink 鐨?useInput锛岃В鍐?Backspace/Delete 娣锋穯闂
 */
export function KeypressProvider({
  children,
  enabled = true,
}: KeypressProviderProps): React.ReactElement {
  const { stdin, setRawMode } = useStdin();
  const managerRef = useRef<KeypressManager>(createKeypressManager());

  // Callback to dispatch events - 鍒嗗彂浜嬩欢鐨勫洖璋?
  const dispatch = useCallback(
    (event: KeyInfo) => {
      if (!enabled) return;
      managerRef.current.dispatch(event);
    },
    [enabled]
  );

  // Setup stdin listener - 璁剧疆 stdin 鐩戝惉
  useEffect(() => {
    if (!stdin || !enabled) {
      return;
    }

    // Record raw mode state - 璁板綍鍘熷妯″紡鐘舵€?
    const wasRaw = stdin.isRaw;

    // Enable raw mode - 鍚敤鍘熷妯″紡
    if (wasRaw === false) {
      setRawMode(true);
    }

    // Enable bracketed paste mode (Issue 075) - 鍚敤绮樿创妯″紡 (Issue 075)
    // This tells the terminal to wrap pasted content in special escape sequences - 杩欏憡璇夌粓绔皢绮樿创鍐呭鍖呰鍦ㄧ壒娈婄殑杞箟搴忓垪涓?
    // \x1b[200~ marks the start, \x1b[201~ marks the end - \x1b[200~ 鏍囪寮€濮嬶紝\x1b[201~ 鏍囪缁撴潫
    // Must write to stdout (not stdin) to send escape sequences to terminal - 蹇呴』鍐欏叆 stdout锛堣€岄潪 stdin锛夋潵鍙戦€佽浆涔夊簭鍒楀埌缁堢
    process.stdout.write("\x1b[?2004h");

    // Create parser - 鍒涘缓瑙ｆ瀽鍣?
    const parser = new KeypressParser();

    // Register handler - 娉ㄥ唽澶勭悊鍣?
    const unsubscribeParser = parser.onKeypress(dispatch);

    // ESC sequence timeout timer - ESC 搴忓垪瓒呮椂瀹氭椂鍣?
    let timeoutId: NodeJS.Timeout | null = null;

    // Listen to stdin data - 鐩戝惉 stdin 鏁版嵁
    const onData = (data: Buffer | string) => {
      // Clear previous timeout - 娓呴櫎涔嬪墠鐨勮秴鏃?
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      // Feed to parser - 鍠傜粰瑙ｆ瀽鍣?
      parser.feed(data);

      // Set ESC sequence timeout - 璁剧疆 ESC 搴忓垪瓒呮椂
      if (data.length !== 0) {
        timeoutId = setTimeout(() => {
          // Send empty data to trigger timeout handling (flush=true indicates flushing incomplete sequence) - 鍙戦€佺┖鏁版嵁瑙﹀彂瓒呮椂澶勭悊锛坒lush=true 琛ㄧず鍒锋柊涓嶅畬鏁寸殑搴忓垪锛?
          parser.feed("", true);
        }, ESC_TIMEOUT);
      }
    };

    stdin.on("data", onData);

    // Cleanup - 娓呯悊
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      stdin.off("data", onData);
      unsubscribeParser();

      // Disable bracketed paste mode (Issue 075) - 绂佺敤绮樿创妯″紡 (Issue 075)
      try {
        process.stdout.write("\x1b[?2004l");
      } catch {
        // Ignore error - 蹇界暐閿欒
      }

      // Restore raw mode - 鎭㈠鍘熷妯″紡
      if (wasRaw === false) {
        try {
          setRawMode(false);
        } catch {
          // Ignore error - 蹇界暐閿欒
        }
      }
    };
  }, [stdin, setRawMode, enabled, dispatch]);

  return React.createElement(
    KeypressManagerContext.Provider,
    { value: managerRef.current },
    children
  );
}

// === Hooks ===

/**
 * Get keyboard manager - 鑾峰彇閿洏绠＄悊鍣?
 */
export function useKeypressManager(): KeypressManager {
  const context = useContext(KeypressManagerContext);
  if (!context) {
    throw new Error("useKeypressManager must be used within a KeypressProvider");
  }
  return context;
}

/**
 * useKeypress options interface - useKeypress 閫夐」鎺ュ彛
 * Reference implementation based on Gemini CLI's useKeypress signature - 鍙傝€?Gemini CLI 鐨?useKeypress 绛惧悕
 */
export interface UseKeypressOptions {
  /** 鏄惁婵€娲伙紙璁㈤槄閿洏浜嬩欢锛?*/
  isActive?: boolean;
  /** 浼樺厛绾э紙鍙€夛紝榛樿 Normal锛?*/
  priority?: number | boolean;
}

/**
 * Register keyboard event handler - 娉ㄥ唽閿洏浜嬩欢澶勭悊鍣?
 *
 * Supports two calling modes - 鏀寔涓ょ璋冪敤妯″紡锛?
 *
 * 1. KodaX original mode (backward compatible) - KodaX 鍘熸湁妯″紡锛堝悜鍚庡吋瀹癸級锛?
 *    useKeypress(priority, handler, deps)
 *
 * 2. Gemini CLI style (recommended for conditional subscription) - Gemini CLI 椋庢牸锛堟帹鑽愮敤浜庢潯浠惰闃咃級锛?
 *    useKeypress(handler, { isActive: boolean, priority?: number })
 *
 * @param priorityOrHandler Priority or handler function - 浼樺厛绾ф垨澶勭悊鍑芥暟
 * @param handlerOrOptions Handler function or options object - 澶勭悊鍑芥暟鎴栭€夐」瀵硅薄
 * @param deps Dependency array (only used in KodaX mode) - 渚濊禆鏁扮粍锛堜粎鐢ㄤ簬 KodaX 妯″紡锛?
 */
export function useKeypress(
  priorityOrHandler: number | boolean | KeypressHandler,
  handlerOrOptions?: KeypressHandler | UseKeypressOptions,
  deps: React.DependencyList = []
): void {
  const manager = useKeypressManager();

  // Detect calling mode - 妫€娴嬭皟鐢ㄦā寮?
  const isGeminiStyle = typeof priorityOrHandler === "function";

  let handler: KeypressHandler;
  let actualPriority: number;
  let isActive: boolean;

  if (isGeminiStyle) {
    // Gemini CLI style: useKeypress(handler, { isActive, priority? }) - Gemini CLI 椋庢牸锛歶seKeypress(handler, { isActive, priority? })
    handler = priorityOrHandler as KeypressHandler;
    const options = (handlerOrOptions as UseKeypressOptions) ?? {};
    isActive = options.isActive ?? true;
    const priority = options.priority;
    actualPriority =
      typeof priority === "boolean"
        ? priority
          ? KeypressHandlerPriority.High
          : KeypressHandlerPriority.Normal
        : (priority ?? KeypressHandlerPriority.Normal);
  } else {
    // KodaX original mode: useKeypress(priority, handler, deps) - KodaX 鍘熸湁妯″紡锛歶seKeypress(priority, handler, deps)
    actualPriority =
      typeof priorityOrHandler === "boolean"
        ? priorityOrHandler
          ? KeypressHandlerPriority.High
          : KeypressHandlerPriority.Normal
        : priorityOrHandler;
    handler = handlerOrOptions as KeypressHandler;
    isActive = true; // Original mode always active - 鍘熸湁妯″紡鎬绘槸婵€娲?
  }

  useEffect(() => {
    // If not active, don't subscribe - 濡傛灉涓嶆縺娲伙紝涓嶈闃?
    if (!isActive) {
      return;
    }

    const unregister = manager.register(actualPriority, handler);
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager, actualPriority, isActive, ...(isGeminiStyle ? [] : deps)]);
}

/**
 * Create key matcher - 鍒涘缓鎸夐敭鍖归厤鍣?
 *
 * Used to check if a key matches a specific pattern - 鐢ㄤ簬妫€鏌ユ寜閿槸鍚﹀尮閰嶇壒瀹氭ā寮?
 */
export function createKeyMatcher(pattern: Partial<KeyInfo>): (event: KeyInfo) => boolean {
  return (event: KeyInfo): boolean => {
    if (pattern.name !== undefined && event.name !== pattern.name) return false;
    if (pattern.ctrl !== undefined && event.ctrl !== pattern.ctrl) return false;
    if (pattern.meta !== undefined && event.meta !== pattern.meta) return false;
    if (pattern.shift !== undefined && event.shift !== pattern.shift) return false;
    if (pattern.sequence !== undefined && event.sequence !== pattern.sequence) return false;
    if (pattern.insertable !== undefined && event.insertable !== pattern.insertable) return false;
    return true;
  };
}

// === Common Key Matchers ===

export const KeyMatchers = {
  isEnter: createKeyMatcher({ name: "return" }),
  isEscape: createKeyMatcher({ name: "escape" }),
  isCtrlC: createKeyMatcher({ name: "c", ctrl: true }),
  isCtrlD: createKeyMatcher({ name: "d", ctrl: true }),
  isUp: createKeyMatcher({ name: "up" }),
  isDown: createKeyMatcher({ name: "down" }),
  isLeft: createKeyMatcher({ name: "left" }),
  isRight: createKeyMatcher({ name: "right" }),
  isBackspace: createKeyMatcher({ name: "backspace" }),
  isDelete: createKeyMatcher({ name: "delete" }),
  isTab: createKeyMatcher({ name: "tab" }),
  isShiftEnter: (event: KeyInfo) =>
    event.name === "return" && event.shift === true,
  isCtrlEnter: (event: KeyInfo) =>
    event.name === "return" && event.ctrl === true,
  isInsertable: (event: KeyInfo) =>
    event.insertable === true && !event.ctrl && !event.meta,
} as const;

// === Exports ===

export { KeypressManagerContext };

