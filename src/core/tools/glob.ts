/**
 * KodaX Glob Tool
 *
 * 文件搜索工具
 */

import path from 'path';
import { glob as globAsync } from 'glob';

export async function toolGlob(input: Record<string, unknown>): Promise<string> {
  const pattern = input.pattern as string;
  const cwd = (input.path as string) ?? process.cwd();
  const files = await globAsync(pattern, { cwd: path.resolve(cwd), nodir: true, absolute: true, ignore: ['**/node_modules/**', '**/dist/**', '**/.*'] });
  if (files.length === 0) return 'No files found';
  return files.slice(0, 100).join('\n') + (files.length > 100 ? '\n... (more files)' : '');
}
