import { existsSync, readFileSync, realpathSync, rmdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { withKodaXFileLock } from '@kodax-ai/agent';
import { writeWorkflowJson } from './persistence.js';

function pathKey(value: string): string { return process.platform === 'win32' ? value.toLowerCase() : value; }

function workflowAncestor(projectRoot: string): string | undefined {
  let current = resolve(projectRoot);
  while (dirname(current) !== current) {
    const parent = dirname(current);
    if (pathKey(basename(parent)) === 'worktrees' && pathKey(basename(dirname(dirname(dirname(parent))))) === 'workflow-runs') return current;
    current = parent;
  }
  return undefined;
}

/** Existence is conservative: old or unreadable pins never become GC permission. */
export function isWorkflowProjectProtected(worktreePath: string): boolean {
  return existsSync(`${resolve(worktreePath)}.project-reference.json`);
}

/** Shared with cleanup. The lock is beside the tree so deletion cannot remove it. */
export async function withWorkflowWorktreeProtection<T>(worktreePath: string, operation: () => Promise<T>): Promise<T> {
  const tree = resolve(worktreePath);
  const lock = `${tree}.cleanup.lock`;
  try {
    return await withKodaXFileLock(lock, operation);
  } finally {
    if (!existsSync(tree) && !isWorkflowProjectProtected(tree) && !existsSync(lock)) {
      // Only the empty queue is disposable. A waiting ticket or unknown file
      // makes rmdir fail without touching the caller's coordination evidence.
      try { rmdirSync(`${lock}.queue`); }
      catch (error: unknown) {
        if (typeof error !== 'object' || error === null || !('code' in error)
          || (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY')) throw error;
      }
    }
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Workflow Host ownership evidence.');
  return value as Record<string, unknown>;
}

function owner(runDir: string) {
  const active = join(runDir, 'host-owner.json');
  const hasActive = existsSync(active);
  const manifestPath = hasActive ? active : join(runDir, 'run.json');
  if (!hasActive && !existsSync(manifestPath)) return undefined;
  const manifest = object(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown);
  if (!hasActive && !Object.hasOwn(manifest, 'hostMetadata')) return undefined;
  const metadata = object(manifest.hostMetadata);
  if ((hasActive && manifest.version !== 1) || typeof manifest.runId !== 'string' || pathKey(manifest.runId) !== pathKey(basename(runDir))
    || typeof metadata.ownerSessionId !== 'string' || !metadata.ownerSessionId.trim()
    || typeof metadata.ownerRunId !== 'string' || !metadata.ownerRunId.trim()) {
    throw new Error('Workflow project has no matching Host owner.');
  }
  return { runId: manifest.runId, ownerSessionId: metadata.ownerSessionId, ownerRunId: metadata.ownerRunId };
}

function identity(path: string) {
  const real = realpathSync(path);
  const stat = statSync(real);
  if (!stat.isDirectory()) throw new Error('Workflow project must be an existing directory.');
  return { real, dev: stat.dev, ino: stat.ino, birth: stat.birthtimeMs };
}

/** Adoption makes the whole temporary tree a durable project reference, even
 * after the adopting Session is idle or the Host restarts. No automatic unpin. */
export async function protectWorkflowProject(projectRoot: string): Promise<void> {
  const worktree = workflowAncestor(projectRoot);
  if (!worktree) return; // Ordinary projects do no filesystem work.
  const runDir = dirname(dirname(worktree));
  const originalOwner = owner(runDir);
  if (!originalOwner) return; // The directory shape alone does not make a Host project.
  const originalTree = identity(worktree);
  const originalProject = identity(projectRoot);
  const realRun = realpathSync(runDir);
  const within = relative(originalTree.real, originalProject.real);
  if (pathKey(relative(realRun, originalTree.real)) !== pathKey(join('worktrees', basename(worktree)))
    || isAbsolute(within) || within.split(/[\\/]/).includes('..')) {
    throw new Error('Workflow project resolves outside its owned worktree.');
  }
  await withWorkflowWorktreeProtection(worktree, async () => {
    // Cleanup may have won the lock. Never pin a removed or replaced directory.
    if (JSON.stringify(identity(worktree)) !== JSON.stringify(originalTree)
      || JSON.stringify(identity(projectRoot)) !== JSON.stringify(originalProject)
      || JSON.stringify(owner(runDir)) !== JSON.stringify(originalOwner)) {
      throw new Error('Workflow project identity changed before adoption.');
    }
    if (!isWorkflowProjectProtected(worktree)) writeWorkflowJson(`${worktree}.project-reference.json`, {
      version: 1, ...originalOwner, worktreePath: originalTree.real, projectRoot: originalProject.real,
    });
  });
}
