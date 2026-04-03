/**
 * InputPrompt - Input prompt component - 杈撳叆鎻愮ず缁勪欢
 *
 * Integrates multi-line input, history navigation, keyboard shortcuts
 * through a dedicated prompt input controller. - 閫氳繃鐙珛鐨勮緭鍏ユ帶鍒跺櫒闆嗘垚澶氳杈撳叆銆佸巻鍙插鑸拰閿洏蹇嵎閿€?
 */

import React, { useState } from "react";
import { Box, Text, useApp } from "ink";
import { TextInput } from "./TextInput.js";
import { useKeypress } from "../contexts/KeypressContext.js";
import { getTheme } from "../themes/index.js";
import { KeypressHandlerPriority, type InputPromptProps } from "../types.js";
import { usePromptInputController } from "../utils/prompt-input-controller.js";

/**
 * Extended props for InputPrompt with autocomplete support
 * InputPrompt 鐨勬墿灞曞睘鎬э紝鏀寔鑷姩琛ュ叏
 */
export interface InputPromptAutocompleteProps extends InputPromptProps {
  /** Working directory for file completion - 鏂囦欢琛ュ叏鐨勫伐浣滅洰褰?*/
  cwd?: string;
  /** Git root for skill discovery - 鎶€鑳藉彂鐜扮殑 Git 鏍圭洰褰?*/
  gitRoot?: string;
  /** Whether autocomplete is enabled (default: true) - 鏄惁鍚敤鑷姩琛ュ叏锛堥粯璁わ細true锛?*/
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
  const { exit } = useApp();
  const { cursor, lines, handleKey } = usePromptInputController({
    onSubmit,
    onExit: exit,
    focus,
    initialValue,
    cwd,
    gitRoot,
    autocompleteEnabled,
    onInputChange,
  });

  useKeypress(
    KeypressHandlerPriority.High,
    (key) => handleKey(key),
    [handleKey],
  );

  return (
    <Box flexDirection="column" marginY={1}>
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
 * Simplified InputPrompt - single-line mode - 绠€鍖栫増 InputPrompt - 鍗曡妯″紡
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
