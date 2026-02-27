/**
 * Permission System - Core permission computation utilities - 权限系统核心工具函数
 *
 * Pattern format (inspired by Claude Code):
 * - "read" - simple tool name (for read-only tools)
 * - "Edit(*)" - allow all edit operations
 * - "Bash(npm install)" - exact command match
 * - "Bash(git commit:*)" - prefix wildcard match
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
 * Check if a tool call matches an allowed pattern - 检查工具调用是否匹配允许的模式
 *
 * @param toolName - Tool name (e.g., "bash", "edit")
 * @param input - Tool input (contains command for bash, path for edit/write)
 * @param pattern - Pattern from config (e.g., "npm install", "git commit:*", "*")
 */
export function matchesAllowedPattern(
  toolName: string,
  input: Record<string, unknown>,
  pattern: string | null
): boolean {
  // No pattern means allow all for this tool - 无模式表示允许该工具的所有操作
  if (pattern === null) return true;

  // Wildcard means allow all - 通配符表示允许所有
  if (pattern === '*') return true;

  // For bash: match against command - bash 工具：匹配命令
  if (toolName === 'bash') {
    const command = (input.command as string) ?? '';
    // Prefix wildcard: "git commit:*" matches "git commit -m 'msg'"
    if (pattern.endsWith(':*')) {
      const prefix = pattern.slice(0, -2); // Remove ":*"
      return command.startsWith(prefix);
    }
    // Exact match - 精确匹配
    return command === pattern;
  }

  // For edit/write: could match against path in future - edit/write：未来可匹配路径
  // For now, pattern "*" means all, anything else is not supported yet
  // 目前只支持 "*" 表示全部，其他模式暂不支持
  return pattern === '*';
}

/**
 * Check if a tool call is allowed by the patterns list - 检查工具调用是否被模式列表允许
 *
 * @param toolName - Tool name
 * @param input - Tool input
 * @param allowedPatterns - List of allowed patterns from config
 */
export function isToolCallAllowed(
  toolName: string,
  input: Record<string, unknown>,
  allowedPatterns: string[]
): boolean {
  const lowerToolName = toolName.toLowerCase();

  for (const entry of allowedPatterns) {
    const parsed = parseAllowedToolPattern(entry);

    // Tool name must match (case-insensitive) - 工具名必须匹配（不区分大小写）
    if (parsed.tool !== lowerToolName) continue;

    // Check if input matches the pattern - 检查输入是否匹配模式
    if (matchesAllowedPattern(toolName, input, parsed.pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Generate pattern string for saving - 生成用于保存的模式字符串
 *
 * @param toolName - Tool name
 * @param input - Tool input (to extract command/path for specific pattern)
 * @param allowAll - If true, save "Tool(*)"; if false, save specific pattern
 */
export function generateSavePattern(
  toolName: string,
  input: Record<string, unknown>,
  allowAll: boolean
): string {
  const lowerToolName = toolName.toLowerCase();

  // Read-only tools: save simple name - 只读工具：保存简单名称
  if (lowerToolName === 'read' || lowerToolName === 'glob' || lowerToolName === 'grep') {
    return lowerToolName;
  }

  // If allowAll, save Tool(*) - 如果允许全部，保存 Tool(*)
  if (allowAll) {
    return `${toolName.charAt(0).toUpperCase() + toolName.slice(1)}(*)`;
  }

  // For bash: save specific command pattern - bash：保存特定命令模式
  if (lowerToolName === 'bash') {
    const command = (input.command as string) ?? '';
    // Extract base command for pattern - 提取基础命令作为模式
    // e.g., "npm install" -> "Bash(npm install)"
    // e.g., "git commit -m 'msg'" -> "Bash(git commit:*)"
    const parts = command.split(' ');
    if (parts.length > 1) {
      // Has arguments: use prefix wildcard with base command - 有参数：使用前缀通配符
      const baseCommand = parts.slice(0, 2).join(' ');
      return `Bash(${baseCommand}:*)`;
    }
    // No arguments: exact match - 无参数：精确匹配
    return `Bash(${command})`;
  }

  // For edit/write: save Tool(*) for now - edit/write：目前保存 Tool(*)
  return `${toolName.charAt(0).toUpperCase() + toolName.slice(1)}(*)`;
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
