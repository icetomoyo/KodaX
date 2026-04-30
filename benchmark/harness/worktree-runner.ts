/**
 * FEATURE_107 (v0.7.32) — Git-worktree isolation envelope for agent-level eval.
 *
 * Why this exists: FEATURE_107's H2 plan-execute boundary eval needs to run
 * the full KodaX task loop (Scout → Planner → Generator ↔ Evaluator) against
 * historical repo states without ever touching the live working tree. The
 * existing prompt-eval harness only fires single LLM calls and never writes
 * files, so it has no isolation requirement; this module adds the missing
 * filesystem boundary.
 *
 * Safety envelope (matches `docs/features/v0.7.32.md` §Eval 执行隔离):
 *   - Every case runs in `<TMP>/kodax-eval-<id>-<rand>/`
 *   - Worktree is `git worktree add` against the case's `gitHeadSha`
 *   - try/finally guarantees `git worktree remove --force` on exit
 *   - Startup scan detects orphaned `kodax-eval-*` worktrees from prior crashes
 *   - Verifies SHA reachability via `git cat-file -e` before adding
 *
 * Non-goals (intentional simplicity):
 *   - No KodaX runtime invocation here — that's `agent-task-runner.ts`
 *   - No transcript parsing — caller drives whatever subprocess they want
 *     inside the worktree and reads output back
 *   - No KODAX_HOME isolation — handled by callers via env override
 */

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const WORKTREE_PREFIX = 'kodax-eval-';

export interface WorktreeHandle {
  /** Absolute path to the worktree root (caller runs commands here). */
  readonly path: string;
  /** Identifier the worktree was created with — useful for log lines. */
  readonly id: string;
  /** SHA the worktree is checked out at (HEAD if no SHA was given). */
  readonly sha: string;
}

export interface SetupOptions {
  /** Stable identifier (e.g., case id). Combined with random suffix to
   * avoid collisions when the same case runs concurrently. */
  readonly id: string;
  /** Repo root the worktree is being added from. Defaults to `cwd`. */
  readonly repoRoot?: string;
  /** Pin the worktree to this SHA. `null` / undefined → use current HEAD. */
  readonly sha?: string | null;
  /** Override tmpdir base (default: `os.tmpdir()`). Test seam. */
  readonly tmpRoot?: string;
}

/**
 * Verify the SHA exists in the local object database. Returns the resolved
 * full SHA on success; throws otherwise. Per §Eval 执行隔离: case is skipped
 * (not faked) when SHA is unreachable.
 */
async function assertShaReachable(repoRoot: string, sha: string): Promise<string> {
  try {
    await execFileAsync('git', ['cat-file', '-e', sha], { cwd: repoRoot });
  } catch {
    throw new Error(
      `worktree-runner: gitHeadSha '${sha}' not reachable in '${repoRoot}'. ` +
        'Skip the case rather than substituting another SHA.',
    );
  }
  const { stdout } = await execFileAsync('git', ['rev-parse', sha], {
    cwd: repoRoot,
  });
  return stdout.trim();
}

async function resolveHead(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
  });
  return stdout.trim();
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Create an isolated git worktree for a single eval case. Returns a handle
 * the caller passes to subprocess invocations. Caller MUST `await
 * cleanupWorktree(handle)` in `finally`; or use `runInWorktree` which does
 * that for them.
 */
export async function setupWorktree(opts: SetupOptions): Promise<WorktreeHandle> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const tmpRoot = opts.tmpRoot ?? tmpdir();
  const sha = opts.sha
    ? await assertShaReachable(repoRoot, opts.sha)
    : await resolveHead(repoRoot);

  const dirName = `${WORKTREE_PREFIX}${opts.id}-${randomSuffix()}`;
  const worktreePath = path.join(tmpRoot, dirName);

  // `--detach` so the worktree isn't bound to a branch — eval is read-only
  // from VCS perspective and we never want to push back. `--force` to
  // tolerate an existing leftover dir from a crashed prior run with the
  // exact same suffix (improbable but cheap).
  await execFileAsync(
    'git',
    ['worktree', 'add', '--detach', '--force', worktreePath, sha],
    { cwd: repoRoot },
  );

  return { path: worktreePath, id: opts.id, sha };
}

/**
 * Remove a worktree. Idempotent: if the worktree is already gone, succeeds
 * silently. Uses `--force` because eval subprocesses may have left write
 * locks on Windows.
 */
export async function cleanupWorktree(
  handle: WorktreeHandle,
  opts: { repoRoot?: string } = {},
): Promise<void> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  try {
    await execFileAsync(
      'git',
      ['worktree', 'remove', '--force', handle.path],
      { cwd: repoRoot },
    );
  } catch {
    // git may have already lost track of the worktree (e.g. user manually
    // deleted the dir) — fall through to filesystem cleanup.
  }
  try {
    await fs.rm(handle.path, { recursive: true, force: true });
  } catch {
    // best-effort; orphan-scan will catch persistent leaks.
  }
  try {
    await execFileAsync('git', ['worktree', 'prune'], { cwd: repoRoot });
  } catch {
    // prune failure is non-fatal; tracked worktree list will catch up later.
  }
}

/**
 * Convenience wrapper: setup + run user fn + always cleanup. The fn receives
 * the WorktreeHandle so it can spawn subprocesses with `cwd: handle.path`.
 */
export async function runInWorktree<T>(
  opts: SetupOptions,
  fn: (handle: WorktreeHandle) => Promise<T>,
): Promise<T> {
  const handle = await setupWorktree(opts);
  try {
    return await fn(handle);
  } finally {
    await cleanupWorktree(handle, { repoRoot: opts.repoRoot });
  }
}

export interface OrphanScanResult {
  readonly removed: readonly string[];
  readonly failed: readonly { path: string; error: string }[];
}

/**
 * Scan tmpdir for orphaned `kodax-eval-*` worktrees from crashed prior runs
 * and remove them. Run this at harness startup. Returns what was cleaned up
 * so the caller can log a summary.
 *
 * Conservative: only matches the exact prefix; never touches dirs the
 * harness didn't create. Per §Release 硬条件 — leak rate ≤ 1%.
 */
export async function scanAndCleanOrphanWorktrees(opts: {
  repoRoot?: string;
  tmpRoot?: string;
} = {}): Promise<OrphanScanResult> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const tmpRoot = opts.tmpRoot ?? tmpdir();
  const removed: string[] = [];
  const failed: { path: string; error: string }[] = [];

  let entries: string[];
  try {
    entries = await fs.readdir(tmpRoot);
  } catch (e) {
    return { removed, failed: [{ path: tmpRoot, error: String(e) }] };
  }

  for (const entry of entries) {
    if (!entry.startsWith(WORKTREE_PREFIX)) continue;
    const orphanPath = path.join(tmpRoot, entry);
    try {
      // Try git's view first so its admin metadata gets cleaned too.
      await execFileAsync(
        'git',
        ['worktree', 'remove', '--force', orphanPath],
        { cwd: repoRoot },
      ).catch(() => undefined);
      await fs.rm(orphanPath, { recursive: true, force: true });
      removed.push(orphanPath);
    } catch (e) {
      failed.push({ path: orphanPath, error: String(e) });
    }
  }

  // One prune at end so git's worktree list reflects reality.
  await execFileAsync('git', ['worktree', 'prune'], { cwd: repoRoot }).catch(
    () => undefined,
  );

  return { removed, failed };
}

/**
 * Confirm running an eval inside `handle.path` did not move the primary
 * repo's HEAD. Per Release Criteria: "0 个 case 执行污染主仓 ... git log head
 * 无变化". Caller snapshots HEAD before any eval starts and passes it here
 * after each case (or at end of run). Working-tree dirty state is excluded
 * because users may have pre-existing dirty files unrelated to eval.
 */
export async function assertPrimaryHeadUnchanged(opts: {
  repoRoot?: string;
  expectedHeadAtStart: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const head = await resolveHead(repoRoot);
  if (head !== opts.expectedHeadAtStart) {
    return {
      ok: false,
      reason: `Primary repo HEAD changed from ${opts.expectedHeadAtStart} to ${head}`,
    };
  }
  return { ok: true };
}
