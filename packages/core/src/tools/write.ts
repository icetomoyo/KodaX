/**
 * KodaX Write Tool
 *
 * 文件写入工具
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { KodaXToolExecutionContext } from '../types.js';

// 全局文件备份（用于 undo）
const FILE_BACKUPS = new Map<string, string>();

export function getFileBackups(): Map<string, string> {
  return FILE_BACKUPS;
}

export async function toolWrite(input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> {
  const filePath = path.resolve(input.path as string);
  const content = input.content as string;
  if (fsSync.existsSync(filePath)) {
    const existing = await fs.readFile(filePath, 'utf-8');
    ctx.backups.set(filePath, existing);
    FILE_BACKUPS.set(filePath, existing);
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
  return `File written: ${filePath}`;
}
