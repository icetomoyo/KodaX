/**
 * InputPrompt - Input prompt component - 输入提示组件
 *
 * Integrate multi-line input, history navigation, keyboard shortcuts
 * Use centralized KeypressContext for keyboard event handling - 集成多行输入、历史导航、键盘快捷键，使用 centralized KeypressContext 进行键盘事件处理
 *
 * Reference: Gemini CLI InputPrompt architecture - 参考: Gemini CLI InputPrompt 架构
 *
 * Autocomplete Integration - 自动补全集成:
 * - Auto-trigger on typing (debounced) - 输入时自动触发（防抖）
 * - Tab/Enter to accept completion - Tab/Enter 接受补全
 * - Up/Down to navigate suggestions - 上下键导航建议
 * - Escape to cancel - Escape 取消
 */

import React, { useEffect, useState, useCallback, useRef } from "react";
import { Box, Text, useApp } from "ink";
import { TextInput } from "./TextInput.js";
import { useTextBuffer } from "../hooks/useTextBuffer.js";
import { useInputHistory } from "../hooks/useInputHistory.js";
import { useAutocomplete, useAutocompleteContext, type SelectedCompletion } from "../hooks/useAutocomplete.js";
import { useKeypress } from "../contexts/KeypressContext.js";
import { getTheme } from "../themes/index.js";
import { KeypressHandlerPriority, type InputPromptProps } from "../types.js";
import { buildAutocompleteReplacement } from "../utils/autocomplete-replacement.js";

/**
 * Extended props for InputPrompt with autocomplete support
 * InputPrompt 的扩展属性，支持自动补全
 */
export interface InputPromptAutocompleteProps extends InputPromptProps {
  /** Working directory for file completion - 文件补全的工作目录 */
  cwd?: string;
  /** Git root for skill discovery - 技能发现的 Git 根目录 */
  gitRoot?: string;
  /** Whether autocomplete is enabled (default: true) - 是否启用自动补全（默认：true） */
  autocompleteEnabled?: boolean;
}

export const InputPrompt: React.FC<InputPromptAutocompleteProps> = ({
  onSubmit,
  placeholder = "Type a message...",
  prompt = ">",
  focus = true,
  initialValue = "",
  cwd,
  gitRoot,
  autocompleteEnabled = true,
  onInputChange,
}) => {
  const theme = getTheme("dark");
  const { exit } = useApp();
  const [isFirstLine, setIsFirstLine] = useState(true);

  // Track last ESC press time for double-ESC detection
  // 跟踪上次 ESC 按下时间，用于双击检测
  const lastEscPressRef = useRef<number>(0);
  const DOUBLE_ESC_INTERVAL = 500; // ms - 双击间隔

  // Input history - 输入历史
  const { add: addHistory, navigateUp, navigateDown, reset: resetHistory, saveTempInput } = useInputHistory();

  // Text buffer - 文本缓冲区
  const { buffer, text, cursor, lines, setText, replaceRange, clear, move, insert, backspace, newline, delete: deleteChar } = useTextBuffer({
    initialValue,
    onSubmit: (submittedText) => {
      addHistory(submittedText);
      onSubmit(submittedText);
      setIsFirstLine(true);
    },
  });

  // Autocomplete integration - use context from parent if available, otherwise create local
  // 自动补全集成 - 优先使用父组件的 context，否则创建本地实例
  const contextAutocomplete = useAutocompleteContext();
  const localAutocomplete = useAutocomplete({
    cwd,
    gitRoot,
    enabled: autocompleteEnabled,
  });

  // Use context if available (from AutocompleteContextProvider in InkREPL)
  // 如果有 context 则使用（来自 InkREPL 中的 AutocompleteContextProvider）
  const {
    state: autocompleteState,
    suggestions,
    handleInput: handleAutocompleteInput,
    handleTab,
    handleEnter,
    handleUp: handleAutocompleteUp,
    handleDown: handleAutocompleteDown,
    handleEscape: handleAutocompleteEscape,
  } = contextAutocomplete ?? localAutocomplete;

  // Track previous text to detect changes - 跟踪前一次文本以检测变化
  const prevTextRef = useRef(text);

  // Notify parent of input changes - 通知父组件输入变化
  useEffect(() => {
    if (onInputChange) {
      onInputChange(text);
    }
  }, [text, onInputChange]);

  // Calculate absolute cursor position from row/col - 从行/列计算绝对光标位置
  // Trigger autocomplete when text changes - 文本变化时触发自动补全
  useEffect(() => {
    if (!autocompleteEnabled) return;

    // Only trigger if text actually changed - 只有文本实际变化时才触发
    if (text !== prevTextRef.current) {
      prevTextRef.current = text;
      const cursorPos = buffer.getAbsoluteOffset();
      handleAutocompleteInput(text, cursorPos);
    }
  }, [buffer, text, autocompleteEnabled, handleAutocompleteInput]);

  // Update isFirstLine state - 更新 isFirstLine 状态
  useEffect(() => {
    setIsFirstLine(cursor.row === 0);
  }, [cursor.row]);

  // Handle submit - 处理提交
  const handleSubmit = useCallback(() => {
    if (text.trim()) {
      addHistory(text);
      onSubmit(text);
      clear();
      setIsFirstLine(true);
    }
  }, [text, addHistory, onSubmit, clear]);

  // Handle line continuation (remove backslash at end of line) - 处理换行（删除行尾的反斜杠）
  const handleLineContinuation = useCallback(() => {
    const currentLine = lines[cursor.row] ?? "";
    if (currentLine.endsWith("\\")) {
      // Remove backslash - 删除反斜杠
      backspace();
    }
    newline();
  }, [lines, cursor.row, backspace, newline]);

  // Handle accepting a completion - 处理接受补全
  const acceptCompletion = useCallback((completion: SelectedCompletion): boolean => {
    if (!completion || !completion.text) return false;

    const replacement = buildAutocompleteReplacement(
      text,
      buffer.getAbsoluteOffset(),
      completion
    );
    replaceRange(replacement.start, replacement.end, replacement.replacement);
    return true;
  }, [buffer, text, replaceRange]);

  // Keyboard input handling - use centralized KeypressContext
  // Reference Gemini CLI: use priority system to register handlers - 键盘输入处理 - 使用 centralized KeypressContext，参考 Gemini CLI: 使用优先级系统注册处理器
  useKeypress(
    KeypressHandlerPriority.High, // High priority, ensure input component handles first - 高优先级，确保输入组件优先处理
    (key) => {
      if (!focus) return false;

      // Autocomplete navigation and selection (when dropdown visible)
      // 自动补全导航和选择（当下拉框可见时）
      const isAutocompleteVisible = autocompleteState.visible && suggestions.length > 0;

      // Tab key - accept completion if visible
      // Tab 键 - 如果下拉框可见则接受补全
      if (key.name === "tab" && isAutocompleteVisible) {
        const completion = handleTab();
        if (completion) {
          acceptCompletion(completion);
        }
        return true;
      }

      // Ctrl+C clear or exit - Ctrl+C 清空或退出
      if (key.ctrl && key.name === "c") {
        if (text.length > 0) {
          clear();
          resetHistory();
        } else {
          // Exit program when no text - 没有文字时退出程序
          exit();
        }
        return true;
      }

      // ESC key - cancel autocomplete (single), or clear input (double)
      // ESC 键 - 单击取消补全，双击清空输入
      if (key.name === "escape") {
        // Single ESC: cancel autocomplete if visible - 单击 ESC：如果补全可见则取消
        if (isAutocompleteVisible) {
          handleAutocompleteEscape();
          lastEscPressRef.current = 0; // Reset double-ESC timer
          return true;
        }

        // Check for double ESC - 检测双击 ESC
        const now = Date.now();
        const timeSinceLastEsc = now - lastEscPressRef.current;

        if (timeSinceLastEsc < DOUBLE_ESC_INTERVAL && text.length > 0) {
          // Double ESC: clear input only - 双击 ESC：仅清空输入
          lastEscPressRef.current = 0;
          clear();
          resetHistory();
        } else {
          // First ESC: just record the time - 第一次 ESC：只记录时间
          lastEscPressRef.current = now;
        }
        return true;
      }

      // Handle up arrow - autocomplete navigation takes priority over history
      // 处理上箭头 - 自动补全导航优先于历史
      if (key.name === "up") {
        if (isAutocompleteVisible) {
          // Navigate autocomplete suggestions - 导航自动补全建议
          handleAutocompleteUp();
          return true;
        }
        if (cursor.row === 0) {
          // First line → load previous history - 第一行 → 加载上一条历史
          saveTempInput(text);
          const historyText = navigateUp();
          if (historyText !== null) {
            setText(historyText);
          }
        } else {
          move("up");
        }
        return true;
      }

      // Handle down arrow - autocomplete navigation takes priority over history
      // 处理下箭头 - 自动补全导航优先于历史
      if (key.name === "down") {
        if (isAutocompleteVisible) {
          // Navigate autocomplete suggestions - 导航自动补全建议
          handleAutocompleteDown();
          return true;
        }
        const lineCount = lines.length;
        const isLastLine = cursor.row === lineCount - 1;

        if (isLastLine) {
          // Last line → load next history - 最后一行 → 加载下一条历史
          const historyText = navigateDown();
          // navigateDown returns string (may be empty string) or null (no navigation)
          // Reference Gemini CLI/OpenCode: always update text, including empty string - navigateDown 返回 string（可能是空字符串）或 null（表示没有导航），参考 Gemini CLI/OpenCode: 总是更新文本，包括空字符串
          if (historyText !== null) {
            setText(historyText);
          }
          // If returns null, already at latest position, do nothing - 如果返回 null，说明已经在最新位置，不做任何操作
        } else {
          move("down");
        }
        return true;
      }

      // Left/right arrow keys - 左右方向键
      if (key.name === "left") {
        move("left");
        return true;
      }
      if (key.name === "right") {
        move("right");
        return true;
      }

      // Backspace key - delete character before cursor
      // Use centralized parser, both \b and \x7f are correctly identified as backspace - Backspace 键 - 删除光标前的字符，使用 centralized parser，\b 和 \x7f 都正确识别为 backspace
      if (key.name === "backspace") {
        backspace();
        return true;
      }

      // Delete key - delete character after cursor
      // Only true Delete key (\x1b[3~) triggers this - Delete 键 - 删除光标后的字符，只有真正的 Delete 键（\x1b[3~）才会触发这个
      if (key.name === "delete") {
        deleteChar();
        return true;
      }

      // Line break - Shift+Enter, Ctrl+Enter, or Ctrl+J (newline)
      // Reference Gemini CLI: multiple ways to insert line break - 换行 - Shift+Enter, Ctrl+Enter, 或 Ctrl+J (newline)，参考 Gemini CLI: 多种方式插入换行
      if (
        (key.name === "return" && key.shift) ||
        (key.name === "return" && key.ctrl) ||
        key.name === "newline"  // Ctrl+J 或终端发送的 \n
      ) {
        newline();
        return true;
      }

      // Enter to submit or accept completion
      // 当补全列表可见时，Enter 接受补全并立即发送（参考 claude-code 行为）
      if (key.name === "return") {
        // If autocomplete visible, accept completion and submit immediately
        // 如果自动补全可见，接受补全并立即发送
        if (isAutocompleteVisible) {
          const completion = handleEnter();
          if (completion) {
            // Calculate the final text after completion using smart replacement
            // 使用智能替换计算补全后的最终文本
            const replacement = buildAutocompleteReplacement(
              text,
              buffer.getAbsoluteOffset(),
              completion
            );
            const finalText =
              text.slice(0, replacement.start) +
              replacement.replacement +
              text.slice(replacement.end);
            // Submit directly with the completed text
            // 直接使用补全后的文本发送
            if (finalText.trim()) {
              addHistory(finalText);
              onSubmit(finalText);
              clear();
              setIsFirstLine(true);
            }
          } else {
            // No completion selected, just close dropdown and submit current text
            // 没有选中补全，关闭下拉框并发送当前文本
            const currentLine = lines[cursor.row] ?? "";
            if (currentLine.endsWith("\\")) {
              handleLineContinuation();
              return true;
            }
            handleSubmit();
          }
          return true;
        }

        // Check if line break needed (line ends with \) - 检查是否需要换行 (行尾是 \)
        const currentLine = lines[cursor.row] ?? "";
        if (currentLine.endsWith("\\")) {
          handleLineContinuation();
          return true;
        }

        // Submit - 提交
        handleSubmit();
        return true;
      }

      // Ctrl key combinations - Ctrl 组合键
      if (key.ctrl) {
        switch (key.name) {
          case "a":
            move("home");
            return true;
          case "e":
            move("end");
            return true;
        }
        return true;
      }

      // Regular character input (exclude control characters)
      // Use insertable property to determine if insertable - 普通字符输入（排除控制字符），使用 insertable 属性判断是否可插入
      if (key.insertable && !key.ctrl && !key.meta) {
        insert(key.sequence);
        return true;
      }

      return false;
    },
    [focus, text, cursor, lines, clear, resetHistory, saveTempInput, navigateUp, navigateDown, setText, move, backspace, deleteChar, newline, handleSubmit, handleLineContinuation, insert, autocompleteState.visible, suggestions.length, handleTab, handleEnter, handleAutocompleteEscape, handleAutocompleteUp, handleAutocompleteDown, acceptCompletion]
  );

  return (
    <Box flexDirection="column" marginY={1}>
      {/*
        SuggestionsDisplay is now rendered in InkREPL via AutocompleteContextProvider
        This prevents input box jitter when suggestions appear/disappear

        SuggestionsDisplay 现在通过 AutocompleteContextProvider 在 InkREPL 中渲染
        这样可以防止建议出现/消失时输入框抖动
      */}
      <TextInput
        lines={lines}
        cursorRow={cursor.row}
        cursorCol={cursor.col}
        prompt={prompt}
        placeholder={placeholder}
        focus={focus}
        theme="dark"
      />
    </Box>
  );
};

/**
 * Simplified InputPrompt - single-line mode - 简化版 InputPrompt - 单行模式
 */
export const SimpleInputPrompt: React.FC<{
  onSubmit: (text: string) => void;
  placeholder?: string;
  prompt?: string;
}> = ({ onSubmit, placeholder, prompt = ">" }) => {
  const [value, setValue] = useState("");
  const [cursorCol, setCursorCol] = useState(0);

  useKeypress(
    KeypressHandlerPriority.High,
    (key) => {
      if (key.name === "return") {
        if (value.trim()) {
          onSubmit(value);
          setValue("");
          setCursorCol(0);
        }
        return true;
      }

      if (key.name === "backspace" && cursorCol > 0) {
        const before = [...value].slice(0, cursorCol - 1).join("");
        const after = [...value].slice(cursorCol).join("");
        setValue(before + after);
        setCursorCol(cursorCol - 1);
        return true;
      }

      if (key.name === "left" && cursorCol > 0) {
        setCursorCol(cursorCol - 1);
        return true;
      }

      if (key.name === "right" && cursorCol < [...value].length) {
        setCursorCol(cursorCol + 1);
        return true;
      }

      if (key.insertable && !key.ctrl && !key.meta) {
        const before = [...value].slice(0, cursorCol).join("");
        const after = [...value].slice(cursorCol).join("");
        setValue(before + key.sequence + after);
        setCursorCol(cursorCol + 1);
        return true;
      }

      return false;
    },
    [value, cursorCol, onSubmit]
  );

  const theme = getTheme("dark");

  if (!value) {
    return (
      <Box>
        <Text color={theme.colors.primary}>{prompt} </Text>
        {placeholder && <Text dimColor>{placeholder}</Text>}
        <Text backgroundColor={theme.colors.primary} color="#000000"> </Text>
      </Box>
    );
  }

  const beforeCursor = [...value].slice(0, cursorCol).join("");
  const cursorChar = [...value][cursorCol] ?? " ";
  const afterCursor = [...value].slice(cursorCol + 1).join("");

  return (
    <Box>
      <Text color={theme.colors.primary}>{prompt} </Text>
      <Text>{beforeCursor}</Text>
      <Text backgroundColor={theme.colors.primary} color="#000000">
        {cursorChar}
      </Text>
      <Text>{afterCursor}</Text>
    </Box>
  );
};
