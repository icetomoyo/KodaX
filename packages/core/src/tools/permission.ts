/**
 * Permission System - Core permission computation utilities - 权限系统核心工具函数
 *
 * Pattern format (ONLY for Bash tool in accept-edits mode):
 * - "Bash(npm install)" - exact command match
 * - "Bash(git commit:*)" - prefix wildcard match (matches "git commit -m 'msg'" etc.)
 * - "Bash(npm:*)" - command prefix wildcard (matches "npm install", "npm run build" etc.)
 *
 * Note: Bash(*) is REJECTED for safety. Use specific command patterns.
 * Note: Other tools don't need pattern support:
 * - Read/Glob/Grep: Always allowed (project-external access is enforced confirmation)
 * - Edit/Write: Auto-allowed in accept-edits mode, always-ask in default mode
 */

import path from 'path';
import os from 'os';
import { PermissionMode } from '../types.js';

// Modification tools that are blocked in plan mode - plan 模式下被阻止的修改工具
export const MODIFICATION_TOOLS = new Set(['write', 'edit', 'bash', 'undo']);

// Write/edit tools (file modification, not commands) - 文件修改工具（不包括命令）
export const FILE_MODIFICATION_TOOLS = new Set(['write', 'edit']);

// ============== Pattern Parsing and Matching - 模式解析与匹配 ==============

/**
 * Parse allowed tool pattern - 解析允许的工具模式
 *
 * Formats:
 * - "read" -> { tool: "read", pattern: null }
 * - "Edit(*)" -> { tool: "Edit", pattern: "*" }
 * - "Bash(npm install)" -> { tool: "Bash", pattern: "npm install" }
 * - "Bash(git commit:*)" -> { tool: "Bash", pattern: "git commit:*" }
 */
export function parseAllowedToolPattern(entry: string): { tool: string; pattern: string | null } {
  const match = entry.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\((.+)\)$/);
  if (match) {
    return { tool: match[1].toLowerCase(), pattern: match[2] };
  }
  // Simple tool name without pattern - 无模式的简单工具名
  return { tool: entry.toLowerCase(), pattern: null };
}

/**
 * Check if a bash command matches an allowed pattern - 检查 bash 命令是否匹配允许的模式
 *
 * Note: We reject "*" pattern for safety. Use specific patterns like "git:*" or "npm:*"
 *
 * @param command - The bash command to check
 * @param pattern - Pattern from config (e.g., "npm install", "git commit:*")
 */
function matchesBashPattern(command: string, pattern: string): boolean {
  // Reject "*" pattern for safety - 拒绝 "*" 模式以确保安全
  // If user wants all bash auto-allowed, use 'auto-in-project' mode instead
  if (pattern === '*') return false;

  // Prefix wildcard: "git commit:*" matches "git commit -m 'msg'"
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2); // Remove ":*"
    return command.startsWith(prefix);
  }

  // Exact match - 精确匹配
  return command === pattern;
}

/**
 * Check if a tool call is allowed by the patterns list - 检查工具调用是否被模式列表允许
 *
 * Note: Only Bash tool is supported. Other tools don't need pattern matching:
 * - Read/Glob/Grep: Always allowed for in-project, enforced confirmation for out-of-project
 * - Edit/Write: Mode-based (auto in accept-edits, ask in default)
 *
 * @param toolName - Tool name (only "bash" is meaningful)
 * @param input - Tool input (contains command for bash)
 * @param allowedPatterns - List of allowed patterns from config
 */
export function isToolCallAllowed(
  toolName: string,
  input: Record<string, unknown>,
  allowedPatterns: string[]
): boolean {
  // Only bash tool supports pattern matching - 只有 bash 工具支持模式匹配
  if (toolName.toLowerCase() !== 'bash') {
    return false;
  }

  const command = (input.command as string) ?? '';

  for (const entry of allowedPatterns) {
    const parsed = parseAllowedToolPattern(entry);

    // Tool name must match (case-insensitive) - 工具名必须匹配（不区分大小写）
    if (parsed.tool !== 'bash') continue;

    // No pattern means allow all bash commands - 无模式表示允许所有 bash 命令
    if (parsed.pattern === null) return true;

    // Check if command matches the pattern - 检查命令是否匹配模式
    if (matchesBashPattern(command, parsed.pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Generate pattern string for saving - 生成用于保存的模式字符串
 *
 * Note: Only Bash tool patterns are supported. We NEVER generate Bash(*) as it's too dangerous.
 *
 * @param toolName - Tool name (only "bash" generates meaningful patterns)
 * @param input - Tool input (contains command for bash)
 * @param allowAll - Ignored for bash (we always generate specific patterns for safety)
 */
export function generateSavePattern(
  toolName: string,
  input: Record<string, unknown>,
  allowAll: boolean
): string {
  // Only bash tool generates meaningful patterns - 只有 bash 生成有意义的模式
  if (toolName.toLowerCase() !== 'bash') {
    return '';  // Return empty string for non-bash tools (won't be saved)
  }

  // We ignore allowAll for bash - always generate specific patterns for safety
  // 忽略 allowAll 参数，始终生成具体的命令模式以确保安全
  // If user wants all bash auto-allowed, they should use 'auto-in-project' mode instead
  // 如果用户想要所有 bash 自动允许，应该使用 'auto-in-project' 模式

  const command = (input.command as string) ?? '';
  const parts = command.split(' ');

  if (parts.length > 1) {
    // Has arguments: use prefix wildcard with base command - 有参数：使用前缀通配符
    // e.g., "git commit -m 'msg'" -> "Bash(git commit:*)"
    // e.g., "npm install package" -> "Bash(npm install:*)"
    const baseCommand = parts.slice(0, 2).join(' ');
    return `Bash(${baseCommand}:*)`;
  }

  // Single command without args: exact match - 无参数的单一命令：精确匹配
  // e.g., "npm" -> "Bash(npm)"
  return `Bash(${command})`;
}

// ============== Permission Mode Computation - 权限模式计算 ==============

/**
 * Compute confirmTools set from permission mode - 根据权限模式计算 confirmTools
 *
 * | Mode             | confirmTools             |
 * |------------------|--------------------------|
 * | plan             | all modification tools   |
 * | default          | bash + write + edit      |
 * | accept-edits     | bash only                |
 * | auto-in-project  | empty (project-level guard applies) |
 */
export function computeConfirmTools(mode: PermissionMode): Set<string> {
  switch (mode) {
    case 'plan':
      return new Set(['bash', 'write', 'edit', 'undo']);
    case 'default':
      return new Set(['bash', 'write', 'edit']);
    case 'accept-edits':
      return new Set(['bash']);
    case 'auto-in-project':
      return new Set();
  }
}

/**
 * Check if target path requires always-confirm (permanent protection zones) - 判断路径是否属于永久保护区域
 *
 * Protected zones (always require confirmation, Y-always not shown):
 * - .kodax/ project config directory
 * - ~/.kodax/ user config directory
 * - Paths outside the project root
 */
export function isAlwaysConfirmPath(targetPath: string, projectRoot: string): boolean {
  try {
    const normalizedPath = path.resolve(targetPath);
    const normalizedRoot = path.resolve(projectRoot);
    const userKodaxDir = path.join(os.homedir(), '.kodax');
    const projectKodaxDir = path.join(normalizedRoot, '.kodax');

    // .kodax/ project config directory - 项目配置目录
    if (normalizedPath.startsWith(projectKodaxDir + path.sep) || normalizedPath === projectKodaxDir) {
      return true;
    }

    // ~/.kodax/ user config directory - 用户配置目录
    if (normalizedPath.startsWith(userKodaxDir + path.sep) || normalizedPath === userKodaxDir) {
      return true;
    }

    // Paths outside project root - 项目外路径
    const lowerPath = normalizedPath.toLowerCase();
    const lowerRoot = normalizedRoot.toLowerCase();
    if (lowerPath !== lowerRoot && !lowerPath.startsWith(lowerRoot + path.sep.toLowerCase())) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Infer PermissionMode from legacy options (backward compat) - 从旧版选项推断权限模式（向后兼容）
 */
export function inferPermissionMode(opts: {
  auto?: boolean;
  mode?: 'code' | 'ask';
  confirmTools?: Set<string>;
}): PermissionMode {
  if (opts.mode === 'ask') return 'plan';
  if (opts.auto) return 'auto-in-project';
  if (opts.confirmTools && opts.confirmTools.size === 0) return 'auto-in-project';
  if (opts.confirmTools && !opts.confirmTools.has('write') && !opts.confirmTools.has('edit')) {
    return 'accept-edits';
  }
  return 'default';
}
