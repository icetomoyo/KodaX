/**
 * KodaX Read Tool
 *
 * 文件读取工具
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

export async function toolRead(input: Record<string, unknown>): Promise<string> {
  const filePath = path.resolve(input.path as string);
  if (!fsSync.existsSync(filePath)) return `[Tool Error] File not found: ${filePath}`;
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  // offset 是 1-indexed，0 表示从头开始（等同于 1）
  const offset = Math.max(0, (input.offset as number) ?? 1);
  const limit = (input.limit as number) ?? lines.length;
  // 转换为 0-indexed
  const startIdx = Math.max(0, offset > 0 ? offset - 1 : 0);
  const selected = lines.slice(startIdx, startIdx + limit);
  const numbered = selected.map((l, i) => `${(offset + i).toString().padStart(6)}\t${l}`);
  if (selected.length < lines.length && limit >= lines.length) {
    return numbered.join('\n') + `\n\n[Truncated] ${lines.length} lines total`;
  }
  return numbered.join('\n');
}
