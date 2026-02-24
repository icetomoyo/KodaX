/**
 * KodaX 自动补全模块
 *
 * 提供文件路径和命令的 Tab 补全功能
 */

import * as fs from 'fs';
import * as path from 'path';
import type * as readline from 'readline';
import { BUILTIN_COMMANDS } from './commands.js';

/**
 * 补全项
 */
export interface Completion {
  text: string;                // 补全文本
  display: string;             // 显示文本
  description?: string;        // 描述
  type: 'file' | 'command' | 'argument';
}

/**
 * 补全器接口
 */
export interface Completer {
  canComplete(input: string, cursorPos: number): boolean;
  getCompletions(input: string, cursorPos: number): Promise<Completion[]>;
}

/**
 * 文件路径补全器
 *
 * 触发条件: 输入中包含 @ 后跟文件路径
 * 例如: @src/u -> Tab 补全为 @src/utils/
 */
export class FileCompleter implements Completer {
  private cwd: string;
  private cache: Map<string, string[]> = new Map();
  private cacheTimeout = 5000; // 5 秒缓存

  constructor(cwd?: string) {
    this.cwd = cwd ?? process.cwd();
  }

  canComplete(input: string, cursorPos: number): boolean {
    // 检查光标前是否有 @ 符号
    const beforeCursor = input.slice(0, cursorPos);
    const lastAtIndex = beforeCursor.lastIndexOf('@');
    if (lastAtIndex === -1) return false;

    // 检查 @ 后是否是有效的文件路径开始
    const afterAt = beforeCursor.slice(lastAtIndex + 1);
    // 不允许空格（意味着 @ 后是新词）
    if (afterAt.includes(' ')) return false;

    return true;
  }

  async getCompletions(input: string, cursorPos: number): Promise<Completion[]> {
    const beforeCursor = input.slice(0, cursorPos);
    const lastAtIndex = beforeCursor.lastIndexOf('@');
    if (lastAtIndex === -1) return [];

    const afterAt = beforeCursor.slice(lastAtIndex + 1);
    const completions: Completion[] = [];

    // 解析路径
    const lastSlash = afterAt.lastIndexOf('/');
    const dir = lastSlash === -1 ? this.cwd : path.join(this.cwd, afterAt.slice(0, lastSlash));
    const prefix = lastSlash === -1 ? afterAt : afterAt.slice(lastSlash + 1);

    try {
      const entries = await this.readdir(dir);
      const matches = entries.filter(e => e.toLowerCase().startsWith(prefix.toLowerCase()));

      for (const match of matches) {
        const fullPath = path.join(dir, match);
        const isDir = await this.isDirectory(fullPath);
        const replacement = lastSlash === -1 ? match : afterAt.slice(0, lastSlash + 1) + match;

        completions.push({
          text: '@' + replacement + (isDir ? '/' : ''),
          display: match + (isDir ? '/' : ''),
          description: isDir ? 'directory' : 'file',
          type: 'file',
        });
      }
    } catch {
      // 目录不存在或无法读取
    }

    return completions;
  }

  private async readdir(dir: string): Promise<string[]> {
    const cached = this.cache.get(dir);
    if (cached) return cached;

    return new Promise((resolve) => {
      fs.readdir(dir, (err, entries) => {
        if (err) {
          resolve([]);
        } else {
          this.cache.set(dir, entries);
          setTimeout(() => this.cache.delete(dir), this.cacheTimeout);
          resolve(entries);
        }
      });
    });
  }

  private async isDirectory(fullPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      fs.stat(fullPath, (err, stats) => {
        resolve(!err && stats.isDirectory());
      });
    });
  }
}

/**
 * 命令补全器
 *
 * 触发条件: 输入以 / 开头
 * 例如: /h -> Tab 补全为 /help
 */
export class CommandCompleter implements Completer {
  private commands: Map<string, { description: string; aliases: string[] }>;

  constructor() {
    this.commands = new Map();
    this.loadCommands();
  }

  private loadCommands(): void {
    // 从 BUILTIN_COMMANDS 加载命令
    for (const cmd of BUILTIN_COMMANDS) {
      this.commands.set(cmd.name, {
        description: cmd.description,
        aliases: cmd.aliases ?? [],
      });
    }
  }

  canComplete(input: string, cursorPos: number): boolean {
    // 必须以 / 开头且光标在命令部分
    if (!input.startsWith('/')) return false;
    // 光标必须在第一个空格之前
    const beforeCursor = input.slice(0, cursorPos);
    return !beforeCursor.includes(' ');
  }

  async getCompletions(input: string, cursorPos: number): Promise<Completion[]> {
    if (!input.startsWith('/')) return [];

    const beforeCursor = input.slice(0, cursorPos);
    const partial = beforeCursor.slice(1).toLowerCase(); // 移除 /
    const completions: Completion[] = [];

    for (const [name, info] of this.commands) {
      if (name.startsWith(partial)) {
        completions.push({
          text: '/' + name,
          display: '/' + name,
          description: info.description,
          type: 'command',
        });
      }

      // 也匹配别名
      for (const alias of info.aliases) {
        if (alias.startsWith(partial) && alias !== name) {
          completions.push({
            text: '/' + alias,
            display: '/' + alias,
            description: `Alias for /${name}: ${info.description}`,
            type: 'command',
          });
        }
      }
    }

    return completions;
  }
}

/**
 * readline 补全函数
 *
 * 与 Node.js readline 的 completer 接口兼容
 */
export function createCompleter(cwd?: string): (line: string) => Promise<[string[], string]> {
  const fileCompleter = new FileCompleter(cwd);
  const commandCompleter = new CommandCompleter();

  return async (line: string): Promise<[string[], string]> => {
    // 检查是否需要补全
    const hasAt = line.includes('@');
    const hasSlash = line.startsWith('/');

    if (!hasAt && !hasSlash) {
      return [[], line];
    }

    const allCompletions: Completion[] = [];

    if (hasSlash && commandCompleter.canComplete(line, line.length)) {
      const completions = await commandCompleter.getCompletions(line, line.length);
      allCompletions.push(...completions);
    }

    if (hasAt && fileCompleter.canComplete(line, line.length)) {
      const completions = await fileCompleter.getCompletions(line, line.length);
      allCompletions.push(...completions);
    }

    // 格式化为 readline 需要的格式
    // 返回 [[completions], originalLine]
    const displays = allCompletions.map(c => c.display);
    return [displays, line];
  };
}

/**
 * 显示补全列表
 */
export function displayCompletions(completions: Completion[]): void {
  if (completions.length === 0) return;

  // 单个补全：直接替换
  if (completions.length === 1) {
    return;
  }

  // 多个补全：显示列表
  console.log();
  const maxDisplay = Math.min(completions.length, 10);

  for (let i = 0; i < maxDisplay; i++) {
    const c = completions[i];
    if (!c) continue;
    const typeIcon = c.type === 'file' ? '📄' : (c.type === 'command' ? '⚡' : '•');
    let line = `  ${typeIcon} ${c.display}`;
    if (c.description) {
      line += ` - ${c.description}`;
    }
    console.log(line);
  }

  if (completions.length > maxDisplay) {
    console.log(`  ... and ${completions.length - maxDisplay} more`);
  }
  console.log();
}

/**
 * 获取补全建议 (用于 UI 显示)
 */
export async function getCompletionSuggestions(
  input: string,
  cursorPos: number,
  cwd?: string
): Promise<Completion[]> {
  const fileCompleter = new FileCompleter(cwd);
  const commandCompleter = new CommandCompleter();

  const results: Completion[] = [];

  if (commandCompleter.canComplete(input, cursorPos)) {
    results.push(...await commandCompleter.getCompletions(input, cursorPos));
  }

  if (fileCompleter.canComplete(input, cursorPos)) {
    results.push(...await fileCompleter.getCompletions(input, cursorPos));
  }

  return results;
}
