/**
 * useTextBuffer - TextBuffer React Hook
 *
 * Integrates TextBuffer class with React state management - 将 TextBuffer 类与 React 状态管理集成
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { TextBuffer, type CursorPosition } from "../utils/text-buffer.js";
import {
  PasteStore,
  findPlaceholderAfterCursor,
  findPlaceholderBeforeCursor,
  getOrCreateModulePasteStore,
  shouldReplacePasteWithPlaceholder,
} from "../utils/paste-store.js";
import type { PromptEditingMode, UseTextBufferReturn } from "../types.js";

export interface UseTextBufferOptions {
  initialValue?: string;
  onTextChange?: (text: string) => void;
}

/**
 * Unified state interface - ensures atomic updates to text, cursor, and lines - 统一状态接口 - 保证 text, cursor, lines 原子更新
 */
interface TextBufferState {
  text: string;
  cursor: CursorPosition;
  lines: string[];
  isPasting: boolean;
  editingMode: PromptEditingMode;
}

export function useTextBuffer(options: UseTextBufferOptions = {}): UseTextBufferReturn {
  const { initialValue = "", onTextChange } = options;

  // Use ref to store TextBuffer instance, avoiding recreation - 使用 ref 存储 TextBuffer 实例，避免重新创建
  const bufferRef = useRef<TextBuffer | null>(null);
  // Issue 121: the PasteStore is MODULE-SCOPED (see paste-store.ts
  // getOrCreateModulePasteStore) so it survives composer unmount+remount
  // (e.g. Ctrl+O transcript toggle). Holding it by ref here is just for
  // render-time access convenience — mount/unmount does not create a new
  // store. Reset is explicit, via startNewSession / test helper.
  const pasteStoreRef = useRef<PasteStore | null>(null);
  // Paste reset timeout ref - 粘贴重置超时引用
  const pasteResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // React state - use single state object for atomic updates (Issue 036) - React 状态 - 使用单一状态对象保证原子更新（Issue 036）
  const [state, setState] = useState<TextBufferState>({
    text: initialValue,
    cursor: { row: 0, col: 0 },
    lines: [""],
    isPasting: false,
    editingMode: initialValue ? "typing" : "idle",
  });

  // Initialize TextBuffer - 初始化 TextBuffer
  if (bufferRef.current === null) {
    bufferRef.current = new TextBuffer();
    if (initialValue) {
      bufferRef.current.setText(initialValue);
    }
  }
  if (pasteStoreRef.current === null) {
    pasteStoreRef.current = getOrCreateModulePasteStore();
  }

  const buffer = bufferRef.current;
  const pasteStore = pasteStoreRef.current;

  // Sync state - atomic updates, avoiding intermediate states (Issue 036 fix) - 同步状态 - 原子更新，避免中间状态（Issue 036 修复）
  const syncState = useCallback((overrides?: Partial<Pick<TextBufferState, "isPasting" | "editingMode">>) => {
    setState((prev) => ({
      text: buffer.text,
      cursor: buffer.cursor,
      lines: buffer.lines,
      isPasting: overrides?.isPasting ?? prev.isPasting,
      editingMode: overrides?.editingMode ?? prev.editingMode,
    }));
    onTextChange?.(buffer.text);
  }, [buffer, onTextChange]);

  const schedulePasteReset = useCallback(() => {
    if (pasteResetTimeoutRef.current) {
      clearTimeout(pasteResetTimeoutRef.current);
    }

    pasteResetTimeoutRef.current = setTimeout(() => {
      setState((prev) => ({
        ...prev,
        isPasting: false,
        editingMode: prev.text ? "typing" : "idle",
      }));
      pasteResetTimeoutRef.current = null;
    }, 120);
  }, []);

  // setText
  const handleSetText = useCallback(
    (newText: string) => {
      buffer.setText(newText);
      syncState({
        isPasting: false,
        editingMode: newText ? "typing" : "idle",
      });
    },
    [buffer, syncState]
  );

  // replaceRange
  const handleReplaceRange = useCallback(
    (start: number, end: number, replacement: string) => {
      buffer.replaceRange(start, end, replacement);
      syncState({
        isPasting: false,
        editingMode: buffer.text ? "typing" : "idle",
      });
    },
    [buffer, syncState]
  );

  // insert - paste detection relies on bracketed paste mode (terminal protocol), not timing - 插入 - 粘贴检测依赖终端 bracketed paste 协议，非时间频率
  const handleInsert = useCallback(
    (insertText: string, insertOptions?: { paste?: boolean }) => {
      const isPaste = insertOptions?.paste ?? false;

      // Issue 121 Layer 1: above threshold, register paste content and insert
      // only the placeholder. Normalize CRLF before threshold check (matches
      // Issue 075 CRLF handling).
      //
      // The keypress-parser now aggregates bracketed-paste content and emits
      // ONE synthetic event with the full paste body, so `insertText` here is
      // the whole paste (not individual chars). Small pastes fall through to
      // the raw-insert branch below with paste:false so newlines split into
      // buffer lines correctly.
      if (isPaste && shouldReplacePasteWithPlaceholder(insertText)) {
        const normalized = insertText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const { placeholder } = pasteStore.registerText(normalized);
        // Placeholder never contains newlines, so paste: true (raw insert) is safe.
        buffer.insert(placeholder, { paste: true });
        syncState({ isPasting: true, editingMode: "pasting" });
        schedulePasteReset();
        return;
      }

      // Below threshold: always use paste:false so buffer.insert splits on
      // newlines. An aggregated below-threshold paste may contain `\n`
      // (e.g. 3 logical lines of short text); passing paste:true would insert
      // them as a single flat line, merging the lines visually.
      buffer.insert(insertText, { paste: false });
      syncState({
        isPasting: isPaste,
        editingMode: isPaste ? "pasting" : "typing",
      });
      if (isPaste) {
        schedulePasteReset();
      }
    },
    [buffer, pasteStore, schedulePasteReset, syncState]
  );
  // newline
  const handleNewline = useCallback(() => {
    buffer.newline();
    syncState({
      isPasting: false,
      editingMode: "typing",
    });
  }, [buffer, syncState]);

  // backspace
  // Issue 121: atomic delete when cursor sits immediately after a placeholder
  // at a word boundary. We do NOT remove the paste-store entry so undo/redo
  // can restore the placeholder text alongside the map (undo snapshot is
  // handled by buffer._saveHistory within replaceRange).
  const handleBackspace = useCallback(() => {
    const cursorOffset = buffer.getAbsoluteOffset();
    const adj = findPlaceholderBeforeCursor(buffer.text, cursorOffset);
    if (adj) {
      buffer.replaceRange(adj.start, adj.end, "");
    } else {
      buffer.backspace();
    }
    syncState({
      isPasting: false,
      editingMode: buffer.text ? "typing" : "idle",
    });
  }, [buffer, syncState]);

  // delete
  const handleDelete = useCallback(() => {
    const cursorOffset = buffer.getAbsoluteOffset();
    const adj = findPlaceholderAfterCursor(buffer.text, cursorOffset);
    if (adj) {
      buffer.replaceRange(adj.start, adj.end, "");
    } else {
      buffer.delete();
    }
    syncState({
      isPasting: false,
      editingMode: buffer.text ? "typing" : "idle",
    });
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
    syncState({
      isPasting: false,
      editingMode: "idle",
    });
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

  // moveToEnd - move cursor to end of entire text
  const handleMoveToEnd = useCallback(() => {
    buffer.moveToEnd();
    syncState();
  }, [buffer, syncState]);

  // Issue 121: jump cursor to absolute offset. Used by arrow-key atomic
  // jump over `[Pasted text #N ...]` placeholders. Doesn't touch undo
  // history — pure cursor move.
  const handleMoveToOffset = useCallback((offset: number) => {
    buffer.moveToAbsoluteOffset(offset);
    syncState();
  }, [buffer, syncState]);

  const handleKillLineRight = useCallback(() => {
    buffer.killLineRight();
    syncState({
      isPasting: false,
      editingMode: buffer.text ? "typing" : "idle",
    });
  }, [buffer, syncState]);

  const handleKillLineLeft = useCallback(() => {
    buffer.killLineLeft();
    syncState({
      isPasting: false,
      editingMode: buffer.text ? "typing" : "idle",
    });
  }, [buffer, syncState]);

  const handleDeleteWordLeft = useCallback(() => {
    buffer.deleteWordLeft();
    syncState({
      isPasting: false,
      editingMode: buffer.text ? "typing" : "idle",
    });
  }, [buffer, syncState]);

  const handleResetTransientState = useCallback(() => {
    if (pasteResetTimeoutRef.current) {
      clearTimeout(pasteResetTimeoutRef.current);
      pasteResetTimeoutRef.current = null;
    }
    syncState({
      isPasting: false,
      editingMode: buffer.text ? "typing" : "idle",
    });
  }, [buffer, syncState]);

  // Cleanup - 清理
  useEffect(() => {
    return () => {
      if (pasteResetTimeoutRef.current) {
        clearTimeout(pasteResetTimeoutRef.current);
      }
      bufferRef.current = null;
    };
  }, []);

  return {
    buffer,
    text: state.text,
    cursor: state.cursor,
    lines: state.lines,
    isPasting: state.isPasting,
    editingMode: state.editingMode,
    pasteStore,
    resetTransientState: handleResetTransientState,
    setText: handleSetText,
    replaceRange: handleReplaceRange,
    insert: handleInsert,
    newline: handleNewline,
    backspace: handleBackspace,
    delete: handleDelete,
    move: handleMove,
    moveToEnd: handleMoveToEnd,
    moveToOffset: handleMoveToOffset,
    killLineRight: handleKillLineRight,
    killLineLeft: handleKillLineLeft,
    deleteWordLeft: handleDeleteWordLeft,
    clear: handleClear,
    undo: handleUndo,
    redo: handleRedo,
  };
}
