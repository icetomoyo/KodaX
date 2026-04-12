/**
 * KodaX Worktree Isolation Tools
 *
 * Creates and removes git worktrees for isolated agent work.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import type { KodaXToolExecutionContext } from '../types.js';

const execFileAsync = promisify(execFile);

/**
 * Generate a branch name from description or timestamp.
 */
function generateBranchName(description?: string): string {
  if (description) {
    const slug = description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
    return `kodax-wt-${slug}`;
  }
  return `kodax-wt-${Date.now()}`;
}

/**
 * Validate branch name according to git rules.
 */
function isValidBranchName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,62}[a-zA-Z0-9]$|^[a-zA-Z0-9]$/.test(name);
}

/**
 * Creates a new git worktree with an isolated branch.
 *
 * Usage:
 *   {
 *     "branch_name": "feature-xyz",  // optional: explicit branch name
 *     "description": "Add new feature"  // optional: auto-generate branch name from description
 *   }
 *
 * Returns:
 *   {
 *     "path": "/absolute/path/to/worktree",
 *     "branch": "kodax-wt-feature-xyz"
 *   }
 */
export async function toolWorktreeCreate(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const branchName = input.branch_name as string | undefined;
  const description = input.description as string | undefined;

  const branch = branchName ?? generateBranchName(description);

  if (!isValidBranchName(branch)) {
    throw new Error(
      `Invalid branch name: ${branch}. Must start and end with alphanumeric, ` +
      `contain only alphanumeric, dots, dashes, or slashes (max 64 chars).`,
    );
  }

  const cwd = ctx.executionCwd ?? ctx.gitRoot ?? process.cwd();

  // Resolve worktree path: .kodax-worktree-<branch> relative to git root
  const worktreePath = path.join(cwd, '..', `.kodax-worktree-${branch}`);

  // Create worktree with new branch
  try {
    await execFileAsync('git', ['worktree', 'add', '-b', branch, worktreePath], { cwd });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create worktree: ${msg}`);
  }

  return JSON.stringify({ path: worktreePath, branch });
}

/**
 * Removes a git worktree and optionally its branch.
 *
 * Usage:
 *   {
 *     "action": "keep",              // "keep" | "remove"
 *     "worktree_path": "/path/to/worktree",  // absolute path to the worktree
 *     "discard_changes": false       // optional: force removal even with uncommitted changes
 *   }
 *
 * Returns:
 *   {
 *     "restored": true,
 *     "message": "Worktree removed. ..."
 *   }
 */
export async function toolWorktreeRemove(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const action = input.action as string | undefined;
  const worktreePath = input.worktree_path as string | undefined;
  const discardChanges = input.discard_changes as boolean | undefined;

  if (!action || (action !== 'keep' && action !== 'remove')) {
    throw new Error('action must be "keep" or "remove"');
  }

  if (!worktreePath) {
    throw new Error('worktree_path is required');
  }

  const cwd = ctx.executionCwd ?? ctx.gitRoot ?? process.cwd();

  if (action === 'keep') {
    return JSON.stringify({
      restored: true,
      message: `Worktree kept at ${worktreePath}. Restored CWD.`,
    });
  }

  // Safety check: count uncommitted changes
  if (!discardChanges) {
    try {
      // Check for uncommitted files
      const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: worktreePath,
      });
      const uncommittedFiles = statusOut
        .trim()
        .split('\n')
        .filter((l) => l.trim().length > 0).length;

      // Count commits ahead of origin
      const { stdout: revListOut } = await execFileAsync('git', [
        'rev-list',
        '--count',
        'HEAD',
        '--not',
        '--remotes',
      ], {
        cwd: worktreePath,
      });
      const localCommits = parseInt(revListOut.trim(), 10) || 0;

      if (uncommittedFiles > 0 || localCommits > 0) {
        throw new Error(
          `Worktree has ${uncommittedFiles} uncommitted file(s) and ${localCommits} local commit(s). ` +
          `Use discard_changes=true to force removal, or commit/push your work first.`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('uncommitted')) {
        throw err;
      }
      // If git commands fail, fail-closed
      throw new Error(`Cannot verify worktree state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Get the branch name before removing
  let branch = '';
  try {
    const { stdout: branchOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath,
    });
    branch = branchOut.trim();
  } catch {
    // If we can't get the branch name, continue anyway
  }

  // Remove worktree
  try {
    await execFileAsync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to remove worktree: ${msg}`);
  }

  // Delete the branch
  if (branch) {
    try {
      await execFileAsync('git', ['branch', '-D', branch], { cwd });
    } catch {
      // Branch might not exist or be checked out elsewhere; ignore
    }
  }

  return JSON.stringify({
    restored: true,
    message: `Worktree removed. Branch ${branch || '(unknown)'} deleted. Restored CWD.`,
  });
}
