/**
 * useInputHistory - 输入历史管理 Hook
 *
 * 管理命令历史，支持上下键导航
 */

import { useState, useCallback, useRef } from "react";
import type { HistoryEntry } from "../types.js";

export interface UseInputHistoryOptions {
  maxSize?: number;
  onSave?: (entry: HistoryEntry) => void;
}

export interface UseInputHistoryReturn {
  history: HistoryEntry[];
  currentIndex: number;
  add: (text: string) => void;
  navigateUp: () => string | null;
  navigateDown: () => string | null;
  reset: () => void;
  getPrevious: () => string | null;
  getNext: () => string | null;
  saveTempInput: (text: string) => void;
}

export function useInputHistory(options: UseInputHistoryOptions = {}): UseInputHistoryReturn {
  const { maxSize = 1000, onSave } = options;

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const historyIndexRef = useRef<number>(-1);
  const tempInputRef = useRef<string>("");

  // 添加新条目
  const add = useCallback(
    (text: string) => {
      if (!text.trim()) return;

      const entry: HistoryEntry = {
        text,
        timestamp: Date.now(),
      };

      setHistory((prev) => {
        // 避免重复连续条目
        const lastEntry = prev[prev.length - 1];
        if (lastEntry?.text === text) {
          return prev;
        }

        // 限制大小
        const newHistory = [...prev, entry];
        if (newHistory.length > maxSize) {
          return newHistory.slice(-maxSize);
        }
        return newHistory;
      });

      // 重置导航索引
      historyIndexRef.current = -1;
      tempInputRef.current = "";

      onSave?.(entry);
    },
    [maxSize, onSave]
  );

  // 向上导航 (更早的历史)
  const navigateUp = useCallback((): string | null => {
    if (history.length === 0) return null;

    // 第一次导航，保存当前输入
    if (historyIndexRef.current === -1) {
      historyIndexRef.current = history.length - 1;
      return history[historyIndexRef.current]?.text ?? null;
    }

    // 还有更早的历史
    if (historyIndexRef.current > 0) {
      historyIndexRef.current--;
      return history[historyIndexRef.current]?.text ?? null;
    }

    return null;
  }, [history]);

  // 向下导航 (更近的历史)
  const navigateDown = useCallback((): string | null => {
    if (historyIndexRef.current === -1) return null;

    // 还有更近的历史
    if (historyIndexRef.current < history.length - 1) {
      historyIndexRef.current++;
      return history[historyIndexRef.current]?.text ?? null;
    }

    // 回到当前输入 - 总是返回 tempInputRef 或空字符串
    // 参考 Gemini CLI 和 OpenCode: 永远不返回 null，而是返回空字符串
    historyIndexRef.current = -1;
    return tempInputRef.current; // 可能是空字符串，但不是 null
  }, [history]);

  // 重置导航
  const reset = useCallback(() => {
    historyIndexRef.current = -1;
    tempInputRef.current = "";
  }, []);

  // 保存临时输入 (导航前)
  const saveTempInput = useCallback((text: string) => {
    if (historyIndexRef.current === -1) {
      tempInputRef.current = text;
    }
  }, []);

  // 获取上一个
  const getPrevious = useCallback(() => {
    if (historyIndexRef.current === -1) return null;
    const prevIndex = historyIndexRef.current - 1;
    if (prevIndex < 0) return null;
    return history[prevIndex]?.text ?? null;
  }, [history]);

  // 获取下一个
  const getNext = useCallback(() => {
    if (historyIndexRef.current === -1) return null;
    const nextIndex = historyIndexRef.current + 1;
    if (nextIndex >= history.length) return null;
    return history[nextIndex]?.text ?? null;
  }, [history]);

  return {
    history,
    currentIndex: historyIndexRef.current,
    add,
    navigateUp,
    navigateDown,
    reset,
    getPrevious,
    getNext,
    saveTempInput,
  };
}
