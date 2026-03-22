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

export function resolveExecutionPathOrCwd(targetPath: string | undefined, context?: RuntimePathContext): string {
  if (!targetPath || !targetPath.trim()) {
    return resolveExecutionCwd(context);
  }

  return resolveExecutionPath(targetPath, context);
}
