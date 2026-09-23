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

import { readdir, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { assertNoGitInstallPrompt } from '@kodax-ai/agent';
import { promisify } from 'node:util';
import path from 'node:path';
import type {
  KodaXHarnessProfile,
  KodaXManagedTask,
  KodaXOptions,
} from '../../../types.js';
import {
  deleteManagedTaskFile,
  getManagedTaskSurface,
  getManagedTaskWorkspaceRoot,
  writeManagedTaskFile as writeFile,
} from './workspace.js';

const execFileAsync = promisify(execFile);

// FEATURE_071: Worker Checkpoint & Mid-Execution Recovery
export const CHECKPOINT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
export const CHECKPOINT_FILE = 'checkpoint.json';

export interface ManagedTaskCheckpoint {
  version: 1;
  taskId: string;
  /** Session that owns this checkpoint. Ownerless legacy checkpoints are ambiguous. */
  sessionId?: string;
  /** Process that wrote the checkpoint. Diagnostic only; sessionId owns recovery. */
  processId?: number;
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

export function getCheckpointSessionId(options: KodaXOptions): string | undefined {
  const raw = options.session?.id?.trim();
  return raw ? raw : undefined;
}

function checkpointBelongsToSession(
  checkpoint: ManagedTaskCheckpoint,
  currentSessionId: string | undefined,
): boolean {
  if (!currentSessionId) {
    return false;
  }
  return checkpoint.sessionId === currentSessionId;
}

export async function getGitHeadCommit(gitRoot: string | undefined | null): Promise<string | undefined> {
  const cwd = path.resolve(gitRoot?.trim() || process.cwd());
  try {
    await assertNoGitInstallPrompt({ cwd });
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      windowsHide: true,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function writeCheckpoint(
  workspaceDir: string,
  checkpoint: ManagedTaskCheckpoint,
): Promise<void> {
  await writeFile(
    path.join(workspaceDir, CHECKPOINT_FILE),
    `${JSON.stringify(checkpoint, null, 2)}\n`,
    'utf8',
  );
}

export async function deleteCheckpoint(workspaceDir: string): Promise<void> {
  await deleteManagedTaskFile(path.join(workspaceDir, CHECKPOINT_FILE));
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
  const currentSessionId = getCheckpointSessionId(options);
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
      if (candidate.sessionId !== undefined && typeof candidate.sessionId !== 'string') {
        continue;
      }
      if (candidate.processId !== undefined || candidate.pid !== undefined) {
        const rawProcessId = candidate.processId ?? candidate.pid;
        if (typeof rawProcessId !== 'number' || !Number.isFinite(rawProcessId)) {
          continue;
        }
      }
      const rawProcessId = candidate.processId ?? candidate.pid;
      const checkpoint: ManagedTaskCheckpoint = {
        version: 1,
        taskId: candidate.taskId,
        ...(typeof candidate.sessionId === 'string' && candidate.sessionId.trim()
          ? { sessionId: candidate.sessionId }
          : {}),
        ...(typeof rawProcessId === 'number' && Number.isFinite(rawProcessId)
          ? { processId: rawProcessId }
          : {}),
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
      // A task can run longer than the recovery window. `createdAt` belongs to
      // the task contract and is intentionally stable, while the file mtime is
      // refreshed by every successful checkpoint write.
      const createdTime = new Date(checkpoint.createdAt).getTime();
      if (Number.isNaN(createdTime)) {
        continue;
      }
      const age = now - fileStat.mtimeMs;
      if (age > CHECKPOINT_MAX_AGE_MS || age < 0) {
        // Auto-clean checkpoints not refreshed within the recovery window.
        await deleteCheckpoint(workspaceDir);
        continue;
      }
      if (!checkpointBelongsToSession(checkpoint, currentSessionId)) {
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
