/**
 * FEATURE_079 — Task Engine Phase 1 Pure Extraction (Slice 7)
 *
 * Managed-task workspace resolution helpers extracted from task-engine.ts.
 * Checkpoint and other managed-task helpers call these to determine the
 * on-disk root for `.agent/managed-tasks/`.
 */

import path from 'node:path';
import type { KodaXOptions, KodaXTaskSurface } from '../../../types.js';

/**
 * Resolve the managed-task surface ("cli" / "repl" / "plan") from options.
 * Defaults to "cli" when unset.
 */
export function getManagedTaskSurface(options: KodaXOptions): KodaXTaskSurface {
  return options.context?.taskSurface ?? 'cli';
}

/**
 * Resolve the on-disk root directory for managed-task artifacts (one directory
 * per task id). Respects explicit override in
 * `options.context.managedTaskWorkspaceDir`; otherwise derives from
 * `context.executionCwd` / `context.gitRoot` / `process.cwd()`.
 */
export function getManagedTaskWorkspaceRoot(options: KodaXOptions, _surface: KodaXTaskSurface): string {
  if (options.context?.managedTaskWorkspaceDir?.trim()) {
    return path.resolve(options.context.managedTaskWorkspaceDir);
  }

  const cwd = options.context?.executionCwd ?? options.context?.gitRoot ?? process.cwd();
  return path.resolve(cwd, '.agent', 'managed-tasks');
}
