/**
 * ShortcutsRegistry - Centralized Keyboard Shortcuts Management
 * 快捷键注册表 - 集中式键盘快捷键管理
 *
 * Singleton pattern for managing all keyboard shortcuts
 * 单例模式，用于管理所有键盘快捷键
 *
 * Features:
 * - Register/unregister shortcuts
 * - Context-aware shortcut matching
 * - Priority-based conflict resolution
 */

import type { KeyInfo } from '../types.js';
import {
  type ShortcutActionId,
  type KeyBinding,
  type ShortcutContext,
  type ShortcutDefinition,
  type ShortcutHandler,
  type RegisteredShortcut,
} from './types.js';

/**
 * ShortcutsRegistry - Singleton class for managing keyboard shortcuts
 * ShortcutsRegistry - 管理键盘快捷键的单例类
 */
export class ShortcutsRegistry {
  private static instance: ShortcutsRegistry | null = null;

  /** Registered shortcuts by action ID - 按 ID 注册的快捷键 */
  private shortcuts: Map<ShortcutActionId, RegisteredShortcut> = new Map();

  /**
   * Get singleton instance
   * 获取单例实例
   */
  public static getInstance(): ShortcutsRegistry {
    if (!ShortcutsRegistry.instance) {
      ShortcutsRegistry.instance = new ShortcutsRegistry();
    }
    return ShortcutsRegistry.instance;
  }

  /**
   * Reset singleton (for testing)
   * 重置单例（用于测试）
   */
  public static resetInstance(): void {
    ShortcutsRegistry.instance = null;
  }

  /**
   * Register a shortcut definition
   * 注册快捷键定义
   */
  public register(definition: ShortcutDefinition): void {
    const existing = this.shortcuts.get(definition.id);
    this.shortcuts.set(definition.id, {
      definition,
      effectiveBindings: existing?.effectiveBindings ?? definition.defaultBindings,
      handler: existing?.handler,
    });
  }

  /**
   * Register multiple shortcut definitions
   * 注册多个快捷键定义
   */
  public registerAll(definitions: ShortcutDefinition[]): void {
    for (const def of definitions) {
      this.register(def);
    }
  }

  /**
   * Unregister a shortcut
   * 注销快捷键
   */
  public unregister(actionId: ShortcutActionId): boolean {
    return this.shortcuts.delete(actionId);
  }

  /**
   * Set handler for a shortcut
   * 设置快捷键的处理函数
   */
  public setHandler(actionId: ShortcutActionId, handler: ShortcutHandler | undefined): void {
    const entry = this.shortcuts.get(actionId);
    if (entry) {
      entry.handler = handler;
    }
  }

  /**
   * Find matching shortcut for a key event
   * 查找匹配按键事件的快捷键
   *
   * @param keyInfo - Key event info - 按键事件信息
   * @param context - Current context - 当前上下文
   * @returns Matching shortcut or null - 匹配的快捷键或 null
   */
  public findMatchingShortcut(
    keyInfo: KeyInfo,
    context: ShortcutContext
  ): RegisteredShortcut | null {
    let bestMatch: RegisteredShortcut | null = null;
    let bestPriority = -Infinity;

    for (const entry of this.shortcuts.values()) {
      // Check context compatibility
      // 'global' shortcuts work in all contexts
      const defContext = entry.definition.context;
      if (defContext !== 'global' && defContext !== context) {
        continue;
      }

      // Check key binding match
      if (!this.matchesBinding(keyInfo, entry.effectiveBindings)) {
        continue;
      }

      // Check if handler is registered
      if (!entry.handler) {
        continue;
      }

      // Priority comparison (higher wins)
      if (entry.definition.priority > bestPriority) {
        bestPriority = entry.definition.priority;
        bestMatch = entry;
      }
    }

    return bestMatch;
  }

  /**
   * Check if a key event matches a binding
   * 检查按键事件是否匹配绑定
   */
  private matchesBinding(keyInfo: KeyInfo, bindings: KeyBinding[]): boolean {
    for (const binding of bindings) {
      // Normalize key names
      const eventKey = this.normalizeKeyName(keyInfo.name);
      const bindingKey = this.normalizeKeyName(binding.key);

      if (eventKey === bindingKey) {
        const ctrlMatch = (binding.ctrl ?? false) === keyInfo.ctrl;
        const shiftMatch = (binding.shift ?? false) === keyInfo.shift;
        const metaMatch = (binding.meta ?? false) === keyInfo.meta;

        if (ctrlMatch && shiftMatch && metaMatch) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Normalize key name for comparison
   * 规范化按键名称用于比较
   */
  private normalizeKeyName(key: string): string {
    // Map common aliases
    const aliases: Record<string, string> = {
      return: 'enter',
      esc: 'escape',
      del: 'delete',
      backspace: 'backspace',
      ' ': 'space',
    };

    const normalized = key.toLowerCase();
    return aliases[normalized] ?? normalized;
  }

  /**
   * Execute shortcut handler if matched
   * 如果匹配则执行快捷键处理函数
   *
   * @param keyInfo - Key event info - 按键事件信息
   * @param context - Current context - 当前上下文
   * @returns true if shortcut was handled - 如果快捷键被处理则返回 true
   */
  public executeShortcut(keyInfo: KeyInfo, context: ShortcutContext): boolean {
    const match = this.findMatchingShortcut(keyInfo, context);
    if (match?.handler) {
      const result = match.handler();
      return result === true;
    }
    return false;
  }

  /**
   * Get all registered shortcuts
   * 获取所有已注册的快捷键
   */
  public getAllShortcuts(): RegisteredShortcut[] {
    return Array.from(this.shortcuts.values());
  }

  /**
   * Get shortcuts by category
   * 按分类获取快捷键
   */
  public getShortcutsByCategory(category: ShortcutDefinition['category']): RegisteredShortcut[] {
    return this.getAllShortcuts().filter((s) => s.definition.category === category);
  }

  /**
   * Get shortcuts by context
   * 按上下文获取快捷键
   */
  public getShortcutsByContext(context: ShortcutContext): RegisteredShortcut[] {
    return this.getAllShortcuts().filter((s) => {
      const defContext = s.definition.context;
      return defContext === 'global' || defContext === context;
    });
  }

  /**
   * Format key binding for display
   * 格式化按键绑定用于显示
   */
  public formatBinding(binding: KeyBinding): string {
    const parts: string[] = [];
    if (binding.ctrl) parts.push('Ctrl');
    if (binding.meta) parts.push('Alt');
    if (binding.shift) parts.push('Shift');

    // Capitalize key name
    const keyName = binding.key.length === 1 ? binding.key.toUpperCase() : binding.key;
    parts.push(keyName);

    return parts.join('+');
  }

  /**
   * Format all bindings for a shortcut
   * 格式化快捷键的所有绑定
   */
  public formatBindings(bindings: KeyBinding[]): string {
    return bindings.map((b) => this.formatBinding(b)).join(' or ');
  }
}

// Export singleton getter
export const getShortcutsRegistry = (): ShortcutsRegistry => ShortcutsRegistry.getInstance();
