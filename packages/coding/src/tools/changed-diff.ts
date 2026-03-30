import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { KodaXToolExecutionContext } from '../types.js';
import { resolveExecutionCwd } from '../runtime-paths.js';
import { readOptionalString } from './internal.js';

const execFileAsync = promisify(execFile);
const DEFAULT_DIFF_LIMIT = 360;
const LARGE_DIFF_LIMIT = 480;
const MAX_DIFF_LIMIT = 800;
const DEFAULT_CONTEXT_LINES = 3;
const MAX_CONTEXT_LINES = 12;
const DEFAULT_BUNDLE_LIMIT_PER_PATH = 200;
const MAX_BUNDLE_PATHS = 10;
const GIT_TIMEOUT_MS = 10000;

async function runGit(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout.toString();
}

async function resolveWorkspaceRoot(baseDir: string): Promise<string> {
  try {
    const stdout = await runGit(['rev-parse', '--show-toplevel'], baseDir);
    const workspaceRoot = stdout.trim();
    if (!workspaceRoot) {
      throw new Error('git root not found');
    }
    return path.resolve(workspaceRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`changed_diff requires a git-backed workspace. ${message}`);
  }
}

async function resolveTargetDirectory(targetPath: string): Promise<string> {
  let currentPath = path.resolve(targetPath);
  while (true) {
    try {
      const stat = await fs.stat(currentPath);
      return stat.isDirectory() ? currentPath : path.dirname(currentPath);
    } catch {
      const parent = path.dirname(currentPath);
      if (parent === currentPath) {
        return targetPath;
      }
      currentPath = parent;
    }
  }
}

function readPositiveInteger(
  input: Record<string, unknown>,
  key: string,
  defaultValue: number,
  maximum: number,
): number {
  const rawValue = input[key];
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return defaultValue;
  }
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return Math.min(maximum, Math.floor(numeric));
}

function readStringArray(
  input: Record<string, unknown>,
  key: string,
): string[] {
  const rawValue = input[key];
  if (rawValue === undefined || rawValue === null) {
    return [];
  }
  if (Array.isArray(rawValue)) {
    return rawValue
      .map((value) => typeof value === 'string' ? value.trim() : '')
      .filter(Boolean);
  }
  if (typeof rawValue === 'string') {
    return rawValue
      .split(/[,\r\n]/)
      .map((value) => value.trim())
      .filter(Boolean);
  }
  throw new Error(`${key} must be an array of strings.`);
}

function resolveSuggestedContinuationLimit(
  currentLimit: number,
  totalLines: number,
): number {
  if (totalLines >= 2_000) {
    return Math.min(MAX_DIFF_LIMIT, Math.max(currentLimit, LARGE_DIFF_LIMIT));
  }
  if (totalLines >= 1_000) {
    return Math.min(MAX_DIFF_LIMIT, Math.max(currentLimit, DEFAULT_DIFF_LIMIT));
  }
  return currentLimit;
}

function normalizeDiffPath(candidatePath: string, workspaceRoot: string): string {
  const trimmed = candidatePath.trim();
  if (!trimmed) {
    throw new Error('path is required.');
  }

  const absolutePath = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(workspaceRoot, trimmed);
  const relativePath = path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
  if (!relativePath || relativePath.startsWith('..')) {
    throw new Error(`path must stay within the workspace root: ${workspaceRoot}`);
  }
  return relativePath;
}

function buildSyntheticAddedDiff(relativePath: string, fileContent: string): string {
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const bodyLines = fileContent.length > 0
    ? fileContent.replace(/\r\n/g, '\n').split('\n')
    : [];
  const hunkHeader = `@@ -0,0 +1,${Math.max(bodyLines.length, 1)} @@`;
  return [
    'diff --git a/dev/null b/' + normalizedPath,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${normalizedPath}`,
    hunkHeader,
    ...bodyLines.map((line) => `+${line}`),
  ].join('\n');
}

async function buildWorkspaceDiff(
  workspaceRoot: string,
  relativePath: string,
  contextLines: number,
): Promise<string> {
  for (const args of [
    ['diff', '--no-ext-diff', `--unified=${contextLines}`, 'HEAD', '--', relativePath],
    ['diff', '--no-ext-diff', `--unified=${contextLines}`, '--', relativePath],
  ]) {
    try {
      const diff = await runGit(args, workspaceRoot);
      if (diff.trim()) {
        return diff.trimEnd();
      }
    } catch {
      // Keep falling back so repos without HEAD can still expose worktree diffs.
    }
  }

  const statusOutput = await runGit(['status', '--porcelain=v1', '--untracked-files=all', '--', relativePath], workspaceRoot);
  const normalizedStatus = statusOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const isUntracked = normalizedStatus.some((line) => line.startsWith('??'));
  if (!isUntracked) {
    return '';
  }

  const absolutePath = path.join(workspaceRoot, relativePath);
  const fileContent = await fs.readFile(absolutePath, 'utf8');
  return buildSyntheticAddedDiff(relativePath, fileContent);
}

async function buildCompareDiff(
  workspaceRoot: string,
  relativePath: string,
  baseRef: string,
  targetRef: string | undefined,
  contextLines: number,
): Promise<string> {
  const range = targetRef?.trim()
    ? `${baseRef.trim()}...${targetRef.trim()}`
    : `${baseRef.trim()}...HEAD`;
  const diff = await runGit(
    ['diff', '--no-ext-diff', `--unified=${contextLines}`, range, '--', relativePath],
    workspaceRoot,
  );
  return diff.trimEnd();
}

function renderDiffSlice(options: {
  diff: string;
  relativePath: string;
  offset: number;
  limit: number;
  baseRef?: string;
  targetRef?: string;
  contextLines: number;
}): string {
  const { diff, relativePath, offset, limit, baseRef, targetRef, contextLines } = options;
  if (!diff.trim()) {
    return [
      `Changed diff for ${relativePath}`,
      `Context lines: ${contextLines}`,
      baseRef ? `Range: ${baseRef}...${targetRef?.trim() || 'HEAD'}` : 'Range: current workspace vs HEAD/worktree',
      '[No diff for the requested path.]',
    ].join('\n');
  }

  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  const safeOffset = Math.max(1, offset);
  const startIndex = safeOffset - 1;
  if (startIndex >= lines.length) {
    return `[Tool Error] Offset ${safeOffset} is beyond the diff length (${lines.length} lines total).`;
  }

  const slice = lines.slice(startIndex, startIndex + limit);
  const endLine = safeOffset + slice.length - 1;
  const hasMore = endLine < lines.length;
  const suggestedLimit = resolveSuggestedContinuationLimit(limit, lines.length);
  const header = [
    `Changed diff for ${relativePath}`,
    `Context lines: ${contextLines}`,
    baseRef ? `Range: ${baseRef}...${targetRef?.trim() || 'HEAD'}` : 'Range: current workspace vs HEAD/worktree',
    `Showing diff lines ${safeOffset}-${endLine} of ${lines.length}`,
  ];
  const footer = hasMore
    ? suggestedLimit > limit
      ? `[Large diff detected. Continue with changed_diff offset=${endLine + 1} limit=${suggestedLimit} path=${relativePath} to reduce serial paging.]`
      : `[Use changed_diff with offset=${endLine + 1} limit=${limit} path=${relativePath} to continue.]`
    : '[End of diff]';
  return [...header, '', ...slice, '', footer].join('\n');
}

function renderBundleSection(options: {
  diff: string;
  relativePath: string;
  offset: number;
  limit: number;
  baseRef?: string;
  targetRef?: string;
  contextLines: number;
}): string {
  const { diff, relativePath, offset, limit, baseRef, targetRef, contextLines } = options;
  const header = [
    `=== ${relativePath} ===`,
    `Context lines: ${contextLines}`,
    baseRef ? `Range: ${baseRef}...${targetRef?.trim() || 'HEAD'}` : 'Range: current workspace vs HEAD/worktree',
  ];

  if (!diff.trim()) {
    return [...header, '[No diff for the requested path.]'].join('\n');
  }

  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  const safeOffset = Math.max(1, offset);
  const startIndex = safeOffset - 1;
  if (startIndex >= lines.length) {
    return [...header, `[Tool Error] Offset ${safeOffset} is beyond the diff length (${lines.length} lines total).`].join('\n');
  }

  const slice = lines.slice(startIndex, startIndex + limit);
  const endLine = safeOffset + slice.length - 1;
  const hasMore = endLine < lines.length;
  const suggestedLimit = resolveSuggestedContinuationLimit(limit, lines.length);
  const footer = hasMore
    ? suggestedLimit > limit
      ? `[Large diff detected. Continue ${relativePath} with changed_diff path=${relativePath} offset=${endLine + 1} limit=${suggestedLimit}.]`
      : `[Continue ${relativePath} with changed_diff path=${relativePath} offset=${endLine + 1} limit=${limit}.]`
    : '[End of diff]';

  return [
    ...header,
    `Showing diff lines ${safeOffset}-${endLine} of ${lines.length}`,
    '',
    ...slice,
    '',
    footer,
  ].join('\n');
}

export async function toolChangedDiff(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const cwd = resolveExecutionCwd(ctx);
    const targetPath = readOptionalString(input, 'target_path');
    const baseDir = targetPath
      ? await resolveTargetDirectory(path.resolve(cwd, targetPath))
      : cwd;
    const workspaceRoot = await resolveWorkspaceRoot(baseDir);
    const rawPath = readOptionalString(input, 'path');
    if (!rawPath) {
      throw new Error('path must be provided.');
    }
    const relativePath = normalizeDiffPath(rawPath, workspaceRoot);
    const offset = readPositiveInteger(input, 'offset', 1, Number.MAX_SAFE_INTEGER);
    const limit = readPositiveInteger(input, 'limit', DEFAULT_DIFF_LIMIT, MAX_DIFF_LIMIT);
    const contextLines = readPositiveInteger(input, 'context_lines', DEFAULT_CONTEXT_LINES, MAX_CONTEXT_LINES);
    const baseRef = readOptionalString(input, 'base_ref');
    const targetRef = readOptionalString(input, 'target_ref');

    const diff = baseRef
      ? await buildCompareDiff(workspaceRoot, relativePath, baseRef, targetRef, contextLines)
      : await buildWorkspaceDiff(workspaceRoot, relativePath, contextLines);

    return renderDiffSlice({
      diff,
      relativePath,
      offset,
      limit,
      baseRef,
      targetRef,
      contextLines,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] changed_diff: ${message}`;
  }
}

export async function toolChangedDiffBundle(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const cwd = resolveExecutionCwd(ctx);
    const targetPath = readOptionalString(input, 'target_path');
    const baseDir = targetPath
      ? await resolveTargetDirectory(path.resolve(cwd, targetPath))
      : cwd;
    const workspaceRoot = await resolveWorkspaceRoot(baseDir);
    const rawPaths = readStringArray(input, 'paths');
    if (rawPaths.length === 0) {
      throw new Error('paths must contain at least one changed file path.');
    }

    const uniquePaths = Array.from(new Set(
      rawPaths
        .slice(0, MAX_BUNDLE_PATHS)
        .map((candidatePath) => normalizeDiffPath(candidatePath, workspaceRoot)),
    ));
    const offset = readPositiveInteger(input, 'offset', 1, Number.MAX_SAFE_INTEGER);
    const limitPerPath = readPositiveInteger(input, 'limit_per_path', DEFAULT_BUNDLE_LIMIT_PER_PATH, MAX_DIFF_LIMIT);
    const contextLines = readPositiveInteger(input, 'context_lines', DEFAULT_CONTEXT_LINES, MAX_CONTEXT_LINES);
    const baseRef = readOptionalString(input, 'base_ref');
    const targetRef = readOptionalString(input, 'target_ref');

    const sections = await Promise.all(uniquePaths.map(async (relativePath) => {
      const diff = baseRef
        ? await buildCompareDiff(workspaceRoot, relativePath, baseRef, targetRef, contextLines)
        : await buildWorkspaceDiff(workspaceRoot, relativePath, contextLines);
      return renderBundleSection({
        diff,
        relativePath,
        offset,
        limit: limitPerPath,
        baseRef,
        targetRef,
        contextLines,
      });
    }));

    return [
      `Changed diff bundle for ${uniquePaths.length} file(s)`,
      `Limit per path: ${limitPerPath}`,
      '',
      ...sections.flatMap((section, index) => index === 0 ? [section] : ['', section]),
      '',
      uniquePaths.length >= MAX_BUNDLE_PATHS && rawPaths.length > uniquePaths.length
        ? `[Additional paths omitted after ${MAX_BUNDLE_PATHS} entries. Re-run changed_diff_bundle with a narrower path batch.]`
        : '[Bundle complete]',
    ].join('\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] changed_diff_bundle: ${message}`;
  }
}
