/**
 * KodaX 会话存储 - 文件系统实现
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { KodaXMessage, KodaXSessionStorage, cleanupIncompleteToolCalls } from '@kodax/coding';
import type { SessionData, SessionErrorMetadata } from '../ui/utils/session-storage.js';
import { getGitRoot, KODAX_SESSIONS_DIR } from '../common/utils.js';
import { isKodaXMessage, isRecord, isSessionErrorMetadata } from './json-guards.js';

function warnMalformedSessionData(filePath: string, count: number): void {
  if (count === 0 || process.env.NODE_ENV === 'test') {
    return;
  }

  console.warn(`[KodaX] Skipped ${count} malformed session record(s) from ${path.basename(filePath)}.`);
}

export class FileSessionStorage implements KodaXSessionStorage {
  async save(id: string, data: SessionData): Promise<void> {
    await fs.mkdir(KODAX_SESSIONS_DIR, { recursive: true });
    const meta = {
      _type: 'meta',
      title: data.title,
      id,
      gitRoot: data.gitRoot,
      createdAt: new Date().toISOString(),
      errorMetadata: data.errorMetadata,
    };
    const lines = [JSON.stringify(meta), ...data.messages.map(m => JSON.stringify(m))];
    await fs.writeFile(path.join(KODAX_SESSIONS_DIR, `${id}.jsonl`), lines.join('\n'), 'utf-8');
  }

  async load(id: string): Promise<SessionData | null> {
    const filePath = path.join(KODAX_SESSIONS_DIR, `${id}.jsonl`);
    if (!fsSync.existsSync(filePath)) return null;
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const trimmedContent = rawContent.trim();
    if (!trimmedContent) {
      return null;
    }

    const lines = trimmedContent.split('\n');
    const messages: KodaXMessage[] = [];
    let title = '', gitRoot = '';
    let errorMetadata: SessionErrorMetadata | undefined;
    let malformedCount = 0;

    for (let i = 0; i < lines.length; i++) {
      try {
        const data = JSON.parse(lines[i]!);
        if (i === 0 && isRecord(data) && data._type === 'meta') {
          title = typeof data.title === 'string' ? data.title : '';
          gitRoot = typeof data.gitRoot === 'string' ? data.gitRoot : '';
          errorMetadata = isSessionErrorMetadata(data.errorMetadata) ? data.errorMetadata : undefined;
          continue;
        }

        if (isKodaXMessage(data)) {
          messages.push(data);
        } else {
          malformedCount += 1;
        }
      } catch {
        malformedCount += 1;
      }
    }

    warnMalformedSessionData(filePath, malformedCount);

    const currentGitRoot = await getGitRoot();
    if (currentGitRoot && gitRoot && currentGitRoot !== gitRoot) {
      console.log(chalk.yellow(`\n[Warning] Session project mismatch:`));
      console.log(`  Current:  ${currentGitRoot}`);
      console.log(`  Session:  ${gitRoot}`);
      console.log(`  Continuing anyway...\n`);
    }

    // Phase 4: Session Recovery - Clean incomplete tool calls if needed
    if (errorMetadata?.consecutiveErrors && errorMetadata.consecutiveErrors > 0) {
      const cleaned = cleanupIncompleteToolCalls(messages);
      if (cleaned !== messages) {
        console.log(chalk.cyan('[Session Recovery] Cleaned incomplete tool calls from previous session'));
        // Reset error count and save cleaned session
        errorMetadata.consecutiveErrors = 0;
        await this.save(id, { messages: cleaned, title, gitRoot, errorMetadata });
        return { messages: cleaned, title, gitRoot, errorMetadata };
      }
    }

    return { messages, title, gitRoot, errorMetadata };
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
        if (isRecord(first) && first._type === 'meta') {
          const sessionGitRoot = typeof first.gitRoot === 'string' ? first.gitRoot : '';
          // Issue 071 fix: Strict project isolation for git projects
          // When in a git project, only show sessions with matching gitRoot
          // Sessions without gitRoot (legacy) are hidden to prevent cross-project confusion
          if (currentGitRoot) {
            if (!sessionGitRoot || sessionGitRoot !== currentGitRoot) continue;
          }
          // When not in a git project, show all sessions (user can choose)
          const lineCount = content.split('\n').length;
          sessions.push({
            id: f.replace('.jsonl', ''),
            title: typeof first.title === 'string' ? first.title : '',
            msgCount: lineCount - 1,
          });
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
