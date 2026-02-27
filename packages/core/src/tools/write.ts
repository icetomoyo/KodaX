/**
 * KodaX Write Tool
 *
 * 文件写入工具
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { KodaXToolExecutionContext } from '../types.js';
import { generateDiff, countChanges } from './diff.js';

// 全局文件备份（用于 undo）
const FILE_BACKUPS = new Map<string, string>();

export function getFileBackups(): Map<string, string> {
  return FILE_BACKUPS;
}

export async function toolWrite(input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> {
  const filePath = path.resolve(input.path as string);
  const content = input.content as string;

  let oldContent = '';
  let isNewFile = !fsSync.existsSync(filePath);

  if (!isNewFile) {
    oldContent = await fs.readFile(filePath, 'utf-8');
    ctx.backups.set(filePath, oldContent);
    FILE_BACKUPS.set(filePath, oldContent);
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');

  // Generate diff output - 生成差异输出
  const diff = generateDiff(oldContent, content, filePath);
  const changes = countChanges(diff);

  if (isNewFile) {
    const lineCount = content.split('\n').length;
    return `File created: ${filePath}\n  (${lineCount} lines written)`;
  }

  if (diff) {
    return `File updated: ${filePath}\n  (+${changes.added} lines, -${changes.removed} lines)\n\n${diff}`;
  }

  return `File written: ${filePath} (no changes)`;
}
