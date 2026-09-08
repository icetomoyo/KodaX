/**
 * InputPrompt - Input prompt component - 输入提示组件
 *
 * Integrates multi-line input, history navigation, keyboard shortcuts
 * through a dedicated prompt input controller. - 通过独立的输入控制器集成多行输入、历史导航和键盘快捷键
 */

import React, { useState } from "react";
import { Box, Text, useApp } from "../tui.js";
import { TextInput } from "./TextInput.js";
import { useKeypress } from "../contexts/KeypressContext.js";
import { getTheme } from "../themes/index.js";
import { KeypressHandlerPriority, type InputPromptProps } from "../types.js";
import { usePromptInputController } from "../utils/prompt-input-controller.js";

/**
 * Extended props for InputPrompt with autocomplete support
 * InputPrompt 的扩展属性，支持自动补全
 */
export interface InputPromptAutocompleteProps extends InputPromptProps {
  /** Working directory for file completion - 閺傚洣娆㈢悰銉ュ弿閻ㄥ嫬浼愭担婊呮窗瑜?*/
  cwd?: string;
  /** Git root for skill discovery - 技能发现的 Git 根目录 */
  gitRoot?: string;
  sessionId?: string;
  /** Whether autocomplete is enabled (default: true) - 是否启用自动补全（默认：true） */
  autocompleteEnabled?: boolean;
}

export const InputPrompt: React.FC<InputPromptAutocompleteProps> = ({
  onSubmit,
  onHistoryRecall,
  onPopPendingInputs,
  placeholder = "Type a message...",
  prompt = ">",
  focus = true,
  initialValue = "",
  cwd,
  gitRoot,
  sessionId,
  autocompleteEnabled = true,
  onInputChange,
  onPasteFallback,
}) => {
  const { exit } = useApp();
  const {
    cursor,
    lines,
    handleKey,
    isPasting,
    terminalFocused,
    editingMode,
  } = usePromptInputController({
    onSubmit,
    onExit: exit,
    focus,
    initialValue,
    cwd,
    gitRoot,
    sessionId,
    autocompleteEnabled,
    onInputChange,
    onPasteFallback,
    onHistoryRecall,
    onPopPendingInputs,
  });

  useKeypress(
    KeypressHandlerPriority.High,
    (key) => handleKey(key),
    [handleKey],
  );

  return (
    <Box flexDirection="column">
      <TextInput
        lines={lines}
        cursorRow={cursor.row}
        cursorCol={cursor.col}
        prompt={prompt}
        placeholder={placeholder}
        focus={focus}
        terminalFocused={terminalFocused}
        isPasting={isPasting}
        editingMode={editingMode}
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
