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

import { getAgentConfigPath } from '@kodax-ai/agent';
import {
  PermissionMode,
  canonicalizePermissionMode,
  normalizePermissionMode,
  parseAllowedToolPattern,
  isToolCallAllowed,
  generateSavePattern,
} from '../permission/index.js';

// Re-export for convenience - 重新导出便于使用
export { parseAllowedToolPattern, isToolCallAllowed, generateSavePattern };

/**
 * User-level config: `~/.kodax/config.json` (or `KODAX_HOME` env var or
 * `setAgentConfigHome()` programmatic override).
 *
 * **Load-time freeze warning (v0.7.35.1 FEATURE_145, parallel to the
 * `KODAX_DIR` / `KODAX_SESSIONS_DIR` / `KODAX_CONFIG_FILE` exports in
 * `./utils.ts`)** — this constant is evaluated ONCE at module import
 * time. Substrate consumers that call `setAgentConfigHome(path)` AFTER
 * importing this module will see the pre-override path here, so
 * `getPermissionConfig()` etc. will continue to read/write
 * `~/.kodax/config.json` instead of the redirected directory.
 *
 * Required ordering for substrate consumers:
 *   1. Call `setAgentConfigHome(path)` from `@kodax-ai/agent` early in boot
 *   2. THEN import any `@kodax-ai/repl` module that touches user config
 *
 * Standalone `kodax` CLI is unaffected — it never calls
 * `setAgentConfigHome()` so the load-time resolution always equals the
 * runtime resolution.
 */
const USER_CONFIG_FILE = getAgentConfigPath('config.json');

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
  autoReview?: AutoReviewSettings;
}

/** Optional fixed policy for the Auto host-boundary reviewer. */
export interface AutoReviewSettings {
  policy?: string;
}

/**
 * Auto-mode classifier configuration. Read from `~/.kodax/config.json` (user-
 * level only — project-level is intentionally not consulted, matching
 * `permissionMode`'s scope) plus the classifier-model environment override.
 */
export interface AutoModeSettings {
  /** @deprecated Legacy input accepted and ignored at the read boundary. */
  engine?: 'llm' | 'rules';
  /**
   * Classifier model spec — `"provider:model"` or `"model"` (provider then
   * inherits from the main session). Feeds layer 4 of `resolveClassifierModel`.
   */
  classifierModel?: string;
  /** @deprecated Accepted as inert migration input. Reviewer deadlines are fixed. */
  timeoutMs?: number;
  /** @deprecated Accepted as inert migration input. Sandbox-first routing has no speculative window. */
  speculativeWindowMs?: number;
}

export interface ResolvedAutoModeSettings {
  readonly classifierModel?: string;
  readonly classifierModelEnv?: string;
  readonly reviewPolicy?: string;
}

export interface ResolveAutoModeSettingsInput {
  readonly settings?: AutoModeSettings;
  readonly autoReview?: AutoReviewSettings;
  readonly env?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;
}

/**
 * Load auto-mode settings from `~/.kodax/config.json` and apply the
 * `KODAX_AUTO_MODE_*` env override family. This wrapper performs one
 * filesystem read; `resolveAutoModeSettings()` is the pure counterpart.
 *
 * Env priority (highest first):
 *   - KODAX_AUTO_MODE_CLASSIFIER_MODEL: model spec — surfaced as `classifierModelEnv`
 *     so it reaches `AutoModeGuardrailConfig.envVar` (the resolver's layer 2)
 * Legacy timeout/window inputs and environment variables are ignored.
 */
export function loadAutoModeSettings(env: NodeJS.ProcessEnv = process.env): ResolvedAutoModeSettings {
  const userConfig = readJsonFile(USER_CONFIG_FILE) as PermissionConfigData;
  return resolveAutoModeSettings({
    settings: userConfig.autoMode,
    autoReview: userConfig.autoReview,
    env,
  });
}

/**
 * Resolve Auto settings from caller-owned data without reading global files.
 * SDK hosts can therefore share the REPL's validation and precedence rules
 * while retaining ownership of their own configuration source.
 */
export function resolveAutoModeSettings(
  input: ResolveAutoModeSettingsInput = {},
): ResolvedAutoModeSettings {
  const fileSettings = input.settings ?? {};
  // Keep the SDK resolver deterministic. The file-loading wrapper explicitly
  // passes its environment; caller-owned settings do not inherit process state
  // unless the caller opts in by supplying `env`.
  const env = input.env ?? {};

  const classifierModel = nonEmptyString(fileSettings.classifierModel);
  const classifierModelEnv = nonEmptyString(env.KODAX_AUTO_MODE_CLASSIFIER_MODEL);
  const reviewPolicy = nonEmptyString(input.autoReview?.policy);

  return {
    classifierModel,
    classifierModelEnv,
    reviewPolicy,
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
  writeJsonFile(USER_CONFIG_FILE, {
    ...current,
    permissionMode: canonicalizePermissionMode(mode),
  });
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
