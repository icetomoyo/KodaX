/**
 * KodaX Undo Tool
 *
 * 撤销工具 - 恢复最后一次文件修改
 */

import fs from 'fs/promises';
import { KodaXToolExecutionContext } from '../types.js';
import { getFileBackups } from './write.js';

export async function toolUndo(_input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> {
  const backups = getFileBackups();
  if (backups.size > 0) {
    const entries = [...backups.entries()];
    const [filePath, content] = entries[entries.length - 1]!;
    backups.delete(filePath);
    ctx.backups.delete(filePath);
    await fs.writeFile(filePath, content, 'utf-8');
    return `Restored: ${filePath}`;
  }
  return 'No backups available. Nothing to undo.';
}
