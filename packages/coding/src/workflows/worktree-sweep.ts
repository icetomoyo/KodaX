/**
 * FEATURE_217 (v0.7.49) — Workflow worktree sweep + GC.
 *
 * Workflow children launched with `isolation:'worktree'` get a dedicated git
 * worktree under `<runDir>/worktrees/` (see `workflowWorktreeBaseDir`). Three
 * layers reclaim them so an interrupted / killed run does not leak worktrees
 * into the user's project tree (the original FEATURE_217 leak):
 *
 *   - Layer 1 (per-child `finally`, in `child-executor.ts`) removes each
 *     worktree as its child settles.
 *   - Layer 2 (`sweepWorkflowRunWorktrees`) runs at workflow terminal and
 *     force-removes any worktree still registered under one run's base dir —
 *     covering aborted / cancelled / spawn-without-wait children that never
 *     reached their per-child cleanup.
 *   - Layer 3 (`pruneStaleWorkflowWorktrees`) runs at workflow startup and
 *     reclaims worktrees left behind by a hard process kill (SIGKILL / power
 *     loss) where neither in-process layer could run.
 *
 * Both sweep functions are fail-soft: every git failure is collected as a
 * warning, never thrown, so worktree reclamation can never break a workflow.
 * git access + filesystem mtime are injected so the logic is unit-testable
 * without a real repository.
 */

import { execFile } from 'node:child_process';
import { assertNoGitInstallPrompt } from '@kodax-ai/agent';
import { promisify } from 'node:util';
import { statSync } from 'node:fs';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

/** Per-run home for workflow child worktrees, beside the run graph. */
export function workflowWorktreeBaseDir(runDir: string): string {
  return join(runDir, 'worktrees');
}

/** Default Layer 3 staleness window: worktrees older than this are reclaimed. */
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
  const flush = (): void => {
    if (path) entries.push(branch ? { path, branch } : { path });
    path = undefined;
    branch = undefined;
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      flush();
      path = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
  }
  flush();
  return entries;
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
  runGit: (args: readonly string[], cwd: string) => Promise<string>,
  warnings: string[],
): Promise<boolean> {
  try {
    const status = await runGit(['status', '--porcelain'], entry.path);
    const uncommittedFiles = status
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .length;
    const revList = await runGit(['rev-list', '--count', 'HEAD', '--not', '--remotes'], entry.path);
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
  gitRoot: string,
  runGit: (args: readonly string[], cwd: string) => Promise<string>,
  removed: string[],
  warnings: string[],
): Promise<void> {
  if (await worktreeHasChanges(entry, runGit, warnings)) {
    warnings.push(`retain ${entry.path}: worktree has unmerged changes`);
    return;
  }
  try {
    await runGit(['worktree', 'remove', entry.path, '--force'], gitRoot);
    removed.push(entry.path);
  } catch (error) {
    warnings.push(`remove ${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (entry.branch) {
    try {
      await runGit(['branch', '-D', entry.branch], gitRoot);
    } catch {
      // Branch may be checked out elsewhere or already gone; ignore.
    }
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

async function prune(
  gitRoot: string,
  runGit: (args: readonly string[], cwd: string) => Promise<string>,
  warnings: string[],
): Promise<void> {
  try {
    await runGit(['worktree', 'prune'], gitRoot);
  } catch (error) {
    warnings.push(`prune: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Layer 2 — remove every registered worktree under one run's base dir.
 * Run at workflow terminal (success / failure / cancel). No-op without gitRoot.
 */
export async function sweepWorkflowRunWorktrees(
  opts: { readonly baseDir: string; readonly gitRoot?: string },
  deps: WorktreeSweepDeps = {},
): Promise<WorktreeSweepResult> {
  const warnings: string[] = [];
  const removed: string[] = [];
  if (!opts.gitRoot) return { removed, warnings };
  const runGit = deps.runGit ?? defaultRunGit;

  const entries = await listWorktrees(opts.gitRoot, runGit, warnings);
  if (!entries) return { removed, warnings };

  for (const entry of entries) {
    if (isUnder(entry.path, opts.baseDir)) {
      await removeWorktree(entry, opts.gitRoot, runGit, removed, warnings);
    }
  }
  if (removed.length > 0) await prune(opts.gitRoot, runGit, warnings);
  return { removed, warnings };
}

/**
 * Layer 3 — reclaim stale worktrees under a project's workflow-runs root.
 * Run at workflow startup. Only removes worktrees older than `maxAgeMs`
 * (default 6h) so a concurrently-running workflow's worktrees are never
 * touched. No-op without gitRoot.
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

  // `git worktree prune` first drops admin entries whose dir already vanished.
  await prune(opts.gitRoot, runGit, warnings);

  const entries = await listWorktrees(opts.gitRoot, runGit, warnings);
  if (!entries) return { removed, warnings };

  for (const entry of entries) {
    if (!isUnder(entry.path, opts.workflowRunsRoot)) continue;
    let age: number;
    try {
      age = now() - mtimeMs(entry.path);
    } catch {
      // Directory is gone but still registered — let `prune` handle it.
      continue;
    }
    if (age >= maxAgeMs) {
      await removeWorktree(entry, opts.gitRoot, runGit, removed, warnings);
    }
  }
  if (removed.length > 0) await prune(opts.gitRoot, runGit, warnings);
  return { removed, warnings };
}
