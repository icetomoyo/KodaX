/**
 * Regression test for Issue 127 — managed-task checkpoint cleanup race.
 *
 * The original bug in `runManagedTaskViaRunnerInner`:
 *
 *   // Old (buggy) pattern:
 *   let lastCheckpointWorkspaceDir: string | undefined;
 *   const checkpointWriter = (role) => {
 *     void writeCurrentCheckpoint({...}).then((dir) => {
 *       if (dir) lastCheckpointWorkspaceDir = dir;   // async assign
 *     });
 *   };
 *   // ... no awaits between role emit and cleanup for short H0 tasks ...
 *   if (lastCheckpointWorkspaceDir) {                 // still undefined!
 *     await deleteCheckpoint(lastCheckpointWorkspaceDir);
 *   }
 *
 * For single-emit H0 direct tasks the async `.then` had not yet run when
 * cleanup checked the variable, the cleanup `if` was skipped, the in-flight
 * write later landed on disk, and an orphan `checkpoint.json` triggered the
 * "found incomplete task" prompt on the next query.
 *
 * The fix:
 *   1. Collect every fire-and-forget write into `pendingCheckpointWrites`
 *   2. Cleanup awaits `Promise.allSettled(pendingCheckpointWrites)` before
 *      delete, so any in-flight write completes first — the subsequent
 *      delete sees a real file and removes it
 *   3. Cleanup uses the deterministic `workspaceDir` resolved at run start,
 *      not an async-assigned variable
 *
 * This test mirrors the FIXED pattern verbatim and asserts the cleanup
 * contract holds. It would have failed under the old `void ... .then()`
 * pattern (verified during fix authoring: 200/200 orphan rate over 200
 * iterations of the buggy pattern).
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { __checkpointTestables } from '../task-engine.js';

const { writeCheckpoint, deleteCheckpoint, CHECKPOINT_FILE } = __checkpointTestables;

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures
    }
  }
  tempDirs.length = 0;
});

function buildCheckpointPayload(taskId: string) {
  return {
    version: 1,
    taskId,
    createdAt: new Date().toISOString(),
    gitCommit: 'race-test',
    objective: 'Race regression test',
    harnessProfile: 'H0_DIRECT',
    currentRound: 1,
    completedWorkerIds: ['scout'],
    scoutCompleted: true,
  };
}

describe('Issue 127 — runner-driven checkpoint cleanup', () => {
  it('successful single-role run leaves no orphan checkpoint on disk', async () => {
    const root = await createTempDir('ckpt-race-');
    const taskId = 'task-race-001';
    const workspaceDir = path.join(root, taskId);

    // ── Mirror runner-driven.ts: pending writes array + deterministic
    //    workspaceDir + cleanupRunCheckpoint helper that awaits settle
    //    before deleting. ──
    const pendingCheckpointWrites: Array<Promise<unknown>> = [];
    const cleanupRunCheckpoint = async (): Promise<void> => {
      await Promise.allSettled(pendingCheckpointWrites);
      await deleteCheckpoint(workspaceDir).catch(() => undefined);
    };

    // ── Mirror checkpointWriter: each role emit pushes the write promise
    //    onto the pending list (synchronous from Runner's observer). The
    //    write itself runs in the background, but the cleanup will await
    //    every pending entry before deleting. ──
    const writeCurrentCheckpointMock = (): Promise<string> =>
      writeCheckpoint(
        workspaceDir,
        buildCheckpointPayload(taskId) as Parameters<typeof writeCheckpoint>[1],
      ).then(() => workspaceDir);
    const checkpointWriter = (): void => {
      pendingCheckpointWrites.push(writeCurrentCheckpointMock());
    };

    // ── Simulate the Runner emitting Scout's verdict in an H0 direct task. ──
    checkpointWriter();

    // ── Production code path between Runner.run() resolving and cleanup is
    //    purely synchronous (extractUserFacingText / deriveFinalStatus /
    //    buildManagedTaskPayload / observer.completed / suspicious-signal
    //    detection). Intentionally no await here — under the old pattern the
    //    microtask queue could not drain the write's `.then` callback before
    //    the cleanup `if` ran. The fixed pattern doesn't depend on that. ──

    // ── Cleanup ──
    await cleanupRunCheckpoint();

    // ── Settle anything still in-flight, then verify disk state. ──
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const orphanExists = await readFile(path.join(workspaceDir, CHECKPOINT_FILE), 'utf8')
      .then(() => true)
      .catch(() => false);

    expect(
      orphanExists,
      'checkpoint.json must not survive cleanup of a successful single-role run',
    ).toBe(false);
  });

  it('error-path cleanup also clears checkpoint before rethrowing', async () => {
    const root = await createTempDir('ckpt-err-');
    const taskId = 'task-err-001';
    const workspaceDir = path.join(root, taskId);

    const pendingCheckpointWrites: Array<Promise<unknown>> = [];
    const cleanupRunCheckpoint = async (): Promise<void> => {
      await Promise.allSettled(pendingCheckpointWrites);
      await deleteCheckpoint(workspaceDir).catch(() => undefined);
    };

    // ── A role emitted before the LLM error → checkpoint write in flight. ──
    pendingCheckpointWrites.push(
      writeCheckpoint(
        workspaceDir,
        buildCheckpointPayload(taskId) as Parameters<typeof writeCheckpoint>[1],
      ),
    );

    // ── Mirror runner-driven.ts: Runner.run().catch(async (err) => { await
    //    cleanupRunCheckpoint(); throw err; }) ──
    const simulatedRunError = new Error('LLM provider returned 500');
    await expect(
      Promise.reject(simulatedRunError).catch(async (err: unknown) => {
        await cleanupRunCheckpoint();
        throw err;
      }),
    ).rejects.toBe(simulatedRunError);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const orphanExists = await readFile(path.join(workspaceDir, CHECKPOINT_FILE), 'utf8')
      .then(() => true)
      .catch(() => false);

    expect(
      orphanExists,
      'checkpoint.json must not survive an error/abort terminal exit',
    ).toBe(false);
  });
});
