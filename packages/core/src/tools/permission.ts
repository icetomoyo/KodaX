/**
 * Permission System - Core permission computation utilities - 权限系统核心工具函数
 */

import path from 'path';
import os from 'os';
import { PermissionMode } from '../types.js';

// Modification tools that are blocked in plan mode - plan 模式下被阻止的修改工具
export const MODIFICATION_TOOLS = new Set(['write', 'edit', 'bash', 'undo']);

// Write/edit tools (file modification, not commands) - 文件修改工具（不包括命令）
export const FILE_MODIFICATION_TOOLS = new Set(['write', 'edit']);

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
