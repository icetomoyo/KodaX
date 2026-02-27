/**
 * Permission Executor
 *
 * 工具执行权限包装器 - 在 REPL 层处理权限检查
 */

import path from 'path';
import { executeTool } from '@kodax/core';
import type { KodaXToolExecutionContext } from '@kodax/core';
import {
  PermissionMode,
  PermissionContext,
  FILE_MODIFICATION_TOOLS,
  computeConfirmTools,
} from './types.js';
import {
  isToolCallAllowed,
  isAlwaysConfirmPath,
} from './permission.js';
import { generateSavePattern } from './permission.js';

// ============== Path Safety Checks ==============

/**
 * Check if path is inside project directory
 */
function isPathInsideProject(targetPath: string, projectRoot: string): boolean {
  try {
    const resolvedTarget = path.resolve(targetPath);
    const resolvedRoot = path.resolve(projectRoot);
    const normalizedTarget = resolvedTarget.toLowerCase();
    const normalizedRoot = resolvedRoot.toLowerCase();
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep);
  } catch {
    return false;
  }
}

/**
 * Check if bash command is dangerous outside project
 */
function isBashCommandDangerousOutsideProject(command: string, projectRoot: string): { dangerous: boolean; reason?: string } {
  const DANGEROUS_COMMANDS = [
    'rm ', 'rm -', 'rmdir', 'mv ', 'cp ', 'del ', 'rd ',
    'shred', 'wipe', 'chmod', 'chown',
    '>', '>>', '2>',
  ];

  const normalizedCmd = command.toLowerCase();
  const hasDangerousCmd = DANGEROUS_COMMANDS.some(cmd => normalizedCmd.includes(cmd));
  if (!hasDangerousCmd) {
    return { dangerous: false };
  }

  const absPathPatterns = [
    /\/[^\s;|&<>(){}'"]+/g,
    /[A-Za-z]:[\\/][^\s;|&<>(){}'"]+/g,
  ];

  for (const pattern of absPathPatterns) {
    const matches = command.match(pattern);
    if (matches) {
      for (const match of matches) {
        if (match.startsWith('/dev/') || match.startsWith('/tmp/')) continue;
        if (!isPathInsideProject(match, projectRoot)) {
          return {
            dangerous: true,
            reason: `Command may modify file outside project: ${match}`
          };
        }
      }
    }
  }

  if (normalizedCmd.includes('>') || normalizedCmd.includes('>>')) {
    const redirectMatch = command.match(/[>]>\s*([^\s;|&]+)/g);
    if (redirectMatch) {
      for (const match of redirectMatch) {
        const targetPath = match.replace(/[>]>\s*/, '').trim();
        if (targetPath && !targetPath.startsWith('/') && !targetPath.match(/^[A-Za-z]:/)) {
          continue;
        }
        if (targetPath && !isPathInsideProject(targetPath, projectRoot)) {
          return {
            dangerous: true,
            reason: `Redirect target outside project: ${targetPath}`
          };
        }
      }
    }
  }

  return { dangerous: false };
}

// ============== Permission Executor ==============

/**
 * Execute a tool with permission checks
 * 执行工具并进行权限检查
 *
 * Permission logic:
 * 1. Plan mode: block modification tools
 * 2. Protected paths: always confirm (.kodax/, ~/.kodax/, out-of-project)
 * 3. Mode-based checks (default/accept-edits/auto-in-project)
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
  if (mode === 'plan' && (FILE_MODIFICATION_TOOLS.has(toolName) || toolName === 'bash' || toolName === 'undo')) {
    return `[Blocked] Tool '${toolName}' is not allowed in plan mode (read-only)`;
  }

  // === 2. Protected paths: always confirm ===
  if (permContext.gitRoot && FILE_MODIFICATION_TOOLS.has(toolName)) {
    const targetPath = input.path as string | undefined;
    if (targetPath && isAlwaysConfirmPath(targetPath, permContext.gitRoot)) {
      const result = permContext.onConfirm
        ? await permContext.onConfirm(toolName, { ...input, _alwaysConfirm: true })
        : { confirmed: false };
      if (!result.confirmed) return '[Cancelled] Operation on protected path requires confirmation';
    }
  }

  // === 3. auto-in-project: protect outside-project file edits ===
  if (mode === 'auto-in-project' && permContext.gitRoot && FILE_MODIFICATION_TOOLS.has(toolName)) {
    const targetPath = input.path as string | undefined;
    if (targetPath && !isPathInsideProject(targetPath, permContext.gitRoot)) {
      const result = permContext.onConfirm
        ? await permContext.onConfirm(toolName, { ...input, _outsideProject: true })
        : { confirmed: false };
      if (!result.confirmed) return '[Cancelled] Operation on file outside project directory was cancelled';
    }
  }

  // === 4. auto-in-project: protect outside-project bash commands ===
  if (mode === 'auto-in-project' && permContext.gitRoot && toolName === 'bash') {
    const command = input.command as string;
    if (command) {
      const dangerCheck = isBashCommandDangerousOutsideProject(command, permContext.gitRoot);
      if (dangerCheck.dangerous) {
        const result = permContext.onConfirm
          ? await permContext.onConfirm(toolName, { ...input, _outsideProject: true, _reason: dangerCheck.reason })
          : { confirmed: false };
        if (!result.confirmed) return `[Cancelled] ${dangerCheck.reason}`;
      }
    }
  }

  // === 5. default / accept-edits: standard confirmTools check ===
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
        if (permContext.permissionMode === 'default' && permContext.switchPermissionMode) {
          permContext.switchPermissionMode('accept-edits');
        }
      }
    }
  }

  // === 6. Execute via core's executeTool() ===
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
  const mode = options.permissionMode ?? 'default';
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
