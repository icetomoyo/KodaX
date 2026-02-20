/**
 * UI 组件共享类型定义
 *
 * 参考 Gemini CLI 架构设计，使用 Context + Reducer 模式管理状态。
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

// ============================================================================
// Phase 6: 新增类型 - 参考 Gemini CLI 架构
// ============================================================================

// === 流式状态 ===

/**
 * 流式响应状态枚举
 * 参考: Gemini CLI StreamingContext.tsx
 */
export enum StreamingState {
  Idle = "idle",
  Responding = "responding",
  WaitingForConfirmation = "waiting_for_confirmation",
}

// === 工具调用 ===

/**
 * 工具调用状态枚举
 * 参考: Gemini CLI useToolScheduler
 */
export enum ToolCallStatus {
  Scheduled = "scheduled",
  Validating = "validating",
  AwaitingApproval = "awaiting_approval",
  Executing = "executing",
  Success = "success",
  Error = "error",
  Cancelled = "cancelled",
}

/**
 * 工具调用状态图标
 */
export const TOOL_STATUS_ICONS: Record<ToolCallStatus, string> = {
  [ToolCallStatus.Scheduled]: "○",
  [ToolCallStatus.Validating]: "◌",
  [ToolCallStatus.AwaitingApproval]: "?",
  [ToolCallStatus.Executing]: "○",
  [ToolCallStatus.Success]: "✓",
  [ToolCallStatus.Error]: "✗",
  [ToolCallStatus.Cancelled]: "-",
};

/**
 * 单个工具调用
 */
export interface ToolCall {
  id: string;
  name: string;
  status: ToolCallStatus;
  input?: Record<string, unknown>;
  output?: unknown;
  error?: string;
  progress?: number; // 0-100
  startTime: number;
  endTime?: number;
}

// === 历史项 ===

/**
 * 历史项类型
 * 参考: Gemini CLI HistoryItem
 */
export type HistoryItemType =
  | "user"
  | "assistant"
  | "system"
  | "tool_group"
  | "thinking"
  | "error"
  | "info"
  | "hint";

/**
 * 历史项基类
 */
export interface HistoryItemBase {
  id: string;
  type: HistoryItemType;
  timestamp: number;
}

/**
 * 用户消息
 */
export interface HistoryItemUser extends HistoryItemBase {
  type: "user";
  text: string;
}

/**
 * 助手消息
 */
export interface HistoryItemAssistant extends HistoryItemBase {
  type: "assistant";
  text: string;
  isStreaming?: boolean;
}

/**
 * 系统消息
 */
export interface HistoryItemSystem extends HistoryItemBase {
  type: "system";
  text: string;
}

/**
 * 工具组
 */
export interface HistoryItemToolGroup extends HistoryItemBase {
  type: "tool_group";
  tools: ToolCall[];
}

/**
 * 思考内容
 */
export interface HistoryItemThinking extends HistoryItemBase {
  type: "thinking";
  text: string;
}

/**
 * 错误消息
 */
export interface HistoryItemError extends HistoryItemBase {
  type: "error";
  text: string;
}

/**
 * 信息消息
 */
export interface HistoryItemInfo extends HistoryItemBase {
  type: "info";
  text: string;
  icon?: string;
}

/**
 * 提示消息
 */
export interface HistoryItemHint extends HistoryItemBase {
  type: "hint";
  text: string;
}

/**
 * 所有历史项的联合类型
 */
export type HistoryItem =
  | HistoryItemUser
  | HistoryItemAssistant
  | HistoryItemSystem
  | HistoryItemToolGroup
  | HistoryItemThinking
  | HistoryItemError
  | HistoryItemInfo
  | HistoryItemHint;

// === UI 状态 ===

/**
 * UI 全局状态接口
 * 参考: Gemini CLI UIStateContext
 */
export interface UIState {
  // 流式状态
  streamingState: StreamingState;

  // 当前正在流式传输的响应
  currentResponse: string;

  // 历史记录
  history: HistoryItem[];

  // 待处理的工具调用
  pendingToolCalls: ToolCall[];

  // 会话信息
  sessionId: string;
  mode: "code" | "ask";

  // Provider 信息
  provider: string;
  model: string;

  // Token 使用量
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };

  // 错误状态
  error?: string;

  // 加载状态
  isLoading: boolean;
}

/**
 * UI 操作接口
 */
export interface UIActions {
  // 流式操作
  setStreamingState: (state: StreamingState) => void;
  appendToResponse: (text: string) => void;
  clearResponse: () => void;

  // 历史操作
  addHistoryItem: (item: Omit<HistoryItem, "id" | "timestamp">) => void;
  updateHistoryItem: (id: string, updates: Partial<HistoryItem>) => void;
  clearHistory: () => void;

  // 工具操作
  addToolCall: (tool: Omit<ToolCall, "id" | "startTime">) => string;
  updateToolCall: (id: string, updates: Partial<ToolCall>) => void;
  clearToolCalls: () => void;

  // 会话操作
  setSessionId: (id: string) => void;
  setMode: (mode: "code" | "ask") => void;

  // Provider 操作
  setProvider: (provider: string) => void;
  setModel: (model: string) => void;

  // Token 操作
  setTokenUsage: (usage: UIState["tokenUsage"]) => void;

  // 错误操作
  setError: (error: string | undefined) => void;

  // 加载操作
  setLoading: (loading: boolean) => void;
}

// === 键盘优先级 ===

/**
 * 键盘事件处理器优先级
 * 参考: Gemini CLI KeypressContext
 */
export enum KeypressHandlerPriority {
  Low = -100,
  Normal = 0,
  High = 100,
  Critical = 200,
}

/**
 * 键盘事件处理器
 */
export type KeypressHandler = (event: KeyInfo) => boolean | void;

/**
 * 键盘事件
 */
export interface KeypressEvent {
  key: KeyInfo;
  handled: boolean;
}

// === 默认值 ===

/**
 * 默认 UI 状态
 */
export const DEFAULT_UI_STATE: UIState = {
  streamingState: StreamingState.Idle,
  currentResponse: "",
  history: [],
  pendingToolCalls: [],
  sessionId: "",
  mode: "code",
  provider: "",
  model: "",
  isLoading: false,
};

