/**
 * Permission Executor
 *
 * 工具执行权限包装器 - 在 REPL 层处理权限检查
 */

import { executeTool } from '@kodax-ai/coding';
import type { KodaXToolExecutionContext } from '@kodax-ai/coding';
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
  isBashReadCommandAutoAllowed,
  getPlanModeBlockReason,
} from './permission.js';
import { generateSavePattern } from './permission.js';

// ============== Permission Executor ==============

/**
 * Execute a tool with permission checks
 * 执行工具并进行权限检查
 *
 * Permission logic:
 * 1. Plan mode: block modification tools
 * 2. Protected paths: always confirm (.kodax/, ~/.kodax/, out-of-project)
 * 3. Mode-based checks (Plan/Edits/Auto[LLM]/Full Access)
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

  // Full Access is a direct host profile. Explicit Exec Policy is enforced by
  // the Runtime boundary; legacy REPL helper/protected-path heuristics must not
  // silently turn this profile back into Edits.
  if (mode === 'full-access') {
    return executeTool(toolName, input, coreContext);
  }

  // === 2. Safe read-only bash commands: auto-allow in all modes ===
  if (toolName === 'bash') {
    const command = (input.command as string) ?? '';
    if (isBashReadCommandAutoAllowed(
      command,
      permContext.gitRoot ?? process.cwd(),
    )) {
      return executeTool(toolName, input, coreContext);
    }

  }

  // === 3. Protected paths: always confirm ===
  if (
    mode === 'accept-edits'
    && permContext.gitRoot
    && FILE_MODIFICATION_TOOLS.has(toolName)
  ) {
    const targetPath = input.path as string | undefined;
    if (targetPath && isAlwaysConfirmPath(targetPath, permContext.gitRoot)) {
      const result = permContext.onConfirm
        ? await permContext.onConfirm(toolName, { ...input, _alwaysConfirm: true })
        : { confirmed: false };
      if (!result.confirmed) return '[Cancelled] Operation on protected path requires confirmation';
    }
  }

  // === 6. Profile-owned standard confirmation check ===
  if (permContext.confirmTools.has(toolName)) {
    let skipConfirmation = false;

    // Only check alwaysAllowTools in accept-edits mode for bash. FEATURE_153:
    // pass the LLM-backed prefix extractor (set by REPL bootstrap on the
    // PermissionContext) so `Bash(git commit:*)` allowlist patterns match
    // against the LLM-extracted safe prefix instead of naive `startsWith`.
    if (mode === 'accept-edits' && toolName === 'bash') {
      if (
        await isToolCallAllowed(
          toolName,
          input,
          permContext.alwaysAllowTools,
          permContext.bashPrefixExtractor,
        )
      ) {
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
  /**
   * FEATURE_153 (v0.7.38) — Optional LLM-backed bash prefix extractor;
   * when supplied, `isToolCallAllowed` matches allowlist patterns against
   * the extracted safe prefix instead of naive `command.startsWith`.
   */
  bashPrefixExtractor?: PermissionContext['bashPrefixExtractor'];
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
    bashPrefixExtractor: options.bashPrefixExtractor,
  };
}
