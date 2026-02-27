/**
 * UI Component Shared Type Definitions - UI 组件共享类型定义
 *
 * Reference: Gemini CLI architecture design, using Context + Reducer pattern for state management - 参考 Gemini CLI 架构设计，使用 Context + Reducer 模式管理状态。
 */

import type { CursorPosition } from "./utils/text-buffer.js";
import type { PermissionMode } from "@kodax/core";

// === Keyboard Events - 键盘事件 ===

/**
 * Keyboard info interface - 键盘信息接口
 * Reference: Gemini CLI Key interface - 参考: Gemini CLI Key interface
 */
export interface KeyInfo {
  name: string;
  sequence: string;
  ctrl: boolean;
  meta: boolean; // Alt key
  shift: boolean;
  insertable: boolean; // Whether can be inserted into text - 是否可以插入到文本中
}

// === Text Buffer - 文本缓冲区 ===

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

// === Input History - 输入历史 ===

export interface HistoryEntry {
  text: string;
  timestamp: number;
}

// === Autocomplete - 自动补全 ===

export interface Completion {
  text: string; // Completion text - 补全文本
  display: string; // Display text - 显示文本
  description?: string; // Description - 描述
  type: "file" | "command" | "argument";
}

export interface Completer {
  canComplete(input: string, cursorPos: number): boolean;
  getCompletions(input: string, cursorPos: number): Promise<Completion[]>;
}

// === Suggestions Display - 建议显示 ===

/**
 * Autocomplete suggestion item - 自动补全建议项
 * For SuggestionsDisplay component - 用于 SuggestionsDisplay 组件
 */
export interface Suggestion {
  id: string;
  text: string; // Suggestion text - 建议文本
  displayText?: string; // Display text (if different from text) - 显示文本（如果与 text 不同）
  description?: string; // Description - 描述
  type?: "command" | "file" | "history" | "argument" | "snippet"; // Type - 类型
  icon?: string; // Optional icon - 可选图标
}

// === Theme - 主题 ===

export interface ThemeColors {
  primary: string; // Primary color - 主色调
  secondary: string; // Secondary color - 次要颜色
  accent: string; // Accent color - 强调色
  text: string; // Text color - 文本颜色
  dim: string; // Dimmed text - 暗淡文本
  success: string; // Success state - 成功状态
  warning: string; // Warning state - 警告状态
  error: string; // Error state - 错误状态
  info: string; // Info state - 信息状态
  hint: string; // Hint state - 提示状态
  background: string; // Background color - 背景颜色
  inputBackground: string; // Input background color - 输入框背景颜色
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

// === Component Props - 组件 Props ===

export interface InputPromptProps {
  onSubmit: (text: string) => void;
  placeholder?: string;
  prompt?: string;
  focus?: boolean;
  initialValue?: string;
}

export interface StatusBarProps {
  sessionId: string;
  permissionMode: PermissionMode;
  provider: string;
  model: string;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
  currentTool?: string;
  thinking?: boolean;
}

/**
 * @deprecated Use MessageListProps from components/MessageList.js instead
 */
export interface LegacyMessageListProps {
  messages: Message[];
  isLoading?: boolean;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

// === Application State - 应用状态 ===

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
// Phase 6: New Types - Reference Gemini CLI Architecture - 新增类型 - 参考 Gemini CLI 架构
// ============================================================================

// === Streaming State - 流式状态 ===

/**
 * Streaming response state enum - 流式响应状态枚举
 * Reference: Gemini CLI StreamingContext.tsx - 参考: Gemini CLI StreamingContext.tsx
 */
export enum StreamingState {
  Idle = "idle",
  Responding = "responding",
  WaitingForConfirmation = "waiting_for_confirmation",
}

// === Tool Call - 工具调用 ===

/**
 * Tool call status enum - 工具调用状态枚举
 * Reference: Gemini CLI useToolScheduler - 参考: Gemini CLI useToolScheduler
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
 * Tool call status icons - 工具调用状态图标
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
 * Single tool call - 单个工具调用
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

// === History Items - 历史项 ===

/**
 * History item type - 历史项类型
 * Reference: Gemini CLI HistoryItem - 参考: Gemini CLI HistoryItem
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
 * History item base class - 历史项基类
 */
export interface HistoryItemBase {
  id: string;
  type: HistoryItemType;
  timestamp: number;
}

/**
 * User message - 用户消息
 */
export interface HistoryItemUser extends HistoryItemBase {
  type: "user";
  text: string;
}

/**
 * Assistant message - 助手消息
 */
export interface HistoryItemAssistant extends HistoryItemBase {
  type: "assistant";
  text: string;
  isStreaming?: boolean;
}

/**
 * System message - 系统消息
 */
export interface HistoryItemSystem extends HistoryItemBase {
  type: "system";
  text: string;
}

/**
 * Tool group - 工具组
 */
export interface HistoryItemToolGroup extends HistoryItemBase {
  type: "tool_group";
  tools: ToolCall[];
}

/**
 * Thinking content - 思考内容
 */
export interface HistoryItemThinking extends HistoryItemBase {
  type: "thinking";
  text: string;
}

/**
 * Error message - 错误消息
 */
export interface HistoryItemError extends HistoryItemBase {
  type: "error";
  text: string;
}

/**
 * Info message - 信息消息
 */
export interface HistoryItemInfo extends HistoryItemBase {
  type: "info";
  text: string;
  icon?: string;
}

/**
 * Hint message - 提示消息
 */
export interface HistoryItemHint extends HistoryItemBase {
  type: "hint";
  text: string;
}

/**
 * Union type of all history items - 所有历史项的联合类型
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

/**
 * Creatable history item types (with text property) - 可创建的历史项类型（带 text 属性）
 * Used for addHistoryItem function parameter type - 用于 addHistoryItem 等函数的参数类型
 */
export type CreatableHistoryItem =
  | Omit<HistoryItemUser, "id" | "timestamp">
  | Omit<HistoryItemAssistant, "id" | "timestamp">
  | Omit<HistoryItemSystem, "id" | "timestamp">
  | Omit<HistoryItemThinking, "id" | "timestamp">
  | Omit<HistoryItemError, "id" | "timestamp">
  | Omit<HistoryItemInfo, "id" | "timestamp">
  | Omit<HistoryItemHint, "id" | "timestamp">
  | Omit<HistoryItemToolGroup, "id" | "timestamp">;

// === UI State - UI 状态 ===

/**
 * UI global state interface - UI 全局状态接口
 * Reference: Gemini CLI UIStateContext - 参考: Gemini CLI UIStateContext
 */
export interface UIState {
  // Streaming state - 流式状态
  streamingState: StreamingState;

  // Currently streaming response - 当前正在流式传输的响应
  currentResponse: string;

  // History records - 历史记录
  history: HistoryItem[];

  // Pending tool calls - 待处理的工具调用
  pendingToolCalls: ToolCall[];

  // Session info - 会话信息
  sessionId: string;

  // Provider info - Provider 信息
  provider: string;
  model: string;

  // Token usage - Token 使用量
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };

  // Error state - 错误状态
  error?: string;

  // Loading state - 加载状态
  isLoading: boolean;
}

/**
 * UI actions interface - UI 操作接口
 */
export interface UIActions {
  // Streaming operations - 流式操作
  setStreamingState: (state: StreamingState) => void;
  appendToResponse: (text: string) => void;
  clearResponse: () => void;

  // History operations - 历史操作
  addHistoryItem: (item: CreatableHistoryItem) => void;
  updateHistoryItem: (id: string, updates: Partial<HistoryItem>) => void;
  clearHistory: () => void;

  // Tool operations - 工具操作
  addToolCall: (tool: Omit<ToolCall, "id" | "startTime">) => string;
  updateToolCall: (id: string, updates: Partial<ToolCall>) => void;
  clearToolCalls: () => void;

  // Session operations - 会话操作
  setSessionId: (id: string) => void;

  // Provider operations - Provider 操作
  setProvider: (provider: string) => void;
  setModel: (model: string) => void;

  // Token operations - Token 操作
  setTokenUsage: (usage: UIState["tokenUsage"]) => void;

  // Error operations - 错误操作
  setError: (error: string | undefined) => void;

  // Loading operations - 加载操作
  setLoading: (loading: boolean) => void;
}

// === Keyboard Priority - 键盘优先级 ===

/**
 * Keyboard event handler priority - 键盘事件处理器优先级
 * Reference: Gemini CLI KeypressContext - 参考: Gemini CLI KeypressContext
 */
export enum KeypressHandlerPriority {
  Low = -100,
  Normal = 0,
  High = 100,
  Critical = 200,
}

/**
 * Keyboard event handler - 键盘事件处理器
 */
export type KeypressHandler = (event: KeyInfo) => boolean | void;

/**
 * Keyboard event - 键盘事件
 */
export interface KeypressEvent {
  key: KeyInfo;
  handled: boolean;
}

// === Default Values - 默认值 ===

/**
 * Default UI state - 默认 UI 状态
 */
export const DEFAULT_UI_STATE: UIState = {
  streamingState: StreamingState.Idle,
  currentResponse: "",
  history: [],
  pendingToolCalls: [],
  sessionId: "",
  provider: "",
  model: "",
  isLoading: false,
};
