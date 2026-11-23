import path from 'path';
import type { KodaXContextOptions, KodaXToolExecutionContext } from './types.js';

type RuntimePathContext =
  | Pick<KodaXContextOptions, 'executionCwd' | 'gitRoot'>
  | Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>
  | undefined
  | null;

export function resolveExecutionCwd(context?: RuntimePathContext): string {
  return path.resolve(context?.executionCwd ?? context?.gitRoot ?? process.cwd());
}

export function resolveExecutionPath(targetPath: string, context?: RuntimePathContext): string {
  const baseDir = resolveExecutionCwd(context);
  return path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(baseDir, targetPath);
}

/**
 * Resolve a repository-tool target, refusing paths outside the execution
 * directory and its Git root. Repo tools derive their workspace from the
 * target, so an outside path would analyze an unrelated directory.
 */
export function resolveWorkspaceTargetPath(targetPath: string | undefined, context?: RuntimePathContext): string {
  const resolved = resolveExecutionPathOrCwd(targetPath, context);
  const boundaries = [resolveExecutionCwd(context), ...(context?.gitRoot ? [path.resolve(context.gitRoot)] : [])];
  if (!boundaries.some((boundary) => isInsideDirectory(resolved, boundary))) {
    throw new Error(`target_path must stay inside the workspace: ${targetPath}`);
  }
  return resolved;
}

// Kept local: importing @kodax-ai/agent here would load the whole agent package
// into every file tool, including the bounded-heap read path.
function isInsideDirectory(target: string, directory: string): boolean {
  const relative = path.relative(directory, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveExecutionPathOrCwd(targetPath: string | undefined, context?: RuntimePathContext): string {
  if (!targetPath || !targetPath.trim()) {
    return resolveExecutionCwd(context);
  }

  return resolveExecutionPath(targetPath, context);
}
