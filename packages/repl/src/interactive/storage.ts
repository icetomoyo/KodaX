/**
 * KodaX 会话存储 - 文件系统实现
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { KodaXMessage, KodaXSessionStorage } from '@kodax/core';
import { getGitRoot, KODAX_SESSIONS_DIR } from '../cli/utils.js';

export class FileSessionStorage implements KodaXSessionStorage {
  async save(id: string, data: { messages: KodaXMessage[]; title: string; gitRoot: string }): Promise<void> {
    await fs.mkdir(KODAX_SESSIONS_DIR, { recursive: true });
    const meta = { _type: 'meta', title: data.title, id, gitRoot: data.gitRoot, createdAt: new Date().toISOString() };
    const lines = [JSON.stringify(meta), ...data.messages.map(m => JSON.stringify(m))];
    await fs.writeFile(path.join(KODAX_SESSIONS_DIR, `${id}.jsonl`), lines.join('\n'), 'utf-8');
  }

  async load(id: string): Promise<{ messages: KodaXMessage[]; title: string; gitRoot: string } | null> {
    const filePath = path.join(KODAX_SESSIONS_DIR, `${id}.jsonl`);
    if (!fsSync.existsSync(filePath)) return null;
    const lines = (await fs.readFile(filePath, 'utf-8')).trim().split('\n');
    const messages: KodaXMessage[] = [];
    let title = '', gitRoot = '';
    for (let i = 0; i < lines.length; i++) {
      const data = JSON.parse(lines[i]!);
      if (i === 0 && data._type === 'meta') { title = data.title ?? ''; gitRoot = data.gitRoot ?? ''; }
      else messages.push(data);
    }

    const currentGitRoot = await getGitRoot();
    if (currentGitRoot && gitRoot && currentGitRoot !== gitRoot) {
      console.log(chalk.yellow(`\n[Warning] Session project mismatch:`));
      console.log(`  Current:  ${currentGitRoot}`);
      console.log(`  Session:  ${gitRoot}`);
      console.log(`  Continuing anyway...\n`);
    }

    return { messages, title, gitRoot };
  }

  async list(gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number }>> {
    await fs.mkdir(KODAX_SESSIONS_DIR, { recursive: true });
    const currentGitRoot = gitRoot ?? await getGitRoot();
    const files = (await fs.readdir(KODAX_SESSIONS_DIR)).filter(f => f.endsWith('.jsonl'));
    const sessions = [];
    for (const f of files) {
      try {
        const content = (await fs.readFile(path.join(KODAX_SESSIONS_DIR, f), 'utf-8')).trim();
        const firstLine = content.split('\n')[0];
        if (!firstLine) continue;
        const first = JSON.parse(firstLine);
        if (first._type === 'meta') {
          const sessionGitRoot = first.gitRoot ?? '';
          if (currentGitRoot && sessionGitRoot && currentGitRoot !== sessionGitRoot) continue;
          const lineCount = content.split('\n').length;
          sessions.push({ id: f.replace('.jsonl', ''), title: first.title ?? '', msgCount: lineCount - 1 });
        } else {
          const lineCount = content.split('\n').length;
          sessions.push({ id: f.replace('.jsonl', ''), title: '', msgCount: lineCount });
        }
      } catch { continue; }
    }
    return sessions.sort((a, b) => b.id.localeCompare(a.id)).slice(0, 10);
  }

  async delete(id: string): Promise<void> {
    const filePath = path.join(KODAX_SESSIONS_DIR, `${id}.jsonl`);
    if (fsSync.existsSync(filePath)) {
      await fs.unlink(filePath);
    }
  }

  async deleteAll(gitRoot?: string): Promise<void> {
    const currentGitRoot = gitRoot ?? await getGitRoot();
    const sessions = await this.list(currentGitRoot ?? undefined);
    for (const s of sessions) {
      await this.delete(s.id);
    }
  }
}
