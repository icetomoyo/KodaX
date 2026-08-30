/**
 * Permission Module
 *
 * 权限控制模块 - REPL 层权限检查
 */

// Types
export type {
  CanonicalPermissionMode,
  PermissionMode,
  ConfirmResult,
  PermissionContext,
} from './types.js';
export {
  MODIFICATION_TOOLS,
  FILE_MODIFICATION_TOOLS,
  PERMISSION_MODES,
  CANONICAL_PERMISSION_MODES,
  canonicalizePermissionMode,
  computeConfirmTools,
  isAutoMode,
  isPermissionMode,
  normalizePermissionMode,
  permissionModeDisplayName,
} from './types.js';

// Permission utilities
export {
  parseAllowedToolPattern,
  isToolCallAllowed,
  generateSavePattern,
  isAlwaysConfirmPath,
  isCommandOnProtectedPath,
  inferPermissionMode,
  getDirectShellBypassBlockReason,
  isBashWriteCommand,
  isBashReadCommand,
  isBashReadCommandAutoAllowed,
  collectBashWriteTargets,
  isPathInsideProject,
  getBashOutsideProjectWriteRisk,
  getPlanModeAllowedWritablePaths,
  getPlanModeBlockReason,
  isPlanModeAllowedPath,
} from './permission.js';

// Executor
export { executeWithPermission, createPermissionContext } from './executor.js';
export { allowsAcceptEditsClassifierFallback } from './accept-edits-fallback.js';
export type { StandaloneExecPolicyOptions } from './standalone-shell-boundary.js';

// FEATURE_158 (v0.7.39): REPL-side path-aware bash signal collector. Wired
// into the auto-mode guardrail via the bootstrap's `extraCollectors` config.
export { replBashPathSignalCollector } from './repl-bash-signals.js';
