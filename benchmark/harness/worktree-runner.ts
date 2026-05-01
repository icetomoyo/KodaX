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
  /**
   * Seed `node_modules` from `repoRoot` into the worktree after creation so
   * the spawned agent can run tests / build without redoing `npm install`.
   * Defaults to false to keep the helper general-purpose; FEATURE_107 eval
   * passes `true` because cases that ask the agent to "verify with tests"
   * burn the timeout cycling through pnpm/npm install attempts otherwise.
   *
   * Implementation: copies node_modules (root + monorepo packages/*).
   * Measured ~28s on Windows for the 150 MB / 10k-file KodaX tree (2026-05-01,
   * SSD). Earlier symlink-based seeding was faster (~0s) but leaked: an agent
   * that ran `npm install <pkg>` inside a worktree would mutate the primary
   * repo's node_modules through the symlink. Copy fully isolates each cell
   * at the cost of ~190 MB / cell peak disk during execution; cleanup at
   * worktree teardown reclaims it.
   */
  readonly seedNodeModules?: boolean;
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

  if (opts.seedNodeModules) {
    await seedNodeModulesIntoWorktree(repoRoot, worktreePath);
  }

  return { path: worktreePath, id: opts.id, sha };
}

/**
 * Copy node_modules from primary repo into the worktree (root + monorepo
 * packages/* so workspaces are covered).
 *
 * Why copy instead of symlink: a symlinked node_modules works for read but
 * leaks under write — an agent that runs `npm install <pkg>` writes through
 * the symlink and pollutes the primary repo's node_modules. Copy gives full
 * isolation at the cost of ~28s setup + 190 MB / worktree disk.
 *
 * Why not `npm ci` per worktree: 60-180s per cell with network + cache
 * misses, vs ~28s for a local fs copy from a warm tree.
 *
 * Symlink edge cases preserved: `dereference: false` keeps the relative
 * symlinks inside node_modules (e.g. `.bin/*` shims) so they resolve inside
 * the worktree without needing to follow them at copy time.
 */
async function seedNodeModulesIntoWorktree(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  const candidates = ['node_modules'];
  // Also seed monorepo package node_modules if present (workspaces split deps).
  try {
    const packagesDir = path.join(repoRoot, 'packages');
    const stat = await fs.stat(packagesDir);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(packagesDir);
      for (const e of entries) {
        candidates.push(path.join('packages', e, 'node_modules'));
      }
    }
  } catch {
    // No monorepo packages — skip.
  }

  for (const rel of candidates) {
    const src = path.join(repoRoot, rel);
    const dst = path.join(worktreePath, rel);
    try {
      const st = await fs.stat(src);
      if (!st.isDirectory()) continue;
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.cp(src, dst, {
        recursive: true,
        force: true,
        dereference: false,
        errorOnExist: false,
      });
    } catch {
      // node_modules may not exist for this package, or copy may hit a
      // transient lock on Windows — skip silently. Agent falls back to
      // its own install path (slower, but the run still works).
    }
  }
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
 * Snapshot the primary repo's drift surface: HEAD SHA + sorted untracked
 * file list + sorted tracked-modified file list. Used by
 * `assertPrimaryUnchanged` to detect committed changes, xcopy-style
 * untracked leaks, AND tracked-file modifications by agents.
 *
 * **2026-05-01 second pollution incident** showed the previous
 * untracked-only check was insufficient. An agent leaked
 * `auto-resume.ts` / `runner-driven.ts` / `repl.ts` modifications into
 * the primary repo and slipped past detection because they're tracked
 * files. The fix: also snapshot the list of tracked-modified files. Any
 * NEW tracked-modified file (one that was clean before and is dirty
 * after) is flagged.
 *
 * Pre-existing user dirty edits stay safe: they're in the baseline
 * snapshot, so they don't trigger drift unless their content also changes
 * (we don't currently hash content — content drift on a pre-dirty file
 * still slips through; acceptable trade-off for v1).
 */
export interface PrimaryRepoSnapshot {
  readonly head: string;
  /** Sorted array of untracked file paths relative to repo root. */
  readonly untracked: readonly string[];
  /**
   * Sorted array of tracked-modified file paths (from `git diff --name-only`)
   * — represents the user's pre-existing dirty edits. Snapshot reference
   * point: any tracked file that goes clean→modified between snapshot and
   * assert is treated as agent pollution.
   */
  readonly trackedModified: readonly string[];
}

export async function snapshotPrimaryRepo(repoRoot?: string): Promise<PrimaryRepoSnapshot> {
  const root = repoRoot ?? process.cwd();
  const head = await resolveHead(root);
  let untracked: string[] = [];
  let trackedModified: string[] = [];
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '--others', '--exclude-standard'],
      { cwd: root },
    );
    untracked = stdout.split('\n').filter(Boolean).sort();
  } catch {
    // git failure is non-fatal; treat as empty untracked.
  }
  try {
    // `git diff --name-only HEAD` lists tracked files modified vs HEAD
    // (covers both unstaged and staged changes). Stable sort for deterministic
    // diffing.
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--name-only', 'HEAD'],
      { cwd: root },
    );
    trackedModified = stdout.split('\n').filter(Boolean).sort();
  } catch {
    // git failure is non-fatal; treat as empty modified set.
  }
  return { head, untracked, trackedModified };
}

/**
 * Confirm running an eval inside the worktree(s) did not pollute the primary
 * repo. Checks three surfaces:
 *   1. HEAD SHA unchanged (no commits / resets).
 *   2. No NEW untracked files appeared (catches `xcopy worktree primary`).
 *   3. No tracked file went clean→modified (catches in-place edits to
 *      `runner-driven.ts` etc by agents that found the primary repo via
 *      the bash-deny escape).
 *
 * Caller snapshots before any eval starts (`snapshotPrimaryRepo`) and
 * passes the snapshot here after the run.
 *
 * Files dirty in the baseline snapshot are intentionally ignored — they're
 * the user's working state, unrelated to eval pollution. Content drift on
 * a pre-dirty file is NOT detected (would need full file hashing).
 */
export async function assertPrimaryUnchanged(opts: {
  repoRoot?: string;
  expected: PrimaryRepoSnapshot;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const after = await snapshotPrimaryRepo(opts.repoRoot);
  if (after.head !== opts.expected.head) {
    return {
      ok: false,
      reason: `Primary repo HEAD changed from ${opts.expected.head} to ${after.head}`,
    };
  }
  const untrackedBaseline = new Set(opts.expected.untracked);
  const newUntracked = after.untracked.filter((p) => !untrackedBaseline.has(p));
  if (newUntracked.length > 0) {
    return {
      ok: false,
      reason: `Primary repo has ${newUntracked.length} new untracked file(s) — possible eval leak: ${newUntracked.slice(0, 10).join(', ')}${newUntracked.length > 10 ? '...' : ''}`,
    };
  }
  const modifiedBaseline = new Set(opts.expected.trackedModified);
  const newlyModified = after.trackedModified.filter((p) => !modifiedBaseline.has(p));
  if (newlyModified.length > 0) {
    return {
      ok: false,
      reason: `Primary repo has ${newlyModified.length} newly-modified tracked file(s) — possible agent in-place edit: ${newlyModified.slice(0, 10).join(', ')}${newlyModified.length > 10 ? '...' : ''}`,
    };
  }
  return { ok: true };
}

/**
 * Backward-compat shim: HEAD-only check. New callers should use
 * `assertPrimaryUnchanged` with a `snapshotPrimaryRepo` snapshot — that
 * version also catches untracked-file appearance and tracked-file
 * modification (the two real-world leak paths observed during
 * FEATURE_107 P5/P6).
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
