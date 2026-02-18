/**
 * KodaX Edit Tool
 *
 * 文件编辑工具
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { KodaXToolExecutionContext } from '../types.js';
import { getFileBackups } from './write.js';

export async function toolEdit(input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> {
  const filePath = path.resolve(input.path as string);
  if (!fsSync.existsSync(filePath)) return `[Tool Error] File not found: ${filePath}`;
  const oldStr = input.old_string as string;
  const newStr = input.new_string as string;
  const replaceAll = input.replace_all as boolean;
  const content = await fs.readFile(filePath, 'utf-8');
  ctx.backups.set(filePath, content);
  getFileBackups().set(filePath, content);
  if (!content.includes(oldStr)) return `[Tool Error] old_string not found`;
  const count = content.split(oldStr).length - 1;
  if (count > 1 && !replaceAll) return `[Tool Error] old_string appears ${count} times. Use replace_all=true`;
  // 使用字面字符串匹配（非正则），split/join 是安全的
  const newContent = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
  await fs.writeFile(filePath, newContent, 'utf-8');
  return `File edited: ${filePath}`;
}
