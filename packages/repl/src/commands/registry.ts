/**
 * Command Registry - Dynamic command registration system
 * 命令注册表 - 动态命令注册系统
 *
 * Provides centralized command management with source tracking,
 * supporting dynamic registration, lookup, and listing of commands.
 */

import type {
  CommandDefinition,
  CommandInfo,
  CommandSource,
} from './types.js';

/**
 * CommandRegistry - Centralized command management
 * 命令注册表 - 集中式命令管理
 *
 * @example
 * ```typescript
 * const registry = new CommandRegistry();
 *
 * // Register a command
 * registry.register({
 *   name: 'copy',
 *   description: 'Copy last message to clipboard',
 *   source: 'builtin',
 *   handler: async (args, context, callbacks, config) => {
 *     // Implementation
 *   }
 * });
 *
 * // Get a command
 * const cmd = registry.get('copy');
 *
 * // List all commands
 * const allCommands = registry.getAll();
 *
 * // List builtin commands only
 * const builtinCommands = registry.getBySource('builtin');
 * ```
 */
export class CommandRegistry {
  /**
   * Internal command storage
   * 内部命令存储
   */
  private commands = new Map<string, CommandDefinition>();

  /**
   * Alias to command name mapping
   * 别名到命令名称的映射
   */
  private aliases = new Map<string, string>();

  /**
   * Register a command
   * 注册命令
   *
   * @param def - Command definition
   * @throws Error if command with same name already exists
   */
  register(def: CommandDefinition): void {
    const normalizedName = def.name.toLowerCase();

    // Check if command already exists
    if (this.commands.has(normalizedName)) {
      throw new Error(`Command "${def.name}" is already registered`);
    }

    if (this.aliases.has(normalizedName)) {
      const owner = this.aliases.get(normalizedName);
      throw new Error(`Command "${def.name}" conflicts with existing alias for "${owner}"`);
    }

    const normalizedAliases = new Set<string>();
    for (const alias of def.aliases ?? []) {
      const normalizedAlias = alias.toLowerCase();

      if (normalizedAlias === normalizedName) {
        continue;
      }

      if (normalizedAliases.has(normalizedAlias)) {
        throw new Error(`Alias "${alias}" is duplicated within command "${def.name}"`);
      }
      if (this.commands.has(normalizedAlias)) {
        throw new Error(`Alias "${alias}" conflicts with existing command "${normalizedAlias}"`);
      }
      if (this.aliases.has(normalizedAlias)) {
        const owner = this.aliases.get(normalizedAlias);
        throw new Error(`Alias "${alias}" is already registered for "${owner}"`);
      }

      normalizedAliases.add(normalizedAlias);
    }

    // Store command with source (default to 'builtin')
    this.commands.set(normalizedName, {
      ...def,
      source: def.source ?? 'builtin',
    });

    // Register aliases
    if (def.aliases) {
      for (const alias of def.aliases) {
        const normalizedAlias = alias.toLowerCase();
        if (normalizedAlias === normalizedName) {
          continue;
        }
        this.aliases.set(normalizedAlias, normalizedName);
      }
    }
  }

  /**
   * Unregister a command
   * 注销命令
   *
   * @param name - Command name or alias
   * @returns true if command was unregistered, false if not found
   */
  unregister(name: string): boolean {
    const normalizedName = name.toLowerCase();

    // Check if it's an alias
    const commandName = this.aliases.get(normalizedName) ?? normalizedName;

    // Check if command exists
    if (!this.commands.has(commandName)) {
      return false;
    }

    // Get command definition to remove aliases
    const def = this.commands.get(commandName);
    if (def?.aliases) {
      for (const alias of def.aliases) {
        this.aliases.delete(alias.toLowerCase());
      }
    }

    // Remove command
    this.commands.delete(commandName);
    return true;
  }

  /**
   * Get a command by name or alias
   * 通过名称或别名获取命令
   *
   * @param name - Command name or alias
   * @returns Command definition or undefined if not found
   */
  get(name: string): CommandDefinition | undefined {
    const normalizedName = name.toLowerCase();

    // Check if it's an alias
    const commandName = this.aliases.get(normalizedName) ?? normalizedName;

    return this.commands.get(commandName);
  }

  /**
   * Check if a command exists
   * 检查命令是否存在
   *
   * @param name - Command name or alias
   * @returns true if command exists, false otherwise
   */
  has(name: string): boolean {
    const normalizedName = name.toLowerCase();
    const commandName = this.aliases.get(normalizedName) ?? normalizedName;
    return this.commands.has(commandName);
  }

  /**
   * Get all commands with optional source filter
   * 获取所有命令，可选按来源过滤
   *
   * @param source - Optional source filter
   * @returns Array of command information
   */
  getAll(source?: CommandSource): CommandInfo[] {
    const uniqueCommands = new Map<string, CommandInfo>();

    for (const [name, def] of this.commands) {
      // Apply source filter if provided
      if (source && def.source !== source) {
        continue;
      }

      // Only add if not already added (handles aliases)
      if (!uniqueCommands.has(name)) {
        uniqueCommands.set(name, {
          name: def.name,
          aliases: def.aliases,
          description: def.description,
          category: def.category,
          source: def.source ?? 'builtin',
          usage: def.usage,
          priority: def.priority,
          location: def.location,
          path: def.path,
          userInvocable: def.userInvocable,
          disableModelInvocation: def.disableModelInvocation,
          allowedTools: def.allowedTools,
          context: def.context,
          agent: def.agent,
          argumentHint: def.argumentHint,
          model: def.model,
        });
      }
    }

    // Convert to array and sort by name
    return Array.from(uniqueCommands.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  /**
   * Get commands by source
   * 按来源获取命令
   *
   * @param source - Command source
   * @returns Array of command information
   */
  getBySource(source: CommandSource): CommandInfo[] {
    return this.getAll(source);
  }

  /**
   * Get all command names
   * 获取所有命令名称
   *
   * @returns Array of command names
   */
  getNames(): string[] {
    return Array.from(this.commands.keys()).sort();
  }

  /**
   * Clear all commands
   * 清空所有命令
   */
  clear(): void {
    this.commands.clear();
    this.aliases.clear();
  }

  /**
   * Get command count
   * 获取命令数量
   *
   * @returns Number of registered commands
   */
  get size(): number {
    return this.commands.size;
  }

  /**
   * Get alias count
   * 获取别名数量
   *
   * @returns Number of registered aliases
   */
  get aliasCount(): number {
    return this.aliases.size;
  }
}

/**
 * Global command registry instance
 * 全局命令注册表实例
 *
 * @deprecated Use dependency injection instead of global instance
 */
export const globalCommandRegistry = new CommandRegistry();
