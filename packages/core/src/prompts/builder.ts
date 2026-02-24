/**
 * KodaX Prompt Builder
 *
 * 系统提示词构建器
 */

import fsSync from 'fs';
import path from 'path';
import { KodaXOptions } from '../types.js';
import { KODAX_FEATURES_FILE, KODAX_PROGRESS_FILE } from '../constants.js';
import { SYSTEM_PROMPT } from './system.js';
import { LONG_RUNNING_PROMPT } from './long-running.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * 构建系统提示词
 */
export async function buildSystemPrompt(options: KodaXOptions, isNewSession: boolean): Promise<string> {
  const contextParts: string[] = [];

  contextParts.push(getEnvContext());
  contextParts.push(`Working Directory: ${process.cwd()}`);

  if (isNewSession) {
    const gitCtx = await getGitContext();
    if (gitCtx) contextParts.push(gitCtx);

    const snapshot = await getProjectSnapshot();
    if (snapshot) contextParts.push(snapshot);
  }

  const isLongRunning = fsSync.existsSync(path.resolve(KODAX_FEATURES_FILE)) && !options.context?.longRunning;
  if (isLongRunning) {
    const longCtx = await getLongRunningContext();
    if (longCtx) contextParts.push(longCtx);
  }

  let prompt = SYSTEM_PROMPT.replace('{context}', contextParts.join('\n\n'));

  if (isLongRunning) {
    prompt += LONG_RUNNING_PROMPT;
  }

  return prompt;
}

/**
 * 获取环境上下文
 */
function getEnvContext(): string {
  const p = process.platform;
  const isWin = p === 'win32';
  const cmdHint = isWin
    ? 'Use: dir, move, copy, del'
    : 'Use: ls, mv, cp, rm';
  return `Platform: ${isWin ? 'Windows' : p === 'darwin' ? 'macOS' : 'Linux'}\n${cmdHint}\nNode: ${process.version}`;
}

/**
 * 获取 Git 上下文
 */
async function getGitContext(): Promise<string> {
  try {
    const { stdout: check } = await execAsync('git rev-parse --is-inside-work-tree');
    if (!check.trim()) return '';

    const lines: string[] = [];

    try {
      const { stdout: branch } = await execAsync('git branch --show-current');
      if (branch.trim()) lines.push(`Git Branch: ${branch.trim()}`);
    } catch { }

    try {
      const { stdout: status } = await execAsync('git status --short');
      if (status.trim()) {
        const statusLines = status.trim().split('\n').slice(0, 10);
        lines.push(`Git Status:\n` + statusLines.map((s: string) => `  ${s}`).join('\n'));
        const totalLines = status.trim().split('\n').length;
        if (totalLines > 10) lines.push('  ... (more changes)');
      }
    } catch { }

    return lines.join('\n');
  } catch { return ''; }
}

/**
 * 获取项目快照
 */
async function getProjectSnapshot(maxDepth = 2, maxFiles = 50): Promise<string> {
  const fs = await import('fs/promises');
  const ignoreDirs = new Set(['.git', '__pycache__', 'node_modules', '.venv', 'venv', 'dist', 'build', '.idea', '.vscode']);
  const ignoreExts = new Set(['.pyc', '.pyo', '.so', '.dll', '.exe', '.bin']);
  const cwd = process.cwd();
  const lines = [`Project: ${path.basename(cwd)}`];
  let fileCount = 0;

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth || fileCount >= maxFiles) return;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const dirs: string[] = [];
      const files: string[] = [];
      for (const e of entries) {
        if (e.isDirectory() && !ignoreDirs.has(e.name) && !e.name.startsWith('.')) dirs.push(e.name);
        else if (e.isFile() && !ignoreExts.has(path.extname(e.name))) files.push(e.name);
      }
      const indent = '  '.repeat(depth);
      const rel = path.relative(cwd, dir);
      if (rel && rel !== '.') lines.push(`${indent}${rel}/`);
      for (const f of files.sort().slice(0, 20)) {
        lines.push(`${indent}  ${f}`);
        fileCount++;
        if (fileCount >= maxFiles) { lines.push('  ... (more files)'); return; }
      }
      for (const d of dirs.sort()) await walk(path.join(dir, d), depth + 1);
    } catch { }
  }

  await walk(cwd, 0);
  return lines.join('\n');
}

/**
 * 获取长运行任务上下文
 */
async function getLongRunningContext(): Promise<string> {
  const fs = await import('fs/promises');
  const parts: string[] = [];
  const featuresPath = path.resolve(KODAX_FEATURES_FILE);
  if (fsSync.existsSync(featuresPath)) {
    try {
      const features = JSON.parse(await fs.readFile(featuresPath, 'utf-8'));
      parts.push('## Feature List (from feature_list.json)\n');
      for (const f of features.features ?? []) {
        const status = f.passes ? '[x]' : '[ ]';
        const desc = f.description ?? f.name ?? 'Unknown';
        parts.push(`- ${status} ${desc}`);
      }
    } catch { }
  }
  const progressPath = path.resolve(KODAX_PROGRESS_FILE);
  if (fsSync.existsSync(progressPath)) {
    try {
      const progress = await fs.readFile(progressPath, 'utf-8');
      if (progress.trim()) parts.push(`\n## Last Session Progress (from PROGRESS.md)\n\n${progress.slice(0, 1500)}`);
    } catch { }
  }
  return parts.join('\n');
}
