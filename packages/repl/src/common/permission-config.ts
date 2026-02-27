/**
 * Permission Config - 2-level permission configuration load/save
 *
 * Priority: project-level (.kodax/config.local.json) > user-level (~/.kodax/config.json)
 * 优先级：项目级 (.kodax/config.local.json) > 用户级 (~/.kodax/config.json)
 *
 * Pattern format (ONLY for Bash tool in accept-edits mode):
 * - "Bash(npm install)" - exact command match
 * - "Bash(git commit:*)" - prefix wildcard (matches "git commit -m 'msg'" etc.)
 * - "Bash(npm:*)" - command prefix wildcard (matches "npm install", "npm run" etc.)
 *
 * Note: Bash(*) is REJECTED for safety. Use specific command patterns.
 * Note: Other tools don't need patterns:
 * - Read/Glob/Grep: Always allowed (project-external is enforced confirmation)
 * - Edit/Write: Auto-allowed in accept-edits, always-ask in default
 */

import fsSync from 'fs';
import path from 'path';
import os from 'os';
import {
  PermissionMode,
  parseAllowedToolPattern,
  isToolCallAllowed,
  generateSavePattern,
} from '@kodax/core';

// Re-export for convenience - 重新导出便于使用
export { parseAllowedToolPattern, isToolCallAllowed, generateSavePattern };

// User-level config: ~/.kodax/config.json
const USER_CONFIG_FILE = path.join(os.homedir(), '.kodax', 'config.json');

// Project-level config: .kodax/config.local.json (in current working directory)
function getProjectConfigFile(): string {
  return path.join(process.cwd(), '.kodax', 'config.local.json');
}

interface PermissionConfigData {
  permissionMode?: PermissionMode;
  alwaysAllowTools?: string[];
}

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    if (fsSync.existsSync(filePath)) {
      return JSON.parse(fsSync.readFileSync(filePath, 'utf-8'));
    }
  } catch { }
  return {};
}

function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  fsSync.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ============== Config Load/Save - 配置加载/保存 ==============

/**
 * Load effective permission mode (project-level overrides user-level)
 * 加载有效权限模式（项目级覆盖用户级）
 */
export function loadPermissionMode(): PermissionMode | undefined {
  // Project-level config takes priority
  const projectConfig = readJsonFile(getProjectConfigFile()) as PermissionConfigData;
  if (projectConfig.permissionMode) return projectConfig.permissionMode;

  // Fall back to user-level config
  const userConfig = readJsonFile(USER_CONFIG_FILE) as PermissionConfigData;
  return userConfig.permissionMode;
}

/**
 * Save permission mode to user-level config (~/.kodax/config.json)
 * 保存权限模式到用户级配置
 */
export function savePermissionModeUser(mode: PermissionMode): void {
  const current = readJsonFile(USER_CONFIG_FILE);
  writeJsonFile(USER_CONFIG_FILE, { ...current, permissionMode: mode });
}

/**
 * Save permission mode to project-level config (.kodax/config.local.json)
 * 保存权限模式到项目级配置
 */
export function savePermissionModeProject(mode: PermissionMode): void {
  const projectConfigFile = getProjectConfigFile();
  const current = readJsonFile(projectConfigFile);
  writeJsonFile(projectConfigFile, { ...current, permissionMode: mode });
}

/**
 * Load always-allow tools list (project-level merged with user-level)
 * 加载总是允许的工具列表（项目级与用户级合并）
 */
export function loadAlwaysAllowTools(): string[] {
  const userConfig = readJsonFile(USER_CONFIG_FILE) as PermissionConfigData;
  const projectConfig = readJsonFile(getProjectConfigFile()) as PermissionConfigData;

  // Merge both lists (project-level additions) - 合并两个列表（项目级补充）
  const userTools = userConfig.alwaysAllowTools ?? [];
  const projectTools = projectConfig.alwaysAllowTools ?? [];

  return [...new Set([...userTools, ...projectTools])];
}

/**
 * Save a tool pattern to the always-allow list (project-level config)
 * 保存工具模式到总是允许列表（项目级配置）
 *
 * Note: Only Bash patterns are meaningful. Non-bash tools return empty pattern and won't be saved.
 *
 * @param toolName - Tool name (only "bash" generates meaningful patterns)
 * @param input - Tool input (used to generate specific pattern)
 * @param allowAll - If true, save Bash(*) ; if false, save specific command pattern
 */
export function saveAlwaysAllowToolPattern(
  toolName: string,
  input: Record<string, unknown>,
  allowAll: boolean = false
): void {
  const pattern = generateSavePattern(toolName, input, allowAll);

  // Skip if empty pattern (non-bash tools) - 跳过空模式（非 bash 工具）
  if (!pattern) return;

  const projectConfigFile = getProjectConfigFile();
  const current = readJsonFile(projectConfigFile) as PermissionConfigData;
  const existingPatterns = current.alwaysAllowTools ?? [];

  if (!existingPatterns.includes(pattern)) {
    writeJsonFile(projectConfigFile, {
      ...current,
      alwaysAllowTools: [...existingPatterns, pattern]
    });
  }
}

/**
 * Legacy function for backward compat - kept for old code
 * 旧版兼容函数 - 保留给旧代码使用
 * @deprecated Use saveAlwaysAllowToolPattern instead
 */
export function saveAlwaysAllowTool(tool: string): void {
  const projectConfigFile = getProjectConfigFile();
  const current = readJsonFile(projectConfigFile) as PermissionConfigData;
  const existingTools = current.alwaysAllowTools ?? [];

  if (!existingTools.includes(tool)) {
    writeJsonFile(projectConfigFile, {
      ...current,
      alwaysAllowTools: [...existingTools, tool]
    });
  }
}
