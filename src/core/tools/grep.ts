/**
 * KodaX Grep Tool
 *
 * 文本搜索工具
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { glob as globAsync } from 'glob';

export async function toolGrep(input: Record<string, unknown>): Promise<string> {
  const pattern = input.pattern as string;
  const searchPath = (input.path as string) ?? process.cwd();
  const ignoreCase = (input.ignore_case as boolean) ?? false;
  const outputMode = (input.output_mode as string) ?? 'content';
  const flags = ignoreCase ? 'gi' : 'g';
  const regex = new RegExp(pattern, flags);
  const resolvedPath = path.resolve(searchPath);
  const results: string[] = [];

  const stat = fsSync.existsSync(resolvedPath) ? fsSync.statSync(resolvedPath) : null;
  if (stat?.isFile()) {
    try {
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && results.length < 200; i++) {
        if (regex.test(lines[i]!)) {
          if (outputMode === 'files_with_matches') { results.push(resolvedPath); break; }
          else results.push(`${resolvedPath}:${i + 1}: ${lines[i]!.trim()}`);
        }
        regex.lastIndex = 0;
      }
    } catch { }
  } else {
    const files = (await globAsync('**/*', { cwd: resolvedPath, nodir: true, absolute: true, ignore: ['**/node_modules/**', '**/.*'] })).slice(0, 100);
    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && results.length < 200; i++) {
          if (regex.test(lines[i]!)) {
            if (outputMode === 'files_with_matches') { results.push(file); break; }
            else results.push(`${file}:${i + 1}: ${lines[i]!.trim()}`);
          }
          regex.lastIndex = 0;
        }
      } catch { }
    }
  }
  if (outputMode === 'count') return `${results.length} matches`;
  return results.length ? results.join('\n') : `No matches for "${pattern}"`;
}
