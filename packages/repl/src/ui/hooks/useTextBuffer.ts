/**
 * useTextBuffer - TextBuffer React Hook
 *
 * 将 TextBuffer 类与 React 状态管理集成
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { TextBuffer, type CursorPosition } from "../utils/text-buffer.js";
import type { KeyInfo, UseTextBufferReturn } from "../types.js";

export interface UseTextBufferOptions {
  initialValue?: string;
  onSubmit?: (text: string) => void;
  onTextChange?: (text: string) => void;
}

/**
 * 粘贴检测配置
 */
const PASTE_DETECTION = {
  MIN_CHARS: 16, // 最少连续字符数
  MAX_INTERVAL_MS: 8, // 最大间隔毫秒
};

export function useTextBuffer(options: UseTextBufferOptions = {}): UseTextBufferReturn {
  const { initialValue = "", onSubmit, onTextChange } = options;

  // 使用 ref 存储 TextBuffer 实例，避免重新创建
  const bufferRef = useRef<TextBuffer | null>(null);
  // 粘贴检测状态
  const lastInputTimeRef = useRef<number>(0);
  const consecutiveCharsRef = useRef<number>(0);

  // React 状态，用于触发重新渲染
  const [text, setText] = useState(initialValue);
  const [cursor, setCursor] = useState<CursorPosition>({ row: 0, col: 0 });
  const [lines, setLines] = useState<string[]>([""]);

  // 初始化 TextBuffer
  if (bufferRef.current === null) {
    bufferRef.current = new TextBuffer();
    if (initialValue) {
      bufferRef.current.setText(initialValue);
    }
  }

  const buffer = bufferRef.current;

  // 同步状态
  const syncState = useCallback(() => {
    setText(buffer.text);
    setCursor(buffer.cursor);
    setLines(buffer.lines);
    onTextChange?.(buffer.text);
  }, [buffer, onTextChange]);

  // setText
  const handleSetText = useCallback(
    (newText: string) => {
      buffer.setText(newText);
      syncState();
    },
    [buffer, syncState]
  );

  // insert
  const handleInsert = useCallback(
    (insertText: string, insertOptions?: { paste?: boolean }) => {
      // 粘贴检测
      const now = Date.now();
      const isPaste =
        insertOptions?.paste ??
        (now - lastInputTimeRef.current < PASTE_DETECTION.MAX_INTERVAL_MS &&
          consecutiveCharsRef.current >= PASTE_DETECTION.MIN_CHARS);

      if (insertText.length === 1) {
        consecutiveCharsRef.current++;
      } else {
        consecutiveCharsRef.current = insertText.length;
      }
      lastInputTimeRef.current = now;

      buffer.insert(insertText, { paste: isPaste });
      syncState();
    },
    [buffer, syncState]
  );

  // newline
  const handleNewline = useCallback(() => {
    buffer.newline();
    syncState();
  }, [buffer, syncState]);

  // backspace
  const handleBackspace = useCallback(() => {
    buffer.backspace();
    syncState();
  }, [buffer, syncState]);

  // delete
  const handleDelete = useCallback(() => {
    buffer.delete();
    syncState();
  }, [buffer, syncState]);

  // move
  const handleMove = useCallback(
    (direction: "up" | "down" | "left" | "right" | "home" | "end") => {
      buffer.move(direction);
      syncState();
    },
    [buffer, syncState]
  );

  // clear
  const handleClear = useCallback(() => {
    buffer.clear();
    syncState();
  }, [buffer, syncState]);

  // undo
  const handleUndo = useCallback(() => {
    const result = buffer.undo();
    if (result) {
      syncState();
    }
    return result;
  }, [buffer, syncState]);

  // redo
  const handleRedo = useCallback(() => {
    const result = buffer.redo();
    if (result) {
      syncState();
    }
    return result;
  }, [buffer, syncState]);

  // handleInput - 处理键盘输入
  const handleInput = useCallback(
    (key: KeyInfo): boolean => {
      const { name, sequence, ctrl, meta, shift: isShift } = key;

      // Ctrl 组合键
      if (ctrl) {
        switch (name) {
          case "a":
            handleMove("home");
            return true;
          case "e":
            handleMove("end");
            return true;
          case "k":
            buffer.killLineRight();
            syncState();
            return true;
          case "u":
            buffer.killLineLeft();
            syncState();
            return true;
          case "w":
            buffer.deleteWordLeft();
            syncState();
            return true;
          case "z":
            handleUndo();
            return true;
          case "y":
            handleRedo();
            return true;
        }
      }

      // 方向键
      switch (name) {
        case "up":
          handleMove("up");
          return true;
        case "down":
          handleMove("down");
          return true;
        case "left":
          handleMove("left");
          return true;
        case "right":
          handleMove("right");
          return true;
        case "home":
          handleMove("home");
          return true;
        case "end":
          handleMove("end");
          return true;
      }

      // 退格和删除
      if (name === "backspace") {
        handleBackspace();
        return true;
      }
      if (name === "delete") {
        handleDelete();
        return true;
      }

      // 回车
      if (name === "return") {
        // Shift+Enter 始终换行
        if (isShift) {
          handleNewline();
          return true;
        }

        // 检查是否需要换行 (行尾是 \)
        if (buffer.isLineContinuation()) {
          // 删除反斜杠并换行
          buffer.backspace();
          handleNewline();
          return true;
        }

        // 提交
        if (onSubmit && buffer.text.trim()) {
          onSubmit(buffer.text);
          handleClear();
        }
        return true;
      }

      // 普通字符输入
      if (sequence && sequence.length === 1 && !ctrl && !meta) {
        handleInsert(sequence);
        return true;
      }

      return false;
    },
    [buffer, handleMove, handleBackspace, handleDelete, handleNewline, handleInsert, handleClear, handleUndo, handleRedo, syncState, onSubmit]
  );

  // 清理
  useEffect(() => {
    return () => {
      bufferRef.current = null;
    };
  }, []);

  return {
    buffer,
    text,
    cursor,
    lines,
    setText: handleSetText,
    insert: handleInsert,
    newline: handleNewline,
    backspace: handleBackspace,
    delete: handleDelete,
    move: handleMove,
    clear: handleClear,
    undo: handleUndo,
    redo: handleRedo,
  };
}
