/**
 * Argument Completer - 参数补全器
 *
 * Provides autocomplete for command arguments based on command definitions.
 * 基于命令定义为命令参数提供自动补全。
 *
 * Trigger: After a command name with space (e.g., /mode <cursor>)
 * 触发条件: 命令名称后跟空格（如 /mode <光标>）
 *
 * Example: /mode ac -> suggests accept-edits, auto
 */

import type { Completer, Completion } from '../autocomplete.js';
import { findCommandSlashIndex } from '../autocomplete.js';
import { getCommandArguments } from './command-arguments.js';

// FEATURE_093 (v0.7.24): type declarations moved to `./types.ts` so
// `command-arguments.ts` can consume them without a back-edge to this file.
// Re-exported here for backward compatibility with existing consumers.
export type { ArgumentDefinition, CommandArgumentsRegistry } from './types.js';
import type { ArgumentDefinition, CommandArgumentsRegistry } from './types.js';
import type { CommandCallbacks, CurrentConfig } from '../../commands/types.js';

export interface HostArgumentSource {
  catalog: NonNullable<CommandCallbacks['catalog']>;
  selection: () => Pick<CurrentConfig, 'provider' | 'model'>;
}

async function hostSettingArguments(
  source: HostArgumentSource, command: string, partial: string,
): Promise<ArgumentDefinition[] | undefined> {
  if (['effort', 'thinking', 'think', 't', 'reasoning', 'reason'].includes(command)) {
    return (await source.catalog.reasoningEfforts(source.selection())).map(effort => ({
      name: effort === 'off' ? 'none' : effort, description: 'Host reasoning effort', type: 'enum',
    }));
  }
  if (!['model', 'm'].includes(command)) return undefined;
  const providers = await source.catalog.providers();
  const slash = partial.indexOf('/');
  if (slash < 0) return providers.map(provider => ({ name: provider.name, description: `Switch to ${provider.name} provider`, type: 'enum' }));
  const name = partial.slice(0, slash) || source.selection().provider;
  return (providers.find(provider => provider.name === name)?.models ?? [])
    .filter(model => model.toLowerCase().includes(partial.slice(slash + 1).toLowerCase()))
    .map(model => ({ name: `${partial.slice(0, slash)}/${model}`, description: model, type: 'enum' }));
}

/**
 * Argument Completer implementation
 * 参数补全器实现
 */
export class ArgumentCompleter implements Completer {
  constructor(private readonly hostSource?: () => HostArgumentSource | undefined) {}
  /**
   * Check if this completer can handle the current input
   * 检查此补全器是否能处理当前输入
   */
  canComplete(input: string, cursorPos: number): boolean {
    const beforeCursor = input.slice(0, cursorPos);

    // Find the last valid command prefix slash to support mid-line commands
    // and arguments containing slashes (e.g., /model anthropic/cl)
    // 找到最后一个有效的命令前缀斜杠，支持行中命令和包含斜杠的参数
    const lastSlashIndex = findCommandSlashIndex(beforeCursor);
    if (lastSlashIndex === -1) return false;

    const afterSlash = beforeCursor.slice(lastSlashIndex);

    // Check if we're in argument position (after command + space)
    // 检查是否在参数位置（命令 + 空格之后）
    const parts = afterSlash.split(/\s+/);
    if (parts.length >= 2 && parts[0] !== '') {
      return true;
    }

    const commandName = afterSlash.slice(1).toLowerCase();
    return getCommandArguments(commandName).length > 0;
  }

  /**
   * Get completion suggestions for the current input
   * 获取当前输入的补全建议
   */
  async getCompletions(input: string, cursorPos: number): Promise<Completion[]> {
    const beforeCursor = input.slice(0, cursorPos);

    // Find the last valid command prefix slash
    // 找到最后一个有效的命令前缀斜杠
    const lastSlashIndex = findCommandSlashIndex(beforeCursor);
    if (lastSlashIndex === -1) return [];

    const afterSlash = beforeCursor.slice(lastSlashIndex);

    // Parse command and partial argument
    // 解析命令和部分参数
    const firstSpace = afterSlash.indexOf(' ');
    const commandName = (firstSpace === -1
      ? afterSlash.slice(1)
      : afterSlash.slice(1, firstSpace)).toLowerCase();
    const afterCommand = firstSpace === -1 ? '' : afterSlash.slice(firstSpace + 1);

    // Determine which argument position we're at
    // 确定当前在哪个参数位置
    const argParts = afterCommand ? afterCommand.split(/\s+/) : [''];
    const argIndex = argParts.length - 1;
    const currentPartial = argParts[argIndex] ?? '';
    const normalizedPartial = currentPartial.toLowerCase();

    // Get argument definitions for this command
    // 获取此命令的参数定义
    const host = this.hostSource?.();
    const argumentDefs = (host ? await hostSettingArguments(host, commandName, currentPartial) : undefined)
      ?? getCommandArguments(commandName, currentPartial, argParts);
    if (!argumentDefs || argumentDefs.length === 0) {
      return [];
    }

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
    // Skip redundant filter for two-stage provider/model completions —
    // getModelArgs already filtered by the model partial, and the full
    // currentPartial (e.g. "anthropic/ha") is not a substring of the
    // full arg name (e.g. "anthropic/claude-haiku-4-5").
    return availableArgs
      .filter((arg) => {
        if (!normalizedPartial) return true;
        if (arg.name.includes('/')) return true;
        return arg.name.toLowerCase().includes(normalizedPartial);
      })
      .map((arg) => ({
        text: arg.name,
        display: arg.name,
        description: arg.description,
        type: 'argument' as const,
      }))
      .sort((a, b) => {
        // No partial typed yet: preserve the declared argument order instead of
        // collapsing to a length sort (every name startsWith('') so the prefix
        // branches below would no-op and reorder by length, pushing entries like
        // `rerun` out of a predictable position). Stable sort keeps input order.
        if (!normalizedPartial) return 0;
        // Prefix matches first - 前缀匹配优先
        const aIsPrefix = a.display.toLowerCase().startsWith(normalizedPartial);
        const bIsPrefix = b.display.toLowerCase().startsWith(normalizedPartial);
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
