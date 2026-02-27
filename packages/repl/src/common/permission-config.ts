/**
 * Permission Config - 2-level permission configuration load/save
 *
 * Priority: project-level (.kodax/config.local.json) > user-level (~/.kodax/config.json)
 * 优先级：项目级 (.kodax/config.local.json) > 用户级 (~/.kodax/config.json)
 */

import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { PermissionMode } from '@kodax/core';

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
 * Save a tool to the always-allow list (project-level config)
 * 保存工具到总是允许列表（项目级配置）
 *
 * Note: "Always yes" is project-specific, not global
 * 注意："总是允许"是项目特定的，不是全局的
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
