/**
 * FEATURE_079 — Task Engine Phase 1 Pure Extraction (Slice 7)
 *
 * Managed-task workspace resolution helpers extracted from task-engine.ts.
 * Zero-behavior-change move. Checkpoint and other managed-task helpers call
 * these to determine the on-disk root for `.agent/managed-tasks/` (or
 * `.agent/project/managed-tasks/` under the project surface).
 */

import path from 'node:path';
import type { KodaXOptions, KodaXTaskSurface } from '../../../types.js';

/**
 * Resolve the managed-task surface ("cli" vs "project") from options.
 * Respects explicit `context.taskSurface`, otherwise infers from the provider
 * policy hint.
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
export function getManagedTaskWorkspaceRoot(options: KodaXOptions, surface: KodaXTaskSurface): string {
  if (options.context?.managedTaskWorkspaceDir?.trim()) {
    return path.resolve(options.context.managedTaskWorkspaceDir);
  }

  const cwd = options.context?.executionCwd ?? options.context?.gitRoot ?? process.cwd();
  if (surface === 'project') {
    return path.resolve(cwd, '.agent', 'project', 'managed-tasks');
  }
  return path.resolve(cwd, '.agent', 'managed-tasks');
}
