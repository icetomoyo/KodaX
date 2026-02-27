/**
 * Permission Module
 *
 * 权限控制模块 - REPL 层权限检查
 */

// Types
export type { PermissionMode, ConfirmResult, PermissionContext } from './types.js';
export { MODIFICATION_TOOLS, FILE_MODIFICATION_TOOLS, computeConfirmTools } from './types.js';

// Permission utilities
export {
  parseAllowedToolPattern,
  isToolCallAllowed,
  generateSavePattern,
  isAlwaysConfirmPath,
  inferPermissionMode,
} from './permission.js';

// Executor
export { executeWithPermission, createPermissionContext } from './executor.js';
