/**
 * FEATURE_079 — Task Engine Phase 1 Pure Extraction (Slice 7)
 *
 * Worker checkpoint / mid-execution recovery helpers (FEATURE_071) extracted
 * from task-engine.ts. Zero-behavior-change move.
 *
 * `CHECKPOINT_FILE` and `CHECKPOINT_MAX_AGE_MS` are exported so `task-engine.ts`
 * can re-export them via the `__checkpointTestables` bag that `checkpoint.test.ts`
 * consumes. The `ManagedTaskCheckpoint` shape is also exported for the same
 * reason (task-engine state machines build these records inline).
 */

import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type {
  KodaXHarnessProfile,
  KodaXManagedTask,
  KodaXOptions,
} from '../../../types.js';
import { getManagedTaskSurface, getManagedTaskWorkspaceRoot } from './workspace.js';

const execFileAsync = promisify(execFile);

// FEATURE_071: Worker Checkpoint & Mid-Execution Recovery
export const CHECKPOINT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
export const CHECKPOINT_FILE = 'checkpoint.json';

export interface ManagedTaskCheckpoint {
  version: 1;
  taskId: string;
  createdAt: string;
  gitCommit: string;
  objective: string;
  harnessProfile: KodaXHarnessProfile;
  currentRound: number;
  completedWorkerIds: string[];
  scoutCompleted: boolean;
}

export interface ValidatedCheckpoint {
  checkpoint: ManagedTaskCheckpoint;
  workspaceDir: string;
  managedTask: KodaXManagedTask;
}

export async function getGitHeadCommit(gitRoot: string | undefined | null): Promise<string | undefined> {
  const cwd = path.resolve(gitRoot?.trim() || process.cwd());
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function writeCheckpoint(
  workspaceDir: string,
  checkpoint: ManagedTaskCheckpoint,
): Promise<void> {
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    path.join(workspaceDir, CHECKPOINT_FILE),
    `${JSON.stringify(checkpoint, null, 2)}\n`,
    'utf8',
  );
}

export async function deleteCheckpoint(workspaceDir: string): Promise<void> {
  try {
    await unlink(path.join(workspaceDir, CHECKPOINT_FILE));
  } catch {
    // Checkpoint may already be gone — safe to ignore.
  }
}

export async function findValidCheckpoint(
  options: KodaXOptions,
): Promise<ValidatedCheckpoint | undefined> {
  const gitRoot = options.context?.gitRoot;
  const surface = getManagedTaskSurface(options);
  const root = getManagedTaskWorkspaceRoot(options, surface);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return undefined;
  }

  const currentCommit = await getGitHeadCommit(gitRoot);
  const now = Date.now();

  for (const entry of entries) {
    const workspaceDir = path.join(root, entry);
    const checkpointPath = path.join(workspaceDir, CHECKPOINT_FILE);
    try {
      const fileStat = await stat(checkpointPath);
      if (!fileStat.isFile()) {
        continue;
      }
      const raw = await readFile(checkpointPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        continue;
      }
      const candidate = parsed as Record<string, unknown>;
      if (
        candidate.version !== 1
        || typeof candidate.taskId !== 'string'
        || typeof candidate.createdAt !== 'string'
        || typeof candidate.gitCommit !== 'string'
        || typeof candidate.harnessProfile !== 'string'
      ) {
        continue;
      }
      const checkpoint: ManagedTaskCheckpoint = {
        version: 1,
        taskId: candidate.taskId,
        createdAt: candidate.createdAt,
        gitCommit: candidate.gitCommit,
        objective: typeof candidate.objective === 'string' ? candidate.objective : '',
        harnessProfile: candidate.harnessProfile as KodaXHarnessProfile,
        currentRound: typeof candidate.currentRound === 'number' ? candidate.currentRound : 1,
        completedWorkerIds: Array.isArray(candidate.completedWorkerIds)
          ? (candidate.completedWorkerIds as unknown[]).filter((v): v is string => typeof v === 'string')
          : [],
        scoutCompleted: candidate.scoutCompleted === true,
      };
      // Validate age
      const createdTime = new Date(checkpoint.createdAt).getTime();
      if (Number.isNaN(createdTime)) {
        continue;
      }
      const age = now - createdTime;
      if (age > CHECKPOINT_MAX_AGE_MS || age < 0) {
        // Auto-clean expired checkpoints to prevent accumulation.
        await deleteCheckpoint(workspaceDir);
        continue;
      }
      // Validate git commit — code has changed since checkpoint, context is stale.
      if (currentCommit && checkpoint.gitCommit && checkpoint.gitCommit !== currentCommit) {
        await deleteCheckpoint(workspaceDir);
        continue;
      }
      // Load the managed task snapshot
      const managedTaskPath = path.join(workspaceDir, 'managed-task.json');
      const taskRaw = await readFile(managedTaskPath, 'utf8');
      const taskParsed: unknown = JSON.parse(taskRaw);
      if (!taskParsed || typeof taskParsed !== 'object') {
        continue;
      }
      const managedTask = taskParsed as KodaXManagedTask;
      if (!managedTask.contract?.taskId || !managedTask.evidence?.workspaceDir) {
        continue;
      }
      return { checkpoint, workspaceDir, managedTask };
    } catch {
      continue;
    }
  }
  return undefined;
}
