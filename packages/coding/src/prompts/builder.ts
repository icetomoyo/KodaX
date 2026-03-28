/**
 * KodaX Prompt Builder
 *
 * 系统提示词构建器
 */

import fsSync from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { KODAX_FEATURES_FILE, KODAX_PROGRESS_FILE } from '../constants.js';
import { loadAgentsFiles, formatAgentsForPrompt } from '../context/agents-loader.js';
import { resolveExecutionCwd } from '../runtime-paths.js';
import { KodaXOptions } from '../types.js';
import { LONG_RUNNING_PROMPT } from './long-running.js';
import { SYSTEM_PROMPT } from './system.js';

const execAsync = promisify(exec);

/**
 * 构建系统提示词
 */
export async function buildSystemPrompt(options: KodaXOptions, isNewSession: boolean): Promise<string> {
  const contextParts: string[] = [];
  const executionCwd = resolveExecutionCwd(options.context);
  const projectRoot = options.context?.gitRoot ? path.resolve(options.context.gitRoot) : executionCwd;

  contextParts.push(getEnvContext());
  contextParts.push(`Working Directory: ${executionCwd}`);

  // Permission mode context removed - now handled by REPL layer
  // 权限模式上下文已移除，现由 REPL 层处理

  if (isNewSession) {
    const gitCtx = await getGitContext(executionCwd);
    if (gitCtx) contextParts.push(gitCtx);

    const snapshot = await getProjectSnapshot(executionCwd);
    if (snapshot) contextParts.push(snapshot);
  }

  const isLongRunning =
    fsSync.existsSync(path.resolve(projectRoot, KODAX_FEATURES_FILE)) &&
    !options.context?.longRunning;
  if (isLongRunning) {
    const longCtx = await getLongRunningContext(projectRoot);
    if (longCtx) contextParts.push(longCtx);
  }

  if (options.context?.repoIntelligenceContext) {
    contextParts.push(options.context.repoIntelligenceContext);
  }

  let prompt = SYSTEM_PROMPT.replace('{context}', contextParts.join('\n\n'));

  if (isLongRunning) {
    prompt += LONG_RUNNING_PROMPT;
  }

  // Append skills prompt for progressive disclosure (Issue 056)
  // 追加 skills 提示词，支持按需渐进披露
  if (options.context?.skillsPrompt) {
    prompt += '\n\n' + options.context.skillsPrompt;
  }

  if (options.context?.promptOverlay) {
    prompt += '\n\n' + options.context.promptOverlay;
  }

  // Append AGENTS.md content (Feature 020)
  const agentsFiles = loadAgentsFiles({
    cwd: executionCwd,
    projectRoot: options.context?.gitRoot ?? undefined,
  });
  const agentsContent = formatAgentsForPrompt(agentsFiles);
  if (agentsContent) {
    prompt += agentsContent;
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
async function getGitContext(cwd: string): Promise<string> {
  try {
    const { stdout: check } = await execAsync('git rev-parse --is-inside-work-tree', { cwd });
    if (!check.trim()) return '';

    const lines: string[] = [];

    try {
      const { stdout: branch } = await execAsync('git branch --show-current', { cwd });
      if (branch.trim()) lines.push(`Git Branch: ${branch.trim()}`);
    } catch {}

    try {
      const { stdout: status } = await execAsync('git status --short', { cwd });
      if (status.trim()) {
        const statusLines = status.trim().split('\n').slice(0, 10);
        lines.push(`Git Status:\n` + statusLines.map((s: string) => `  ${s}`).join('\n'));
        const totalLines = status.trim().split('\n').length;
        if (totalLines > 10) lines.push('  ... (more changes)');
      }
    } catch {}

    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * 获取项目快照
 */
async function getProjectSnapshot(cwd: string, maxDepth = 2, maxFiles = 50): Promise<string> {
  const fs = await import('fs/promises');
  const ignoreDirs = new Set(['.git', '__pycache__', 'node_modules', '.venv', 'venv', 'dist', 'build', '.idea', '.vscode']);
  const ignoreExts = new Set(['.pyc', '.pyo', '.so', '.dll', '.exe', '.bin']);
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
        if (fileCount >= maxFiles) {
          lines.push('  ... (more files)');
          return;
        }
      }
      for (const d of dirs.sort()) await walk(path.join(dir, d), depth + 1);
    } catch {}
  }

  await walk(cwd, 0);
  return lines.join('\n');
}

/**
 * 获取长任务上下文
 */
async function getLongRunningContext(cwd: string): Promise<string> {
  const fs = await import('fs/promises');
  const parts: string[] = [];
  const featuresPath = path.resolve(cwd, KODAX_FEATURES_FILE);
  if (fsSync.existsSync(featuresPath)) {
    try {
      const features = JSON.parse(await fs.readFile(featuresPath, 'utf-8'));
      parts.push('## Feature List (from feature_list.json)\n');
      for (const f of features.features ?? []) {
        const status = f.passes ? '[x]' : '[ ]';
        const desc = f.description ?? f.name ?? 'Unknown';
        parts.push(`- ${status} ${desc}`);
      }
    } catch {}
  }
  const progressPath = path.resolve(cwd, KODAX_PROGRESS_FILE);
  if (fsSync.existsSync(progressPath)) {
    try {
      const progress = await fs.readFile(progressPath, 'utf-8');
      if (progress.trim()) parts.push(`\n## Last Session Progress (from PROGRESS.md)\n\n${progress.slice(0, 1500)}`);
    } catch {}
  }
  return parts.join('\n');
}
