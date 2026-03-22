/**
 * KodaX Glob Tool
 *
 * 文件搜索工具
 */

import { glob as globAsync } from 'glob';
import type { KodaXToolExecutionContext } from '../types.js';
import { resolveExecutionPathOrCwd } from '../runtime-paths.js';

export async function toolGlob(input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> {
  const pattern = input.pattern as string;
  const cwd = resolveExecutionPathOrCwd(input.path as string | undefined, ctx);
  const files = await globAsync(pattern, { cwd, nodir: true, absolute: true, ignore: ['**/node_modules/**', '**/dist/**', '**/.*'] });
  if (files.length === 0) return 'No files found';
  return files.slice(0, 100).join('\n') + (files.length > 100 ? '\n... (more files)' : '');
}
