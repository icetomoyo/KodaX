/**
 * Default Keyboard Shortcuts
 * 默认键盘快捷键定义
 *
 * Reference: Issue 083 - 键盘快捷键系统
 */

import type { ShortcutDefinition } from './types.js';

/**
 * Default shortcut definitions
 * 默认快捷键定义
 *
 * Priority guidelines (InputPrompt uses priority 100):
 * - 200+: Critical - Always handled first (e.g., interrupt)
 * - 150-199: Global shortcuts - Must be higher than InputPrompt to intercept Ctrl+keys
 * - 100-149: Reserved for InputPrompt internal handlers
 * - 0-99: Normal - Standard shortcuts (e.g., navigation, editing)
 */
export const DEFAULT_SHORTCUTS: ShortcutDefinition[] = [
  // === Global Shortcuts - 全局快捷键 ===

  {
    id: 'interrupt',
    name: '中断',
    description: '中断当前操作/流式输出',
    defaultBindings: [{ key: 'c', ctrl: true }],
    context: 'global', // Changed from 'streaming' - isActive controls when it triggers
    priority: 200, // Critical - must handle first
    category: 'global',
    configurable: false, // Interrupt should not be easily changed
  },

  {
    id: 'showHelp',
    name: '显示帮助',
    description: '显示快捷键帮助面板',
    defaultBindings: [{ key: '?' }],
    context: 'global',
    priority: 150, // Must be higher than InputPrompt (100) to intercept ? before typing
    category: 'global',
    configurable: true,
  },

  {
    id: 'toggleThinking',
    name: '切换思考模式',
    description: '开启/关闭 Extended Thinking',
    defaultBindings: [{ key: 't', ctrl: true }],
    context: 'global',
    priority: 150, // Must be higher than InputPrompt (100) to intercept before input handling
    category: 'mode',
    configurable: true,
  },

  {
    id: 'togglePermissionMode',
    name: '切换权限模式',
    description: '循环切换权限模式 (plan → accept-edits → auto-in-project)',
    defaultBindings: [
      { key: 'o', ctrl: true },
      { key: 'tab', shift: true },
    ],
    context: 'global',
    priority: 150, // Must be higher than InputPrompt (100) to intercept before input handling
    category: 'mode',
    configurable: true,
  },

  // === Input Shortcuts - 输入快捷键 ===

  {
    id: 'submitInput',
    name: '提交输入',
    description: '提交当前输入',
    defaultBindings: [{ key: 'enter' }],
    context: 'input',
    priority: 50,
    category: 'global',
    configurable: false, // Enter is standard for submission
  },

  {
    id: 'acceptCompletion',
    name: '接受补全',
    description: '接受自动补全建议',
    defaultBindings: [{ key: 'tab' }],
    context: 'input',
    priority: 60,
    category: 'editing',
    configurable: true,
  },

  {
    id: 'cancelInput',
    name: '取消输入',
    description: '取消当前输入或清空输入框',
    defaultBindings: [{ key: 'escape' }],
    context: 'input',
    priority: 70,
    category: 'editing',
    configurable: true,
  },

  {
    id: 'newline',
    name: '换行',
    description: '在输入中插入换行',
    defaultBindings: [
      { key: 'enter', shift: true },
      { key: 'j', ctrl: true },
    ],
    context: 'input',
    priority: 40,
    category: 'editing',
    configurable: true,
  },

  // === History Navigation - 历史导航 ===

  {
    id: 'historyUp',
    name: '历史上一条',
    description: '浏览上一条历史记录',
    defaultBindings: [{ key: 'up' }],
    context: 'input',
    priority: 30,
    category: 'navigation',
    configurable: true,
  },

  {
    id: 'historyDown',
    name: '历史下一条',
    description: '浏览下一条历史记录',
    defaultBindings: [{ key: 'down' }],
    context: 'input',
    priority: 30,
    category: 'navigation',
    configurable: true,
  },

  // === Cursor Movement - 光标移动 ===

  {
    id: 'moveLeft',
    name: '左移光标',
    description: '将光标向左移动',
    defaultBindings: [{ key: 'left' }],
    context: 'input',
    priority: 20,
    category: 'navigation',
    configurable: false, // Standard navigation
  },

  {
    id: 'moveRight',
    name: '右移光标',
    description: '将光标向右移动',
    defaultBindings: [{ key: 'right' }],
    context: 'input',
    priority: 20,
    category: 'navigation',
    configurable: false, // Standard navigation
  },

  {
    id: 'moveToStart',
    name: '移动到行首',
    description: '将光标移动到行首',
    defaultBindings: [{ key: 'a', ctrl: true }],
    context: 'input',
    priority: 25,
    category: 'navigation',
    configurable: true,
  },

  {
    id: 'moveToEnd',
    name: '移动到行尾',
    description: '将光标移动到行尾',
    defaultBindings: [{ key: 'e', ctrl: true }],
    context: 'input',
    priority: 25,
    category: 'navigation',
    configurable: true,
  },

  {
    id: 'moveLineUp',
    name: '移动到上一行',
    description: '在多行输入中移动到上一行',
    defaultBindings: [{ key: 'up', ctrl: true }],
    context: 'input',
    priority: 20,
    category: 'navigation',
    configurable: true,
  },

  {
    id: 'moveLineDown',
    name: '移动到下一行',
    description: '在多行输入中移动到下一行',
    defaultBindings: [{ key: 'down', ctrl: true }],
    context: 'input',
    priority: 20,
    category: 'navigation',
    configurable: true,
  },

  // === Editing - 编辑 ===

  {
    id: 'backspace',
    name: '删除前一个字符',
    description: '删除光标前的一个字符',
    defaultBindings: [{ key: 'backspace' }],
    context: 'input',
    priority: 10,
    category: 'editing',
    configurable: false, // Standard editing
  },

  {
    id: 'delete',
    name: '删除后一个字符',
    description: '删除光标后的一个字符',
    defaultBindings: [{ key: 'delete' }],
    context: 'input',
    priority: 10,
    category: 'editing',
    configurable: false, // Standard editing
  },
];

/**
 * Get shortcuts by context
 * 按上下文获取快捷键
 */
export function getShortcutsByContext(
  context: ShortcutDefinition['context']
): ShortcutDefinition[] {
  return DEFAULT_SHORTCUTS.filter((s) => s.context === context || s.context === 'global');
}

/**
 * Get shortcuts by category
 * 按分类获取快捷键
 */
export function getShortcutsByCategory(
  category: ShortcutDefinition['category']
): ShortcutDefinition[] {
  return DEFAULT_SHORTCUTS.filter((s) => s.category === category);
}

/**
 * Get configurable shortcuts
 * 获取可配置的快捷键
 */
export function getConfigurableShortcuts(): ShortcutDefinition[] {
  return DEFAULT_SHORTCUTS.filter((s) => s.configurable !== false);
}
