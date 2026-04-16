/**
 * Permission Executor
 *
 * 工具执行权限包装器 - 在 REPL 层处理权限检查
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { executeTool } from '@kodax/coding';
import type { KodaXToolExecutionContext } from '@kodax/coding';
import {
  PermissionMode,
  PermissionContext,
  FILE_MODIFICATION_TOOLS,
  computeConfirmTools,
  normalizePermissionMode,
} from './types.js';
import {
  isToolCallAllowed,
  isAlwaysConfirmPath,
  isBashReadCommand,
  collectBashWriteTargets,
  getBashOutsideProjectWriteRisk,
  isPathInsideProject,
  getPlanModeBlockReason,
} from './permission.js';
import { generateSavePattern } from './permission.js';

const ROOT_TEMP_SCRIPT_EXTENSIONS = new Set([
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.cmd',
  '.bat',
  '.js',
  '.cjs',
  '.mjs',
  '.ts',
  '.py',
  '.rb',
]);

const TEMP_HELPER_SCRIPT_NAME = /(^|[-_.])(tmp|temp|scratch|helper|retry|debug|agent|kodax)([-_.]|$)/i;
const BASH_FILE_WRITE_MARKERS = [
  '>',
  '>>',
  'set-content',
  'add-content',
  'out-file',
  'new-item',
  'tee ',
];

// ============== Path Safety Checks ==============

function isPathInsideDirectory(targetPath: string, directoryPath: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedDirectory = path.resolve(directoryPath);
  return resolvedTarget === resolvedDirectory || resolvedTarget.startsWith(resolvedDirectory + path.sep);
}

function isSystemTempReference(targetPath: string): boolean {
  const normalized = targetPath.replace(/\\/g, '/').toLowerCase();
  if (
    normalized.includes('%temp%') ||
    normalized.includes('%tmp%') ||
    normalized.includes('$env:temp') ||
    normalized.includes('$env:tmp') ||
    normalized.includes('$temp') ||
    normalized.includes('$tmp')
  ) {
    return true;
  }

  try {
    return isPathInsideDirectory(path.resolve(targetPath), os.tmpdir());
  } catch {
    return false;
  }
}

function isProjectScratchPath(targetPath: string, projectRoot: string): boolean {
  return isPathInsideDirectory(targetPath, path.join(projectRoot, '.agent'));
}

function isLikelyTemporaryHelperScriptPath(targetPath: string, projectRoot: string): boolean {
  const resolvedTarget = path.resolve(projectRoot, targetPath);
  const extension = path.extname(resolvedTarget).toLowerCase();
  if (!ROOT_TEMP_SCRIPT_EXTENSIONS.has(extension)) {
    return false;
  }

  if (isProjectScratchPath(resolvedTarget, projectRoot) || isSystemTempReference(targetPath)) {
    return false;
  }

  const basename = path.basename(resolvedTarget, extension);
  return TEMP_HELPER_SCRIPT_NAME.test(basename);
}

function buildTemporaryHelperScriptWarning(targetPath: string, projectRoot: string): string {
  const scratchDir = path.join(projectRoot, '.agent');
  return `[Blocked] Avoid scattering temporary helper scripts outside the project scratch area: ${path.basename(targetPath)}. First try specialized tools (read/edit/write/glob/grep) or a simpler shell command. If a helper script is still necessary, place it under ${scratchDir} or use the system temp directory.`;
}

async function getTemporaryHelperScriptWarning(
  toolName: string,
  input: Record<string, unknown>,
  projectRoot?: string
): Promise<string | null> {
  if (toolName !== 'write' || !projectRoot) {
    return null;
  }

  const targetPath = input.path as string | undefined;
  if (!targetPath) {
    return null;
  }

  try {
    await fs.stat(path.resolve(projectRoot, targetPath));
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return null;
    }

    try {
      const resolvedTarget = path.resolve(projectRoot, targetPath);

      if (!isLikelyTemporaryHelperScriptPath(resolvedTarget, projectRoot)) {
        return null;
      }

      return buildTemporaryHelperScriptWarning(resolvedTarget, projectRoot);
    } catch {
      return null;
    }
  }
}

function getBashTemporaryHelperScriptWarning(command: string, projectRoot?: string): string | null {
  if (!projectRoot) {
    return null;
  }

  const normalizedCommand = command.toLowerCase();
  const mayWriteFiles = BASH_FILE_WRITE_MARKERS.some(marker => normalizedCommand.includes(marker));
  if (!mayWriteFiles) {
    return null;
  }

  for (const targetPath of collectBashWriteTargets(command)) {
    if (isLikelyTemporaryHelperScriptPath(targetPath, projectRoot)) {
      return buildTemporaryHelperScriptWarning(path.resolve(projectRoot, targetPath), projectRoot);
    }
  }

  return null;
}

// ============== Permission Executor ==============

/**
 * Execute a tool with permission checks
 * 执行工具并进行权限检查
 *
 * Permission logic:
 * 1. Plan mode: block modification tools
 * 2. Protected paths: always confirm (.kodax/, ~/.kodax/, out-of-project)
 * 3. Mode-based checks (plan/accept-edits/auto-in-project)
 * 4. alwaysAllowTools pattern matching (bash only, accept-edits only)
 * 5. Call onConfirm if needed
 * 6. Execute via core's executeTool()
 */
export async function executeWithPermission(
  toolName: string,
  input: Record<string, unknown>,
  coreContext: KodaXToolExecutionContext,
  permContext: PermissionContext
): Promise<string> {
  const mode = permContext.permissionMode;

  // === 1. Plan mode: block all modification tools ===
  if (mode === 'plan') {
    const planModeBlockReason = getPlanModeBlockReason(toolName, input, permContext.gitRoot);
    if (planModeBlockReason) {
      return `${planModeBlockReason} Do not try to modify files while planning. Finish the plan first, then use ask_user_question to ask the user whether to proceed. If the user confirms, call set_permission_mode with mode "accept-edits" to switch to implementation mode.`;
    }
  }

  // === 2. Safe read-only bash commands: auto-allow in all modes ===
  if (toolName === 'bash') {
    const command = (input.command as string) ?? '';
    if (isBashReadCommand(command)) {
      return executeTool(toolName, input, coreContext);
    }

    const bashTempScriptWarning = getBashTemporaryHelperScriptWarning(command, permContext.gitRoot);
    if (bashTempScriptWarning) {
      return bashTempScriptWarning;
    }
  }

  // === 2.5. Guard against temporary helper scripts outside scratch area ===
  const tempScriptWarning = await getTemporaryHelperScriptWarning(toolName, input, permContext.gitRoot);
  if (tempScriptWarning) {
    return tempScriptWarning;
  }

  // === 3. Protected paths: always confirm ===
  if (permContext.gitRoot && FILE_MODIFICATION_TOOLS.has(toolName)) {
    const targetPath = input.path as string | undefined;
    if (targetPath && isAlwaysConfirmPath(targetPath, permContext.gitRoot)) {
      const result = permContext.onConfirm
        ? await permContext.onConfirm(toolName, { ...input, _alwaysConfirm: true })
        : { confirmed: false };
      if (!result.confirmed) return '[Cancelled] Operation on protected path requires confirmation';
    }
  }

  // === 4. auto-in-project: protect outside-project file edits ===
  if (mode === 'auto-in-project' && permContext.gitRoot && FILE_MODIFICATION_TOOLS.has(toolName)) {
    const targetPath = input.path as string | undefined;
    if (targetPath && !isPathInsideProject(targetPath, permContext.gitRoot)) {
      const result = permContext.onConfirm
        ? await permContext.onConfirm(toolName, { ...input, _outsideProject: true })
        : { confirmed: false };
      if (!result.confirmed) return '[Cancelled] Operation on file outside project directory was cancelled';
    }
  }

  // === 5. auto-in-project: protect outside-project bash commands ===
  if (mode === 'auto-in-project' && permContext.gitRoot && toolName === 'bash') {
    const command = input.command as string;
    if (command) {
      const dangerCheck = getBashOutsideProjectWriteRisk(command, permContext.gitRoot);
      if (dangerCheck.dangerous) {
        const result = permContext.onConfirm
          ? await permContext.onConfirm(toolName, { ...input, _outsideProject: true, _reason: dangerCheck.reason })
          : { confirmed: false };
        if (!result.confirmed) return `[Cancelled] ${dangerCheck.reason}`;
      }
    }
  }

  // === 6. plan / accept-edits / auto-in-project: standard confirmTools check ===
  if (permContext.confirmTools.has(toolName)) {
    let skipConfirmation = false;

    // Only check alwaysAllowTools in accept-edits mode for bash
    if (mode === 'accept-edits' && toolName === 'bash') {
      if (isToolCallAllowed(toolName, input, permContext.alwaysAllowTools)) {
        skipConfirmation = true;
      }
    }

    if (!skipConfirmation && permContext.onConfirm) {
      const result = await permContext.onConfirm(toolName, input);
      if (!result.confirmed) return '[Cancelled] Operation cancelled by user';

      // Handle "always" selection
      if (result.always) {
        if (mode === 'accept-edits') {
          permContext.saveAlwaysAllowTool?.(toolName, input, false);
        }
      }
    }
  }

  // === 7. Execute via core's executeTool() ===
  return executeTool(toolName, input, coreContext);
}

/**
 * Create a permission context from options
 */
export function createPermissionContext(options: {
  permissionMode?: PermissionMode;
  alwaysAllowTools?: string[];
  gitRoot?: string;
  onConfirm?: PermissionContext['onConfirm'];
  saveAlwaysAllowTool?: PermissionContext['saveAlwaysAllowTool'];
  switchPermissionMode?: PermissionContext['switchPermissionMode'];
  beforeToolExecute?: PermissionContext['beforeToolExecute'];
}): PermissionContext {
  const mode = normalizePermissionMode(options.permissionMode, 'accept-edits') ?? 'accept-edits';
  return {
    permissionMode: mode,
    confirmTools: computeConfirmTools(mode),
    gitRoot: options.gitRoot,
    alwaysAllowTools: options.alwaysAllowTools ?? [],
    onConfirm: options.onConfirm,
    saveAlwaysAllowTool: options.saveAlwaysAllowTool,
    switchPermissionMode: options.switchPermissionMode,
    beforeToolExecute: options.beforeToolExecute,
  };
}
