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
import { generateDiff, countChanges } from './diff.js';

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

  // Generate diff output - 生成差异输出
  const diff = generateDiff(content, newContent, filePath);
  const changes = countChanges(diff);

  // Build result with diff info - 构建带差异信息的结果
  let result = `File edited: ${filePath}`;

  if (replaceAll && count > 1) {
    result += ` (${count} replacements)`;
  }

  result += `\n  (+${changes.added} lines, -${changes.removed} lines)`;

  // Show the actual old/new strings for context - 显示实际的旧/新字符串作为上下文
  const oldStrPreview = oldStr.length > 100 ? oldStr.slice(0, 100) + '...' : oldStr;
  const newStrPreview = newStr.length > 100 ? newStr.slice(0, 100) + '...' : newStr;

  // Use simple format for single-line changes - 单行变更使用简单格式
  if (!oldStr.includes('\n') && !newStr.includes('\n')) {
    result += `\n\n- ${oldStrPreview}\n+ ${newStrPreview}`;
  } else if (diff) {
    // Use full diff for multi-line changes - 多行变更使用完整差异
    result += `\n\n${diff}`;
  }

  return result;
}
