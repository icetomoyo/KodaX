/**
 * Argument Completer - 参数补全器
 *
 * Provides autocomplete for command arguments based on command definitions.
 * 基于命令定义为命令参数提供自动补全。
 *
 * Trigger: After a command name with space (e.g., /mode <cursor>)
 * 触发条件: 命令名称后跟空格（如 /mode <光标>）
 *
 * Example: /mode ac -> suggests accept-edits, auto-in-project
 */

import type { Completer, Completion } from '../autocomplete.js';
import { COMMAND_ARGUMENTS } from './command-arguments.js';

/**
 * Argument definition for autocomplete
 * 用于自动补全的参数定义
 */
export interface ArgumentDefinition {
  /** Argument name/value - 参数名称/值 */
  name: string;
  /** Description for display - 显示描述 */
  description: string;
  /** Argument type - 参数类型 */
  type?: 'string' | 'number' | 'boolean' | 'enum';
  /** Whether this argument is required - 是否必需 */
  required?: boolean;
}

/**
 * Command arguments registry type
 * 命令参数注册表类型
 */
export type CommandArgumentsRegistry = Map<string, ArgumentDefinition[]>;

/**
 * Argument Completer implementation
 * 参数补全器实现
 */
export class ArgumentCompleter implements Completer {
  /**
   * Check if this completer can handle the current input
   * 检查此补全器是否能处理当前输入
   */
  canComplete(input: string, cursorPos: number): boolean {
    const beforeCursor = input.slice(0, cursorPos);

    // Find the last / to support mid-line commands
    // 找到最后一个 / 以支持行中命令
    const lastSlashIndex = beforeCursor.lastIndexOf('/');
    if (lastSlashIndex === -1) return false;

    const afterSlash = beforeCursor.slice(lastSlashIndex);

    // Check if we're in argument position (after command + space)
    // 检查是否在参数位置（命令 + 空格之后）
    const parts = afterSlash.split(/\s+/);
    return parts.length >= 2 && parts[0] !== '';
  }

  /**
   * Get completion suggestions for the current input
   * 获取当前输入的补全建议
   */
  async getCompletions(input: string, cursorPos: number): Promise<Completion[]> {
    const beforeCursor = input.slice(0, cursorPos);

    // Find the last / to support mid-line commands
    // 找到最后一个 / 以支持行中命令
    const lastSlashIndex = beforeCursor.lastIndexOf('/');
    if (lastSlashIndex === -1) return [];

    const afterSlash = beforeCursor.slice(lastSlashIndex);

    // Parse command and partial argument
    // 解析命令和部分参数
    const firstSpace = afterSlash.indexOf(' ');
    if (firstSpace === -1) return [];

    const commandName = afterSlash.slice(1, firstSpace).toLowerCase();
    const afterCommand = afterSlash.slice(firstSpace + 1);

    // Get argument definitions for this command
    // 获取此命令的参数定义
    const argumentDefs = COMMAND_ARGUMENTS.get(commandName);
    if (!argumentDefs || argumentDefs.length === 0) {
      return [];
    }

    // Determine which argument position we're at
    // 确定当前在哪个参数位置
    const argParts = afterCommand.split(/\s+/);
    const argIndex = argParts.length - 1;
    const currentPartial = (argParts[argIndex] ?? '').toLowerCase();

    // Get arguments that haven't been used yet
    // 获取尚未使用的参数
    const usedArgs = new Set(
      argParts.slice(0, -1).map((p) => p.toLowerCase())
    );

    const availableArgs = argumentDefs.filter(
      (arg) => !usedArgs.has(arg.name.toLowerCase())
    );

    // Filter by current partial input
    // 通过当前部分输入过滤
    return availableArgs
      .filter((arg) => {
        if (!currentPartial) return true;
        return arg.name.toLowerCase().includes(currentPartial);
      })
      .map((arg) => ({
        text: arg.name,
        display: arg.name,
        description: arg.description,
        type: 'argument' as const,
      }))
      .sort((a, b) => {
        // Prefix matches first - 前缀匹配优先
        const aIsPrefix = a.display.toLowerCase().startsWith(currentPartial);
        const bIsPrefix = b.display.toLowerCase().startsWith(currentPartial);
        if (aIsPrefix && !bIsPrefix) return -1;
        if (!aIsPrefix && bIsPrefix) return 1;
        return a.display.length - b.display.length;
      });
  }
}

/**
 * Create an argument completer instance
 * 创建参数补全器实例
 */
export function createArgumentCompleter(): ArgumentCompleter {
  return new ArgumentCompleter();
}
