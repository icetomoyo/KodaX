import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertNoGitInstallPromptSync } from '@kodax-ai/agent';
import type { KodaXGenerationCheckpoint } from './types.js';
import { parseGenerationCheckpoint } from './generation-checkpoint.js';

const markerPath = (worktreePath: string) => `${worktreePath}.generation.json`;

/** The pin lives beside the worktree so it never changes the user's Git status. */
export function hasGenerationWorktree(worktreePath: string): boolean {
  return existsSync(markerPath(worktreePath));
}

export async function pinGenerationWorktree(worktreePath: string, gitRoot: string, checkpoint: KodaXGenerationCheckpoint): Promise<KodaXGenerationCheckpoint> {
  const saved = { ...checkpoint, isolation: { worktreePath: resolve(worktreePath), gitRoot: resolve(gitRoot) } };
  const target = markerPath(worktreePath);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(saved), { mode: 0o600 });
  await rename(temporary, target);
  return saved;
}

export async function restoreGenerationWorktree(checkpoint: KodaXGenerationCheckpoint, gitRoot: string): Promise<string> {
  const isolation = checkpoint.isolation;
  if (!isolation || resolve(isolation.gitRoot) !== resolve(gitRoot)) throw new Error('Generation worktree repository no longer matches.');
  const path = isolation.worktreePath;
  if (!isAbsolute(path) || dirname(path) === path) throw new Error('Invalid generation worktree path.');
  const saved = JSON.parse(await readFile(markerPath(path), 'utf8')) as unknown;
  if (JSON.stringify(parseGenerationCheckpoint(saved)) !== JSON.stringify(parseGenerationCheckpoint(checkpoint))) throw new Error('Generation worktree checkpoint no longer matches.');
  assertNoGitInstallPromptSync({ cwd: gitRoot });
  const registered = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: gitRoot, windowsHide: true, encoding: 'utf8' })
    .split(/\r?\n/).filter(line => line.startsWith('worktree ')).map(line => resolve(line.slice(9)));
  if (!registered.includes(resolve(path)) || !relative(gitRoot, path)) throw new Error('Generation worktree is no longer registered in its repository.');
  return path;
}

export async function releaseGenerationWorktree(worktreePath: string): Promise<void> {
  try { await unlink(markerPath(worktreePath)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
