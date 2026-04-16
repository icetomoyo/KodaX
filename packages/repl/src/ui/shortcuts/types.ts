/**
 * Keyboard Shortcuts System - Type Definitions
 * 键盘快捷键系统 - 类型定义
 *
 * Reference: Issue 083 - 缺少快捷键系统
 * Design: Centralized, discoverable, configurable shortcuts
 */

// === Shortcut Action IDs ===

/**
 * All available shortcut action identifiers
 * 所有可用的快捷键操作标识符
 */
export type ShortcutActionId =
  // Global shortcuts - 全局快捷键
  | 'interrupt' // Ctrl+C - 中断当前操作
  | 'clearScreen' // Ctrl+L - 清屏
  | 'showHelp' // ? - 显示帮助
  | 'toggleThinking' // Ctrl+T - 切换 Extended Thinking
  | 'toggleTranscriptMode' // Ctrl+O - toggle transcript mode
  | 'openTranscriptSearch' // Ctrl+F - search transcript
  | 'togglePermissionMode' // Shift+Tab - 切换权限模式
  | 'toggleAgentMode' // Alt+M - 切换 AMA / SA
  | 'submitInput' // Enter - 提交输入
  // Input shortcuts - 输入快捷键
  | 'acceptCompletion' // Tab - 接受补全
  | 'historyUp' // Up - 历史上一条
  | 'historyDown' // Down - 历史下一条
  | 'cancelInput' // Escape - 取消输入/清空
  | 'newline' // Shift+Enter / Ctrl+J - 换行
  | 'moveLeft' // Left - 左移光标
  | 'moveRight' // Right - 右移光标
  | 'backspace' // Backspace - 删除前一个字符
  | 'delete' // Delete - 删除后一个字符
  | 'moveLineUp' // Ctrl+Up - 移动到上一行
  | 'moveLineDown' // Ctrl+Down - 移动到下一行
  | 'moveToStart' // Ctrl+A - 移动到行首
  | 'moveToEnd' // Ctrl+E - 移动到行尾
  | 'killLineRight' // Ctrl+K - delete to end of line
  | 'killLineLeft' // Ctrl+U - delete to start of line
  | 'deleteWordLeft'; // Ctrl+W / Alt+Backspace - delete previous word

// === Key Binding ===

/**
 * Key binding definition
 * 按键绑定定义
 */
export interface KeyBinding {
  /** Key name (e.g., 'c', 'enter', 'escape') - 按键名称 */
  key: string;
  /** Ctrl key modifier - Ctrl 修饰键 */
  ctrl?: boolean;
  /** Shift key modifier - Shift 修饰键 */
  shift?: boolean;
  /** Meta/Alt key modifier - Meta/Alt 修饰键 */
  meta?: boolean;
}

// === Shortcut Context ===

/**
 * Shortcut activation context
 * 快捷键激活上下文
 *
 * - global: Always active (e.g., clearScreen)
 * - input: Active when input prompt is focused
 * - streaming: Active during LLM response streaming
 */
export type ShortcutContext = 'global' | 'input' | 'streaming';

// === Shortcut Category ===

/**
 * Shortcut category for grouping in help display
 * 快捷键分类，用于帮助显示中的分组
 */
export type ShortcutCategory =
  | 'global' // Global operations - 全局操作
  | 'navigation' // Navigation - 导航
  | 'editing' // Text editing - 文本编辑
  | 'mode'; // Mode switching - 模式切换

// === Shortcut Definition ===

/**
 * Complete shortcut definition
 * 完整的快捷键定义
 */
export interface ShortcutDefinition {
  /** Unique action identifier - 唯一操作标识符 */
  id: ShortcutActionId;
  /** Display name - 显示名称 */
  name: string;
  /** Detailed description - 详细描述 */
  description: string;
  /** Default key bindings - 默认按键绑定 */
  defaultBindings: KeyBinding[];
  /** Activation context - 激活上下文 */
  context: ShortcutContext;
  /** Priority for conflict resolution (higher = more important) - 优先级用于冲突解决（越高越重要） */
  priority: number;
  /** Category for help grouping - 分类用于帮助分组 */
  category: ShortcutCategory;
  /** Whether this shortcut is user-configurable - 是否可由用户配置 */
  configurable?: boolean;
}

// === Handler Types ===

/**
 * Shortcut handler function
 * 快捷键处理函数
 *
 * @returns true if the shortcut was handled and should stop propagation
 *          返回 true 表示快捷键已处理，应停止传播
 */
export type ShortcutHandler = () => boolean | void;

/**
 * Options for useShortcut hook
 * useShortcut hook 的选项
 */
export interface UseShortcutOptions {
  /** Activation context (default: from shortcut definition) - 激活上下文（默认：从快捷键定义获取） */
  context?: ShortcutContext;
  /** Whether the shortcut is currently active (default: true) - 快捷键是否当前激活（默认：true） */
  isActive?: boolean;
}

// === Registry Types ===

/**
 * Registered shortcut entry
 * 已注册的快捷键条目
 */
export interface RegisteredShortcut {
  /** Shortcut definition - 快捷键定义 */
  definition: ShortcutDefinition;
  /** Current effective bindings (default + user overrides) - 当前有效绑定（默认 + 用户覆盖） */
  effectiveBindings: KeyBinding[];
  /** Handler function - 处理函数 */
  handler?: ShortcutHandler;
}

/**
 * Key match result
 * 按键匹配结果
 */
export interface KeyMatchResult {
  /** Matched shortcut definition - 匹配的快捷键定义 */
  shortcut: ShortcutDefinition;
  /** Whether the key was consumed - 按键是否被消费 */
  consumed: boolean;
}

