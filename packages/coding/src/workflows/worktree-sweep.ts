/** Workflow worktree maintenance. The owning Host supplies settlement and
 * durable-reference checks before reclaiming this run's clean temporary trees.
 * Staleness alone is diagnostic; unknown or referenced work remains intact.
 */

import { execFile } from 'node:child_process';
import { assertNoGitInstallPrompt } from '@kodax-ai/agent';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { hasGenerationWorktree } from '../worktree-generation.js';
import { writeWorkflowJson } from './persistence.js';
import { isWorkflowProjectProtected, withWorkflowWorktreeProtection } from './project-protection.js';

const execFileAsync = promisify(execFile);

/** Per-run home for workflow child worktrees, beside the run graph. */
export function workflowWorktreeBaseDir(runDir: string): string {
  return join(runDir, 'worktrees');
}

/** Default staleness window for the compatibility diagnostic. */
export const DEFAULT_STALE_WORKTREE_MS = 6 * 60 * 60 * 1000;

export interface WorktreeSweepDeps {
  /** Run a git subcommand from `cwd`, resolving stdout. Defaults to `execFile`. */
  readonly runGit?: (args: readonly string[], cwd: string) => Promise<string>;
  /** Worktree directory mtime in ms. Defaults to `statSync`. Layer 3 only. */
  readonly mtimeMs?: (path: string) => number;
  /** Clock for staleness comparison. Defaults to `Date.now`. Layer 3 only. */
  readonly now?: () => number;
}

export interface WorktreeSweepResult {
  readonly removed: readonly string[];
  readonly warnings: readonly string[];
}

interface WorktreeEntry {
  readonly path: string;
  readonly branch?: string;
  readonly oid?: string;
}

interface BranchCleanup {
  readonly path: string;
  readonly branch: string;
  readonly oid: string;
}

async function defaultRunGit(args: readonly string[], cwd: string): Promise<string> {
  await assertNoGitInstallPrompt({ cwd });
  return execFileAsync('git', [...args], { cwd, windowsHide: true }).then((r) => r.stdout);
}

function defaultMtimeMs(path: string): number {
  return statSync(path).mtimeMs;
}

/** Parse `git worktree list --porcelain` into `{ path, branch }` entries. */
function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let path: string | undefined;
  let branch: string | undefined;
  let oid: string | undefined;
  const flush = (): void => {
    if (path) entries.push({ path, ...(branch ? { branch } : {}), ...(oid ? { oid } : {}) });
    path = undefined;
    branch = undefined;
    oid = undefined;
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      flush();
      path = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line.startsWith('HEAD ')) {
      oid = line.slice('HEAD '.length).trim();
    }
  }
  flush();
  return entries;
}

function branchReceipt(baseDir: string, entry: BranchCleanup): string {
  return join(baseDir, '.branch-cleanups', `${createHash('sha256').update(`${entry.path}\0${entry.branch}`).digest('hex')}.json`);
}

/** The old OID is an ownership fence, never permission to delete a replacement. */
async function removeRecordedBranch(entry: BranchCleanup, file: string, gitRoot: string,
  runGit: (args: readonly string[], cwd: string) => Promise<string>, warnings: string[]): Promise<void> {
  if (isWorkflowProjectProtected(entry.path)) {
    warnings.push(`retain ${entry.path}: referenced by durable Workflow evidence`);
    return;
  }
  try {
    let current: string;
    try { current = (await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${entry.branch}`], gitRoot)).trim(); }
    catch (error: unknown) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 1) throw error;
      current = '';
    }
    if (!current) { rmSync(file, { force: true }); return; }
    if (current !== entry.oid) {
      warnings.push(`retain branch ${entry.branch}: branch revision changed`);
      rmSync(file, { force: true });
      return;
    }
    const worktrees = await listWorktrees(gitRoot, runGit, warnings);
    if (!worktrees) return;
    if (worktrees.some(tree => tree.branch === entry.branch)) {
      // A failed worktree removal still owns its pending receipt.
      if (worktrees.some(tree => tree.branch === entry.branch && normalize(tree.path) !== normalize(entry.path))) {
        warnings.push(`retain branch ${entry.branch}: branch is protected by a current worktree`);
        rmSync(file, { force: true });
      }
      return;
    }
    await runGit(['update-ref', '-d', `refs/heads/${entry.branch}`, entry.oid], gitRoot);
    rmSync(file, { force: true });
  } catch (error: unknown) {
    warnings.push(`remove branch ${entry.branch}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Normalize path separators so prefix checks work across win32 / posix. */
function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function isUnder(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);
  return c === p || c.startsWith(`${p}/`);
}

async function worktreeHasChanges(
  entry: WorktreeEntry,
  projectCommit: string,
  runGit: (args: readonly string[], cwd: string) => Promise<string>,
  warnings: string[],
): Promise<boolean> {
  try {
    const status = await runGit(['status', '--porcelain'], entry.path);
    const uncommittedFiles = status
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .length;
    const revList = await runGit(['rev-list', '--count', 'HEAD', '--not', projectCommit, '--remotes'], entry.path);
    const localCommits = Number.parseInt(revList.trim(), 10) || 0;
    return uncommittedFiles > 0 || localCommits > 0;
  } catch (error) {
    warnings.push(
      `retain ${entry.path}: cannot verify worktree cleanliness: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return true;
  }
}

/** Remove one clean worktree + its ephemeral branch. Collects, never throws. */
async function removeWorktree(
  entry: WorktreeEntry,
  baseDir: string,
  gitRoot: string,
  projectCommit: string,
  runGit: (args: readonly string[], cwd: string) => Promise<string>,
  removed: string[],
  warnings: string[],
): Promise<void> {
  if (isWorkflowProjectProtected(entry.path)) {
    warnings.push(`retain ${entry.path}: referenced by durable Workflow evidence`);
    return;
  }
  if (hasGenerationWorktree(entry.path)) {
    warnings.push(`retain ${entry.path}: generation recovery checkpoint owns this worktree`);
    return;
  }
  if (await worktreeHasChanges(entry, projectCommit, runGit, warnings)) {
    warnings.push(`retain ${entry.path}: worktree has unmerged changes`);
    return;
  }
  try {
    let receipt: BranchCleanup | undefined;
    let file: string | undefined;
    if (entry.branch) {
      if (!entry.oid || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(entry.oid)) throw new Error('Workflow branch has no verified original OID.');
      receipt = { path: entry.path, branch: entry.branch, oid: entry.oid };
      file = branchReceipt(baseDir, receipt);
      mkdirSync(join(baseDir, '.branch-cleanups'), { recursive: true });
      writeWorkflowJson(file, { version: 1, ...receipt });
    }
    await runGit(['worktree', 'remove', entry.path, '--force'], gitRoot);
    removed.push(entry.path);
    if (receipt && file) await removeRecordedBranch(receipt, file, gitRoot, runGit, warnings);
  } catch (error) {
    warnings.push(`remove ${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
}

async function listWorktrees(
  gitRoot: string,
  runGit: (args: readonly string[], cwd: string) => Promise<string>,
  warnings: string[],
): Promise<WorktreeEntry[] | undefined> {
  try {
    const stdout = await runGit(['worktree', 'list', '--porcelain'], gitRoot);
    return parseWorktreeList(stdout);
  } catch (error) {
    warnings.push(`list worktrees: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Layer 2 — remove every registered worktree under one run's base dir.
 * Run at workflow terminal (success / failure / cancel). No-op without gitRoot.
 */
export async function sweepWorkflowRunWorktrees(
  opts: { readonly baseDir: string; readonly gitRoot?: string; readonly isReferenced?: (path: string) => boolean },
  deps: WorktreeSweepDeps = {},
): Promise<WorktreeSweepResult> {
  const warnings: string[] = [];
  const removed: string[] = [];
  if (!opts.gitRoot) return { removed, warnings };
  const runGit = deps.runGit ?? defaultRunGit;

  const entries = await listWorktrees(opts.gitRoot, runGit, warnings);
  if (!entries) return { removed, warnings };
  const receipts = join(opts.baseDir, '.branch-cleanups');
  const pendingBranches = existsSync(receipts) ? readdirSync(receipts) : [];
  let projectCommit: string | undefined;

  for (const entry of entries) {
    if (isUnder(entry.path, opts.baseDir)) {
      if (opts.isReferenced?.(entry.path)) {
        warnings.push(`retain ${entry.path}: referenced by durable Workflow evidence`);
        continue;
      }
      try {
        projectCommit ??= (await runGit(['rev-parse', 'HEAD'], opts.gitRoot)).trim();
      } catch (error: unknown) {
        warnings.push(`retain ${entry.path}: project commit is unavailable: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      try {
        await withWorkflowWorktreeProtection(entry.path,
          () => removeWorktree(entry, opts.baseDir, opts.gitRoot!, projectCommit!, runGit, removed, warnings));
      } catch (error: unknown) {
        warnings.push(`remove ${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  for (const name of pendingBranches) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const file = join(receipts, name);
    if (!existsSync(file)) continue;
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1
        || !('path' in value) || typeof value.path !== 'string' || !isUnder(value.path, opts.baseDir)
        || !('branch' in value) || typeof value.branch !== 'string' || !value.branch
        || !('oid' in value) || typeof value.oid !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.oid)) {
        throw new Error('Invalid Workflow branch cleanup receipt.');
      }
      const entry: BranchCleanup = { path: value.path, branch: value.branch, oid: value.oid };
      if (branchReceipt(opts.baseDir, entry) !== file) throw new Error('Workflow branch cleanup receipt identity mismatch.');
      await withWorkflowWorktreeProtection(entry.path, () => removeRecordedBranch(entry, file, opts.gitRoot!, runGit, warnings));
    } catch (error: unknown) {
      warnings.push(`Workflow branch cleanup retained ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try { rmdirSync(receipts); }
  catch (error: unknown) {
    if (typeof error !== 'object' || error === null || !('code' in error)
      || !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String(error.code))) {
      warnings.push(`Workflow branch cleanup directory retained: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { removed, warnings };
}

/**
 * Compatibility diagnostic for stale worktrees. Age cannot establish owner
 * settlement; only the owning Host's confirmed cleanup can remove them.
 */
export async function pruneStaleWorkflowWorktrees(
  opts: {
    readonly workflowRunsRoot: string;
    readonly gitRoot?: string;
    readonly maxAgeMs?: number;
  },
  deps: WorktreeSweepDeps = {},
): Promise<WorktreeSweepResult> {
  const warnings: string[] = [];
  const removed: string[] = [];
  if (!opts.gitRoot) return { removed, warnings };
  const runGit = deps.runGit ?? defaultRunGit;
  const mtimeMs = deps.mtimeMs ?? defaultMtimeMs;
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_STALE_WORKTREE_MS;

  const entries = await listWorktrees(opts.gitRoot, runGit, warnings);
  if (!entries) return { removed, warnings };

  for (const entry of entries) {
    if (!isUnder(entry.path, opts.workflowRunsRoot)) continue;
    let age: number;
    try {
      age = now() - mtimeMs(entry.path);
    } catch {
      // Missing paths cannot establish ownership or safe cleanup.
      continue;
    }
    if (age >= maxAgeMs) {
      warnings.push(`retain ${entry.path}: owner settlement is not confirmed`);
    }
  }
  return { removed, warnings };
}
