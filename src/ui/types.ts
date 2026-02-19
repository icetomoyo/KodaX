/**
 * UI 组件共享类型定义
 */

import type { CursorPosition } from "./utils/text-buffer.js";

// === 键盘事件 ===

export interface KeyInfo {
  name: string;
  sequence: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

// === 文本缓冲区 ===

export type { CursorPosition };

export interface UseTextBufferReturn {
  buffer: import("./utils/text-buffer.js").TextBuffer;
  text: string;
  cursor: CursorPosition;
  lines: string[];
  setText: (text: string) => void;
  insert: (text: string, options?: { paste?: boolean }) => void;
  newline: () => void;
  backspace: () => void;
  delete: () => void;
  move: (direction: "up" | "down" | "left" | "right" | "home" | "end") => void;
  clear: () => void;
  undo: () => boolean;
  redo: () => boolean;
}

// === 输入历史 ===

export interface HistoryEntry {
  text: string;
  timestamp: number;
}

// === 自动补全 ===

export interface Completion {
  text: string; // 补全文本
  display: string; // 显示文本
  description?: string; // 描述
  type: "file" | "command" | "argument";
}

export interface Completer {
  canComplete(input: string, cursorPos: number): boolean;
  getCompletions(input: string, cursorPos: number): Promise<Completion[]>;
}

// === 主题 ===

export interface ThemeColors {
  primary: string; // 主色调
  secondary: string; // 次要颜色
  accent: string; // 强调色
  text: string; // 文本颜色
  dim: string; // 暗淡文本
  success: string; // 成功状态
  warning: string; // 警告状态
  error: string; // 错误状态
}

export interface ThemeSymbols {
  prompt: string;
  success: string;
  error: string;
  warning: string;
  spinner: string[];
}

export interface Theme {
  name: string;
  colors: ThemeColors;
  symbols: ThemeSymbols;
}

// === 组件 Props ===

export interface InputPromptProps {
  onSubmit: (text: string) => void;
  placeholder?: string;
  prompt?: string;
  focus?: boolean;
  initialValue?: string;
}

export interface StatusBarProps {
  sessionId: string;
  mode: "code" | "ask";
  provider: string;
  model: string;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
  currentTool?: string;
}

export interface MessageListProps {
  messages: Message[];
  isLoading?: boolean;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

// === 应用状态 ===

export interface AppState {
  messages: Message[];
  isLoading: boolean;
  error?: string;
  sessionId: string;
}

export interface AppProps {
  model: string;
  provider: string;
  onSubmit: (input: string) => Promise<void>;
}
