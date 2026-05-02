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
 * - Edit/Write: Auto-allowed in accept-edits, blocked in plan
 */

import fsSync from 'fs';
import path from 'path';
import os from 'os';
import {
  PermissionMode,
  normalizePermissionMode,
  parseAllowedToolPattern,
  isToolCallAllowed,
  generateSavePattern,
} from '../permission/index.js';

// Re-export for convenience - 重新导出便于使用
export { parseAllowedToolPattern, isToolCallAllowed, generateSavePattern };

// User-level config: ~/.kodax/config.json
const USER_CONFIG_FILE = path.join(os.homedir(), '.kodax', 'config.json');

// Project-level config: .kodax/config.local.json (in current working directory)
function getProjectConfigFile(): string {
  return path.join(process.cwd(), '.kodax', 'config.local.json');
}

interface PermissionConfigData {
  permissionMode?: string;
  alwaysAllowTools?: string[];
  /**
   * FEATURE_092 phase 2b.7b slice C: auto-mode classifier settings.
   * Only consulted when `permissionMode === 'auto'`.
   */
  autoMode?: AutoModeSettings;
}

/**
 * Auto-mode classifier configuration. Read from `~/.kodax/config.json` (user-
 * level only — project-level is intentionally not consulted, matching
 * `permissionMode`'s scope) plus the `KODAX_AUTO_MODE_*` env override family.
 */
export interface AutoModeSettings {
  /**
   * Starting engine for the session.
   * - `'llm'` (default): classifier runs on every non-Tier-1 tool call
   * - `'rules'`: classifier skipped; every non-Tier-1 call escalates to askUser
   * Engine downgrades stay sticky within the session regardless of this value.
   */
  engine?: 'llm' | 'rules';
  /**
   * Classifier model spec — `"provider:model"` or `"model"` (provider then
   * inherits from the main session). Feeds layer 4 of `resolveClassifierModel`.
   */
  classifierModel?: string;
  /** sideQuery timeout in ms. Default 8000. */
  timeoutMs?: number;
}

export interface ResolvedAutoModeSettings {
  readonly engine: 'llm' | 'rules';
  readonly classifierModel?: string;
  readonly classifierModelEnv?: string;
  readonly timeoutMs?: number;
}

/**
 * Resolve auto-mode settings from `~/.kodax/config.json` and the
 * `KODAX_AUTO_MODE_*` env override family. Pure (no side effects).
 *
 * Env priority (highest first):
 *   - KODAX_AUTO_MODE_ENGINE: 'llm' | 'rules' — overrides settings.engine
 *   - KODAX_AUTO_MODE_CLASSIFIER_MODEL: model spec — surfaced as `classifierModelEnv`
 *     so it reaches `AutoModeGuardrailConfig.envVar` (the resolver's layer 2)
 *   - KODAX_AUTO_MODE_TIMEOUT_MS: integer ms — overrides settings.timeoutMs
 *
 * Invalid env values fall through to settings (defensive: a typo in an env
 * var must not silently disable the classifier).
 */
export function loadAutoModeSettings(env: NodeJS.ProcessEnv = process.env): ResolvedAutoModeSettings {
  const userConfig = readJsonFile(USER_CONFIG_FILE) as PermissionConfigData;
  const fileSettings = userConfig.autoMode ?? {};

  const envEngineRaw = env.KODAX_AUTO_MODE_ENGINE?.trim();
  const envEngine =
    envEngineRaw === 'llm' || envEngineRaw === 'rules' ? envEngineRaw : undefined;
  const fileEngine =
    fileSettings.engine === 'llm' || fileSettings.engine === 'rules'
      ? fileSettings.engine
      : undefined;
  const engine: 'llm' | 'rules' = envEngine ?? fileEngine ?? 'llm';

  const classifierModel = nonEmptyString(fileSettings.classifierModel);
  const classifierModelEnv = nonEmptyString(env.KODAX_AUTO_MODE_CLASSIFIER_MODEL);

  const envTimeoutRaw = env.KODAX_AUTO_MODE_TIMEOUT_MS?.trim();
  const envTimeoutNum = envTimeoutRaw !== undefined ? Number(envTimeoutRaw) : NaN;
  const envTimeoutMs = Number.isFinite(envTimeoutNum) && envTimeoutNum > 0
    ? Math.floor(envTimeoutNum)
    : undefined;
  const fileTimeoutMs =
    typeof fileSettings.timeoutMs === 'number' && fileSettings.timeoutMs > 0
      ? Math.floor(fileSettings.timeoutMs)
      : undefined;

  return {
    engine,
    classifierModel,
    classifierModelEnv,
    timeoutMs: envTimeoutMs ?? fileTimeoutMs,
  };
}

function nonEmptyString(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined;
  const trimmed = s.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    if (fsSync.existsSync(filePath)) {
      return JSON.parse(fsSync.readFileSync(filePath, 'utf-8'));
    }
  } catch {
    // Invalid or unreadable config files should not crash permission loading.
  }
  return {};
}

function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  fsSync.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ============== Config Load/Save - 配置加载/保存 ==============

/**
 * Load effective permission mode (user-level only)
 * 加载有效权限模式（仅限用户级配置）
 */
export function loadPermissionMode(): PermissionMode | undefined {
  // Only use user-level config for permissionMode
  const userConfig = readJsonFile(USER_CONFIG_FILE) as PermissionConfigData;
  if (userConfig.permissionMode === 'default') {
    writeJsonFile(USER_CONFIG_FILE, {
      ...userConfig,
      permissionMode: 'accept-edits',
    });
    return 'accept-edits';
  }

  return normalizePermissionMode(userConfig.permissionMode, undefined as PermissionMode | undefined);
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
