import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { __checkpointTestables } from './task-engine.js';

const {
  writeCheckpoint,
  deleteCheckpoint,
  findValidCheckpoint,
  CHECKPOINT_FILE,
  CHECKPOINT_MAX_AGE_MS,
} = __checkpointTestables;

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

function buildValidCheckpoint(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    taskId: 'task-test-001',
    createdAt: new Date().toISOString(),
    gitCommit: 'abc1234',
    objective: 'Test task',
    harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
    currentRound: 1,
    completedWorkerIds: ['planner-round-1'],
    scoutCompleted: true,
    ...overrides,
  };
}

function buildMinimalManagedTask(taskId: string) {
  return {
    contract: {
      taskId,
      surface: 'repl',
      objective: 'Test task',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'running',
      primaryTask: 'edit',
      workIntent: 'new',
      complexity: 'simple',
      riskLevel: 'low',
      harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
      recommendedMode: 'implementation',
      requiresBrainstorm: false,
      reason: 'Test',
      successCriteria: [],
      requiredEvidence: [],
      constraints: [],
    },
    roleAssignments: [],
    workItems: [],
    evidence: {
      workspaceDir: '/tmp/test',
      artifacts: [],
      entries: [],
      routingNotes: [],
    },
    verdict: {
      status: 'running',
      decidedByAssignmentId: 'evaluator',
      summary: 'Running',
    },
  };
}

describe('Checkpoint: writeCheckpoint + deleteCheckpoint', () => {
  it('writes a valid checkpoint.json and deletes it', async () => {
    const dir = await createTempDir('ckpt-write-');
    const checkpoint = buildValidCheckpoint();

    await writeCheckpoint(dir, checkpoint as Parameters<typeof writeCheckpoint>[1]);

    const raw = await readFile(path.join(dir, CHECKPOINT_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.taskId).toBe('task-test-001');
    expect(parsed.completedWorkerIds).toEqual(['planner-round-1']);

    await deleteCheckpoint(dir);

    // After delete, reading should fail
    await expect(readFile(path.join(dir, CHECKPOINT_FILE), 'utf8')).rejects.toThrow();
  });

  it('deleteCheckpoint is idempotent — no error if file missing', async () => {
    const dir = await createTempDir('ckpt-del-');
    // Should not throw
    await deleteCheckpoint(dir);
  });
});

describe('Checkpoint: findValidCheckpoint', () => {
  it('returns undefined when no managed-tasks directory exists', async () => {
    const dir = await createTempDir('ckpt-no-root-');
    const result = await findValidCheckpoint({
      provider: 'test',
      context: {
        managedTaskWorkspaceDir: path.join(dir, 'nonexistent'),
      },
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when checkpoint is expired', async () => {
    const root = await createTempDir('ckpt-expired-');
    const taskDir = path.join(root, 'task-001');
    await mkdir(taskDir, { recursive: true });

    const expiredCheckpoint = buildValidCheckpoint({
      createdAt: new Date(Date.now() - CHECKPOINT_MAX_AGE_MS - 1000).toISOString(),
    });
    await writeFile(
      path.join(taskDir, CHECKPOINT_FILE),
      JSON.stringify(expiredCheckpoint),
      'utf8',
    );

    const result = await findValidCheckpoint({
      provider: 'test',
      context: { managedTaskWorkspaceDir: root },
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when git commit does not match', async () => {
    const root = await createTempDir('ckpt-git-mismatch-');
    const taskDir = path.join(root, 'task-001');
    await mkdir(taskDir, { recursive: true });

    const checkpoint = buildValidCheckpoint({ gitCommit: 'old-commit' });
    await writeFile(
      path.join(taskDir, CHECKPOINT_FILE),
      JSON.stringify(checkpoint),
      'utf8',
    );
    // Also write managed-task.json
    await writeFile(
      path.join(taskDir, 'managed-task.json'),
      JSON.stringify(buildMinimalManagedTask('task-001')),
      'utf8',
    );

    // Note: findValidCheckpoint calls getGitHeadCommit which will get actual HEAD.
    // If the test is in a git repo, it will compare against the real HEAD.
    // The checkpoint has gitCommit='old-commit' which won't match, so it should be discarded.
    const result = await findValidCheckpoint({
      provider: 'test',
      context: { managedTaskWorkspaceDir: root },
    });
    expect(result).toBeUndefined();
  });

  it('returns valid checkpoint when all checks pass', async () => {
    const root = await createTempDir('ckpt-valid-');
    const taskDir = path.join(root, 'task-001');
    await mkdir(taskDir, { recursive: true });

    // Use empty string git commit to bypass git validation
    // (when currentCommit is undefined/empty, the git check is skipped)
    const checkpoint = buildValidCheckpoint({ gitCommit: '' });
    await writeFile(
      path.join(taskDir, CHECKPOINT_FILE),
      JSON.stringify(checkpoint),
      'utf8',
    );
    await writeFile(
      path.join(taskDir, 'managed-task.json'),
      JSON.stringify(buildMinimalManagedTask('task-001')),
      'utf8',
    );

    const result = await findValidCheckpoint({
      provider: 'test',
      context: {
        managedTaskWorkspaceDir: root,
        gitRoot: '/nonexistent-git-root', // Will fail to get HEAD, skipping git check
      },
    });
    // The git check is: if (currentCommit && checkpoint.gitCommit && ...)
    // With empty gitCommit, the condition is falsy so it passes.
    expect(result).toBeDefined();
    expect(result!.checkpoint.taskId).toBe('task-test-001');
    expect(result!.managedTask.contract.taskId).toBe('task-001');
  });

  it('skips malformed checkpoint JSON', async () => {
    const root = await createTempDir('ckpt-malformed-');
    const taskDir = path.join(root, 'task-001');
    await mkdir(taskDir, { recursive: true });

    await writeFile(
      path.join(taskDir, CHECKPOINT_FILE),
      '{ invalid json }}}',
      'utf8',
    );

    const result = await findValidCheckpoint({
      provider: 'test',
      context: { managedTaskWorkspaceDir: root },
    });
    expect(result).toBeUndefined();
  });

  it('skips checkpoint with missing required fields', async () => {
    const root = await createTempDir('ckpt-incomplete-');
    const taskDir = path.join(root, 'task-001');
    await mkdir(taskDir, { recursive: true });

    await writeFile(
      path.join(taskDir, CHECKPOINT_FILE),
      JSON.stringify({ version: 1, taskId: 'x' }),
      'utf8',
    );

    const result = await findValidCheckpoint({
      provider: 'test',
      context: { managedTaskWorkspaceDir: root },
    });
    expect(result).toBeUndefined();
  });

  it('skips checkpoint with invalid createdAt timestamp', async () => {
    const root = await createTempDir('ckpt-bad-ts-');
    const taskDir = path.join(root, 'task-001');
    await mkdir(taskDir, { recursive: true });

    const checkpoint = buildValidCheckpoint({
      createdAt: 'not-a-date',
      gitCommit: '',
    });
    await writeFile(
      path.join(taskDir, CHECKPOINT_FILE),
      JSON.stringify(checkpoint),
      'utf8',
    );

    const result = await findValidCheckpoint({
      provider: 'test',
      context: {
        managedTaskWorkspaceDir: root,
        gitRoot: '/nonexistent',
      },
    });
    expect(result).toBeUndefined();
  });

  it('skips checkpoint with missing managed-task.json', async () => {
    const root = await createTempDir('ckpt-no-task-');
    const taskDir = path.join(root, 'task-001');
    await mkdir(taskDir, { recursive: true });

    const checkpoint = buildValidCheckpoint({ gitCommit: '' });
    await writeFile(
      path.join(taskDir, CHECKPOINT_FILE),
      JSON.stringify(checkpoint),
      'utf8',
    );
    // Intentionally not writing managed-task.json

    const result = await findValidCheckpoint({
      provider: 'test',
      context: {
        managedTaskWorkspaceDir: root,
        gitRoot: '/nonexistent',
      },
    });
    expect(result).toBeUndefined();
  });
});
