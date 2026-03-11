/**
 * Permission Utilities
 *
 * 权限工具函数 - 模式解析、匹配、路径检查
 *
 * Pattern format (ONLY for Bash tool in accept-edits mode):
 * - "Bash(npm install)" - exact command match
 * - "Bash(git commit:*)" - prefix wildcard match (matches "git commit -m 'msg'" etc.)
 * - "Bash(npm:*)" - command prefix wildcard (matches "npm install", "npm run build" etc.)
 *
 * Note: Bash(*) is REJECTED for safety. Use specific command patterns.
 */

import path from 'path';
import os from 'os';
import { PermissionMode, MODIFICATION_TOOLS, FILE_MODIFICATION_TOOLS, BASH_WRITE_COMMANDS, BASH_SAFE_READ_COMMANDS } from './types.js';

// ============== Pattern Parsing and Matching ==============

/**
 * Check if a bash command is strictly a safe read-only operation (Whitelist).
 * It must not contain shell operators that could bypass safety (|, >, <, &, ;, `, $(), \\).
 *
 * 检查一个 bash 命令是否是严格安全的只读操作（白名单）。
 * 必须不能包含可能绕过安全的 shell 操作符 (|, >, <, &, ;, `, $(), \\)。
 *
 * @param command - bash command string
 * @returns true if the command is a safe read operation
 */
export function isBashReadCommand(command: string): boolean {
  if (!command || !command.trim()) {
    return false;
  }
  const normalizedCommand = command.trim().toLowerCase();

  // 1. Strict syntax validation: Reject any command containing shell operators,
  // command substitution $() or line continuation \
  const illegalSyntax = /[<>|&;`\\]|\$\(/;
  if (illegalSyntax.test(command)) {
    return false;
  }

  // 2. Base command validation: Must start with a whitelisted command
  // e.g. "git status -s" starts with "git status"
  for (const safeCmd of BASH_SAFE_READ_COMMANDS) {
    if (normalizedCommand === safeCmd || normalizedCommand.startsWith(safeCmd + ' ')) {
      // Additional safety checks for specific tools
      if (safeCmd === 'sed') {
        const parts = normalizedCommand.split(/\s+/);
        // Catch -i, -i.bak, -i'', etc.
        if (parts.some(p => p.startsWith('-i') || p === '--in-place')) {
          return false; // Modifies file in-place
        }
      }

      if (safeCmd === 'awk') {
        const parts = normalizedCommand.split(/\s+/);
        // Block script execution from file which might have side effects
        if (parts.includes('-f') || parts.includes('--file')) {
          return false;
        }
      }
      
      // Block arbitrary code execution for language tools (version/info only)
      const languageTools = ['node', 'npm', 'yarn', 'pnpm', 'tsc', 'python', 'pip', 'go', 'cargo', 'rustc', 'ruby', 'perl'];
      if (languageTools.includes(safeCmd)) {
        const parts = normalizedCommand.split(/\s+/).slice(1); // skip the command itself
        // Only allow info flags like -v, --version, -h, --help
        // If there are any other arguments (like a script name or -e), require confirmation
        if (parts.length > 0 && !parts.every(p => /^(-v|--version|-h|--help)$/.test(p))) {
          return false;
        }
      }
      return true;
    }
  }

  return false; // Default to denying (requiring confirmation)
}

// Pre-compile regexes for BASH_WRITE_COMMANDS for performance
const BASH_WRITE_COMMAND_REGEXES = Array.from(BASH_WRITE_COMMANDS).map(writeCmd => {
  const escapedCmd = writeCmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[|&;><]\\s*)${escapedCmd}(\\s|$)`);
});

/**
 * Check if a bash command is a write operation
 * 检查 bash 命令是否是发布写操作的黑名单
 *
 * @param command - bash command string
 * @returns true if the command is a write operation
 */
export function isBashWriteCommand(command: string): boolean {
  if (!command || !command.trim()) {
    return false;
  }
  const normalizedCommand = command.trim().toLowerCase();

  for (const regex of BASH_WRITE_COMMAND_REGEXES) {
    if (regex.test(normalizedCommand)) {
      return true;
    }
  }

  return false;
}

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
  return { tool: entry.toLowerCase(), pattern: null };
}

/**
 * Check if a bash command matches an allowed pattern
 */
function matchesBashPattern(command: string, pattern: string): boolean {
  // Reject "*" pattern for safety
  if (pattern === '*') return false;

  // Prefix wildcard: "git commit:*" matches "git commit -m 'msg'"
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    return command.startsWith(prefix);
  }

  // Exact match
  return command === pattern;
}

/**
 * Check if a tool call is allowed by the patterns list
 *
 * Note: Only Bash tool is supported for pattern matching
 */
export function isToolCallAllowed(
  toolName: string,
  input: Record<string, unknown>,
  allowedPatterns: string[]
): boolean {
  if (toolName.toLowerCase() !== 'bash') {
    return false;
  }

  const command = (input.command as string) ?? '';

  for (const entry of allowedPatterns) {
    const parsed = parseAllowedToolPattern(entry);

    if (parsed.tool !== 'bash') continue;
    if (parsed.pattern === null) return true;

    if (matchesBashPattern(command, parsed.pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Generate pattern string for saving
 */
export function generateSavePattern(
  toolName: string,
  input: Record<string, unknown>,
  allowAll: boolean
): string {
  if (toolName.toLowerCase() !== 'bash') {
    return '';
  }

  const command = (input.command as string) ?? '';
  const parts = command.split(' ');

  if (parts.length > 1) {
    const baseCommand = parts.slice(0, 2).join(' ');
    return `Bash(${baseCommand}:*)`;
  }

  return `Bash(${command})`;
}

// ============== Path Checking ==============

/**
 * Check if target path requires always-confirm (permanent protection zones)
 *
 * Protected zones (always require confirmation):
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

    // .kodax/ project config directory
    if (normalizedPath.startsWith(projectKodaxDir + path.sep) || normalizedPath === projectKodaxDir) {
      return true;
    }

    // ~/.kodax/ user config directory
    if (normalizedPath.startsWith(userKodaxDir + path.sep) || normalizedPath === userKodaxDir) {
      return true;
    }

    // Paths outside project root
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
 * Extract potential file paths from a bash command
 * Issue 052: Used to check if bash command operates on protected paths
 */
export function extractPathsFromCommand(command: string): string[] {
  const paths: string[] = [];

  // Match quoted paths (single or double quotes)
  const quotedPattern = /["']([^"']+)["']/g;
  let match;
  while ((match = quotedPattern.exec(command)) !== null) {
    paths.push(match[1]!);
  }

  // Match common path patterns:
  // - Relative paths starting with . or ..
  // - Paths containing slashes
  // - Windows absolute paths (C:\, D:\, etc.)
  const pathPattern = /(?:^|\s)(\.\.?\/[^\s]+|\.\.?\\[^\s]+|[a-zA-Z]:\\[^\s]+|~\/[^\s]+|\.[^\s]*[/\\][^\s]*)/g;
  while ((match = pathPattern.exec(command)) !== null) {
    paths.push(match[1]!);
  }

  return paths;
}

/**
 * Check if a bash command operates on any protected paths
 * Issue 052: Prevent "always" option for bash commands on protected paths
 */
export function isCommandOnProtectedPath(command: string, projectRoot: string): boolean {
  const paths = extractPathsFromCommand(command);
  for (const p of paths) {
    if (isAlwaysConfirmPath(p, projectRoot)) {
      return true;
    }
  }
  return false;
}

// ============== Mode Inference ==============

/**
 * Infer PermissionMode from legacy options (backward compat)
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

// Re-export constants for convenience
export { MODIFICATION_TOOLS, FILE_MODIFICATION_TOOLS } from './types.js';
