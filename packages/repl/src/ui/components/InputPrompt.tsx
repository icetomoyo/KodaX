/**
 * InputPrompt - Input prompt component - 鏉堟挸鍙嗛幓鎰仛缂佸嫪娆?
 *
 * Integrates multi-line input, history navigation, keyboard shortcuts
 * through a dedicated prompt input controller. - 闁俺绻冮悪顒傜彌閻ㄥ嫯绶崗銉﹀付閸掕泛娅掗梿鍡樺灇婢舵俺顢戞潏鎾冲弳閵嗕礁宸婚崣鎻掝嚤閼割亜鎷伴柨顔炬磸韫囶偅宓庨柨顔衡偓?
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
 * InputPrompt 閻ㄥ嫭澧跨仦鏇炵潣閹嶇礉閺€顖涘瘮閼奉亜濮╃悰銉ュ弿
 */
export interface InputPromptAutocompleteProps extends InputPromptProps {
  /** Working directory for file completion - 閺傚洣娆㈢悰銉ュ弿閻ㄥ嫬浼愭担婊呮窗瑜?*/
  cwd?: string;
  /** Git root for skill discovery - 閹垛偓閼宠棄褰傞悳鎵畱 Git 閺嶅湱娲拌ぐ?*/
  gitRoot?: string;
  /** Whether autocomplete is enabled (default: true) - 閺勵垰鎯侀崥顖滄暏閼奉亜濮╃悰銉ュ弿閿涘牓绮拋銈忕窗true閿?*/
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
        terminalFocused={terminalFocused}
        isPasting={isPasting}
        editingMode={editingMode}
        theme="dark"
      />
    </Box>
  );
};

/**
 * Simplified InputPrompt - single-line mode - 缁犫偓閸栨牜澧?InputPrompt - 閸楁洝顢戝Ο鈥崇础
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

