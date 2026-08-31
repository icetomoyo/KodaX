import os from 'os';
import path from 'path';
import { createHash } from 'node:crypto';
import fsSync, { existsSync } from 'fs';
import fsPromises from 'fs/promises';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendMemoryClientNotice,
  appendMemoryOutcomeDigest,
  appendMemoryReviewReceipt,
  applySessionCompaction,
  createSessionLineage,
  drainPendingEpisodeReviews,
  evictOldIslandMessageContent,
  getSessionMessagesFromLineage,
  getSessionLineagePath,
  hashMemoryIdentityComponent,
  listPendingEpisodeReviews,
  persistPendingEpisodeReview,
  withKodaXFileLock,
  withPendingEpisodeReviewSessionFence,
} from '@kodax-ai/agent';
import type {
  AgentActorSnapshot,
  KodaXMemoryOutcomeDigest,
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionEntry,
  KodaXSessionLineage,
  KodaXSessionMessageEntry,
} from '@kodax-ai/agent';

// 'C:/...' is absolute on win32 but RELATIVE on POSIX, so path.resolve() would
// prepend the cwd on Linux CI and break the per-project session-key derivation
// these tests rely on. Use a repo root that is absolute on both platforms.
const KODAX_REPO_ROOT = process.platform === 'win32'
  ? 'C:/Works/GitWorks/KodaX'
  : '/Works/GitWorks/KodaX';

function actorStorageSnapshot(revision: number): AgentActorSnapshot {
  const now = '2026-08-15T00:00:00.000Z';
  return {
    schemaVersion: 1,
    revision,
    maxConcurrentThreads: 4,
    actors: [{
      path: '/root', taskName: 'root', kind: 'native', state: 'running',
      capabilities: {
        tools: ['*'], filesystem: 'write', network: true,
        providers: ['*'], canAskUser: true,
      },
      turnIds: [], mailboxCursor: 0, createdAt: now, updatedAt: now, revision: 1,
    }],
    turns: [],
    mailboxes: { '/root': [] },
    events: [],
  };
}

describe('FileSessionStorage', () => {
  let tempHome: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let previousKodaXHome: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-storage-'));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousKodaXHome = process.env.KODAX_HOME;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.KODAX_HOME = path.join(tempHome, '.kodax');
    vi.doUnmock('./workspace-runtime.js');
    vi.resetModules();
  });

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }

    if (previousKodaXHome === undefined) {
      delete process.env.KODAX_HOME;
    } else {
      process.env.KODAX_HOME = previousKodaXHome;
    }

    vi.doUnmock('./workspace-runtime.js');

    vi.resetModules();
    await rm(tempHome, { recursive: true, force: true });
  });

  const testSessionsDir = (): string => path.join(tempHome, '.kodax', 'sessions');

  it('retries a transient Windows atomic-replace failure', async () => {
    const originalRename = fsPromises.rename.bind(fsPromises);
    let targetAttempts = 0;
    const rename = vi.spyOn(fsPromises, 'rename');
    rename.mockImplementation(async (oldPath, newPath) => {
      if (String(newPath).endsWith('rename-retry.jsonl')) {
        targetAttempts += 1;
        if (targetAttempts === 1) {
          throw Object.assign(new Error('file temporarily locked'), { code: 'EPERM' });
        }
      }
      await originalRename(oldPath, newPath);
    });
    try {
      const { FileSessionStorage } = await import('./storage.js');
      const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });

      await storage.save('rename-retry', {
        messages: [{ role: 'user', content: 'persist despite a transient lock' }],
        title: 'Rename retry',
        gitRoot: path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/'),
      });

      expect(targetAttempts).toBe(2);
      expect(await storage.load('rename-retry')).toMatchObject({ title: 'Rename retry' });
    } finally {
      rename.mockRestore();
    }
  });

  it('persists the Runtime-owned Actor snapshot without a private sidecar journal', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const now = '2026-07-17T00:00:00.000Z';
    const actorSnapshot = {
      schemaVersion: 1 as const,
      revision: 3,
      maxConcurrentThreads: 4,
      actors: [{
        path: '/root', taskName: 'root', kind: 'native' as const, state: 'running' as const,
        capabilities: {
          tools: ['*'], filesystem: 'write' as const, network: true,
          providers: ['*'], canAskUser: true,
        },
        turnIds: [], mailboxCursor: 0, createdAt: now, updatedAt: now, revision: 1,
      }],
      turns: [],
      mailboxes: { '/root': [] },
      events: [],
    };
    const base = {
      messages: [{ role: 'user' as const, content: 'persist actors' }],
      title: 'Actor owner',
      gitRoot: path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/'),
    };

    await storage.save('actor-session', { ...base, actorSnapshot });
    await storage.save('actor-session', { ...base, title: 'Actor owner updated' });

    const nextSnapshot = { ...actorSnapshot, revision: 4 };
    await storage.saveActorSnapshot('actor-session', nextSnapshot, 3);
    const conflictAttempt = storage.beginActorSnapshotSave('actor-session', actorSnapshot, 3);
    await expect(conflictAttempt.canonical).rejects.toMatchObject({
        code: 'actor_snapshot_conflict',
        expectedRevision: 3,
        currentRevision: 4,
      });
    await expect(conflictAttempt.completion).rejects.toMatchObject({
      code: 'actor_snapshot_conflict',
    });
    expect(conflictAttempt.diagnostics()).toMatchObject({
      phase: 'not_committed',
      failedStage: 'readCas',
      timingsMs: { readCas: expect.any(Number) },
    });

    expect(await storage.load('actor-session')).toMatchObject({
      title: 'Actor owner updated',
      actorSnapshot: nextSnapshot,
    });

    const competingStorage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const competingWrites = await Promise.allSettled([
      storage.saveActorSnapshot(
        'actor-session',
        { ...nextSnapshot, revision: 5, maxConcurrentThreads: 6 },
        4,
      ),
      competingStorage.saveActorSnapshot(
        'actor-session',
        { ...nextSnapshot, revision: 5, maxConcurrentThreads: 8 },
        4,
      ),
    ]);
    expect(competingWrites.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const rejectedWrite = competingWrites.find((result) => result.status === 'rejected');
    expect(rejectedWrite?.reason).toMatchObject({
      code: 'actor_snapshot_conflict',
      expectedRevision: 4,
      currentRevision: 5,
    });
    expect([6, 8]).toContain(
      (await storage.load('actor-session'))?.actorSnapshot?.maxConcurrentThreads,
    );
    const wonSnapshot = (await storage.load('actor-session'))?.actorSnapshot;
    if (!wonSnapshot) throw new Error('Expected the winning Actor snapshot.');
    const staleFullSession = await storage.load('actor-session');
    if (!staleFullSession) throw new Error('Expected a stale full Session snapshot.');
    const nextWinner = { ...wonSnapshot, revision: 6 };
    await storage.saveActorSnapshot('actor-session', nextWinner, 5);
    await storage.save('actor-session', {
      ...staleFullSession,
      title: 'Stale host save must preserve Actor CAS state',
    });
    expect((await storage.peek('actor-session'))?.actorSnapshot).toEqual(nextWinner);

    await storage.archive('actor-session');
    await competingStorage.saveActorSnapshot(
      'actor-session',
      { ...nextWinner, revision: 7 },
      6,
    );
    expect((await storage.list(
      path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/'),
    )).map((session) => session.id)).not.toContain('actor-session');
    expect((await storage.list(
      path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/'),
      { includeArchived: true },
    )).filter((session) => session.id === 'actor-session')).toHaveLength(1);

    const fork = await storage.fork('actor-session', undefined, { sessionId: 'actor-fork' });
    expect(fork?.data.actorSnapshot).toBeUndefined();
  });

  it('keeps a canonical Actor commit successful when post-commit maintenance fails', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const storage = new FileSessionStorage({ sessionsDir });
    const sessionId = 'actor-canonical-before-maintenance';
    const actorSnapshot = actorStorageSnapshot(3);
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'persist actors by canonical phase' }],
      title: 'Actor phased commit',
      gitRoot: KODAX_REPO_ROOT,
      actorSnapshot,
    });

    const originalRename = fsPromises.rename.bind(fsPromises);
    const originalStat = fsPromises.stat.bind(fsPromises);
    let mainCommitted = false;
    let releaseMaintenance: (() => void) | undefined;
    let markMaintenanceStarted: (() => void) | undefined;
    const maintenanceGate = new Promise<void>((resolve) => { releaseMaintenance = resolve; });
    const maintenanceStarted = new Promise<void>((resolve) => {
      markMaintenanceStarted = resolve;
    });
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      await originalRename(from, to);
      if (path.basename(String(to)) === `${sessionId}.jsonl`) {
        mainCommitted = true;
      }
    });
    const stat = vi.spyOn(fsPromises, 'stat').mockImplementation(async (target, options) => {
      if (
        mainCommitted
        && path.basename(String(target)) === `${sessionId}.jsonl`
      ) {
        markMaintenanceStarted?.();
        await maintenanceGate;
        throw Object.assign(new Error('post-commit witness failed'), { code: 'EIO' });
      }
      return originalStat(target, options);
    });
    try {
      const attempt = storage.beginActorSnapshotSave(
        sessionId,
        { ...actorSnapshot, revision: 4 },
        3,
      );
      let completionSettled = false;
      void attempt.completion.then(
        () => { completionSettled = true; },
        () => { completionSettled = true; },
      );

      await attempt.eligible;
      await attempt.canonical;
      await maintenanceStarted;

      expect(completionSettled).toBe(false);
      expect(attempt.phase()).toBe('committed');
      expect(attempt.diagnostics()).toMatchObject({
        phase: 'committed',
        activeStage: 'postCommit',
        timingsMs: { rename: expect.any(Number) },
      });
      releaseMaintenance?.();
      await expect(attempt.completion).rejects.toThrow('post-commit witness failed');
      expect(attempt.phase()).toBe('committed');
      expect(attempt.diagnostics().failedStage).toBe('postCommit');
      stat.mockRestore();
      await expect(storage.prepareSessionAppend(sessionId)).resolves.toBeNull();
      expect((await new FileSessionStorage({ sessionsDir }).peek(sessionId))?.actorSnapshot)
        .toMatchObject({ revision: 4 });
    } finally {
      releaseMaintenance?.();
      stat.mockRestore();
      rename.mockRestore();
    }
  });

  it('keeps rename in-flight ambiguous until its canonical outcome is known', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const storage = new FileSessionStorage({ sessionsDir });
    const sessionId = 'actor-rename-inflight';
    const actorSnapshot = actorStorageSnapshot(1);
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'hold canonical rename' }],
      title: 'Actor rename in-flight',
      gitRoot: KODAX_REPO_ROOT,
      actorSnapshot,
    });

    const originalRename = fsPromises.rename.bind(fsPromises);
    let releaseRename: (() => void) | undefined;
    let markRenameStarted: (() => void) | undefined;
    const renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
    const renameStarted = new Promise<void>((resolve) => { markRenameStarted = resolve; });
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (path.basename(String(to)) === `${sessionId}.jsonl`) {
        markRenameStarted?.();
        await renameGate;
        await originalRename(from, to);
        return;
      }
      await originalRename(from, to);
    });
    try {
      const targetSnapshot: AgentActorSnapshot = {
        ...actorSnapshot,
        revision: 2,
        actors: actorSnapshot.actors.map((actor) => ({
          ...actor,
          currentTurnId: undefined,
        })),
      };
      const attempt = storage.beginActorSnapshotSave(
        sessionId,
        targetSnapshot,
        1,
      );
      await attempt.eligible;
      await renameStarted;

      expect(attempt.phase()).toBe('commit_inflight');
      expect(attempt.diagnostics().activeStage).toBe('rename');
      expect(attempt.cancelBeforeCommit()).toBe(false);

      releaseRename?.();
      await attempt.canonical;
      await attempt.completion;
      expect(attempt.phase()).toBe('committed');
      expect(attempt.diagnostics().timingsMs.rename).toEqual(expect.any(Number));
      expect((await new FileSessionStorage({ sessionsDir }).peek(sessionId))?.actorSnapshot)
        .toMatchObject({ revision: 2 });
    } finally {
      releaseRename?.();
      rename.mockRestore();
    }
  });

  it('classifies an explicit failed replacement as definitely not committed', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const storage = new FileSessionStorage({ sessionsDir });
    const sessionId = 'actor-rename-rejected-before-commit';
    const actorSnapshot = actorStorageSnapshot(1);
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'reject canonical rename' }],
      title: 'Actor rename rejection',
      gitRoot: KODAX_REPO_ROOT,
      actorSnapshot,
    });

    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async (_from, to) => {
      if (path.basename(String(to)) === `${sessionId}.jsonl`) {
        throw Object.assign(new Error('canonical rename rejected'), { code: 'EIO' });
      }
      throw new Error(`Unexpected rename target: ${String(to)}`);
    });
    try {
      const targetSnapshot: AgentActorSnapshot = {
        ...actorSnapshot,
        revision: 2,
        actors: actorSnapshot.actors.map((actor) => ({
          ...actor,
          currentTurnId: undefined,
        })),
      };
      const attempt = storage.beginActorSnapshotSave(
        sessionId,
        targetSnapshot,
        1,
      );

      await attempt.dequeued;
      await attempt.eligible;
      await expect(attempt.canonical).rejects.toThrow('canonical rename rejected');
      await expect(attempt.completion).rejects.toThrow('canonical rename rejected');
      expect(attempt.phase()).toBe('not_committed');
      expect(attempt.diagnostics()).toMatchObject({
        failedStage: 'rename',
        completionOutcome: 'failed',
        timingsMs: { rename: expect.any(Number) },
      });
      expect((await new FileSessionStorage({ sessionsDir }).peek(sessionId))?.actorSnapshot)
        .toMatchObject({ revision: 1 });
    } finally {
      rename.mockRestore();
    }
  });

  it('confirms a replacement that committed before rename reported failure', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const storage = new FileSessionStorage({ sessionsDir });
    const sessionId = 'actor-rename-rejected-after-commit';
    const actorSnapshot = actorStorageSnapshot(1);
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'verify canonical rename readback' }],
      title: 'Actor rename readback',
      gitRoot: KODAX_REPO_ROOT,
      actorSnapshot,
    });

    const originalRename = fsPromises.rename.bind(fsPromises);
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      await originalRename(from, to);
      if (path.basename(String(to)) === `${sessionId}.jsonl`) {
        throw Object.assign(new Error('rename result transport failed'), { code: 'EIO' });
      }
    });
    try {
      const targetSnapshot: AgentActorSnapshot = {
        ...actorSnapshot,
        revision: 2,
        actors: actorSnapshot.actors.map((actor) => ({
          ...actor,
          currentTurnId: undefined,
        })),
      };
      const attempt = storage.beginActorSnapshotSave(
        sessionId,
        targetSnapshot,
        1,
      );

      await attempt.canonical;
      await expect(attempt.completion).rejects.toThrow('rename result transport failed');
      expect(attempt.phase()).toBe('committed');
      expect(attempt.diagnostics()).toMatchObject({
        failedStage: 'rename',
        canonicalOutcome: 'committed_by_readback',
        completionOutcome: 'failed',
      });
      expect((await new FileSessionStorage({ sessionsDir }).peek(sessionId))?.actorSnapshot)
        .toMatchObject({ revision: 2 });
    } finally {
      rename.mockRestore();
    }
  });

  it('does not confirm a rejected replacement from a matching revision alone', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const storage = new FileSessionStorage({ sessionsDir });
    const sessionId = 'actor-rename-same-revision-different-content';
    const actorSnapshot = actorStorageSnapshot(1);
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'same revision must not prove commit' }],
      title: 'Actor exact readback',
      gitRoot: KODAX_REPO_ROOT,
      actorSnapshot,
    });

    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async (_from, to) => {
      if (path.basename(String(to)) === `${sessionId}.jsonl`) {
        throw Object.assign(new Error('same-revision rename rejected'), { code: 'EIO' });
      }
      throw new Error(`Unexpected rename target: ${String(to)}`);
    });
    try {
      const attempt = storage.beginActorSnapshotSave(
        sessionId,
        { ...actorSnapshot, maxConcurrentThreads: 9 },
        1,
      );

      await expect(attempt.canonical).rejects.toThrow('same-revision rename rejected');
      await expect(attempt.completion).rejects.toThrow('same-revision rename rejected');
      expect(attempt.phase()).toBe('not_committed');
      expect((await new FileSessionStorage({ sessionsDir }).peek(sessionId))?.actorSnapshot)
        .toMatchObject({ revision: 1, maxConcurrentThreads: 4 });
    } finally {
      rename.mockRestore();
    }
  });

  it('cancels a precommit Actor snapshot attempt without a late canonical rename', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const storage = new FileSessionStorage({ sessionsDir });
    const sessionId = 'actor-cancel-before-rename';
    const actorSnapshot = actorStorageSnapshot(1);
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'cancel before canonical rename' }],
      title: 'Actor cancelled commit',
      gitRoot: KODAX_REPO_ROOT,
      actorSnapshot,
    });

    const originalOpen = fsPromises.open.bind(fsPromises);
    let releaseOpen: (() => void) | undefined;
    let markOpenStarted: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const openStarted = new Promise<void>((resolve) => { markOpenStarted = resolve; });
    const open = vi.spyOn(fsPromises, 'open').mockImplementation(async (file, flags, mode) => {
      if (String(file).includes(`${sessionId}.jsonl.`) && String(file).endsWith('.tmp')) {
        markOpenStarted?.();
        await openGate;
      }
      return originalOpen(file, flags, mode);
    });
    const rename = vi.spyOn(fsPromises, 'rename');
    try {
      const attempt = storage.beginActorSnapshotSave(
        sessionId,
        { ...actorSnapshot, revision: 2 },
        1,
      );
      await attempt.eligible;
      await openStarted;

      expect(attempt.phase()).toBe('precommit');
      expect(attempt.diagnostics().activeStage).toBe('tempWrite');
      expect(attempt.cancelBeforeCommit()).toBe(true);
      releaseOpen?.();

      await expect(attempt.canonical).rejects.toMatchObject({
        code: 'actor_snapshot_save_cancelled',
      });
      await expect(attempt.completion).rejects.toMatchObject({
        code: 'actor_snapshot_save_cancelled',
      });
      expect(attempt.phase()).toBe('not_committed');
      expect(attempt.diagnostics().failedStage).toBe('tempWrite');
      expect(rename.mock.calls.some(([, target]) => (
        path.basename(String(target)) === `${sessionId}.jsonl`
      ))).toBe(false);
      expect((await new FileSessionStorage({ sessionsDir }).peek(sessionId))?.actorSnapshot)
        .toMatchObject({ revision: 1 });
    } finally {
      releaseOpen?.();
      open.mockRestore();
      rename.mockRestore();
    }
  });

  it('requires the durable Actor owner for archive, unarchive, and delete', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const now = '2026-07-28T00:00:00.000Z';
    const owner = {
      ownerId: 'owner-maintenance',
      runtimeId: 'runtime-maintenance',
      pid: process.pid,
      startedAt: now,
    };
    const actorSnapshot: AgentActorSnapshot = {
      schemaVersion: 2,
      revision: 1,
      maxConcurrentThreads: 4,
      owner,
      actors: [{
        path: '/root',
        taskName: 'root',
        kind: 'native',
        state: 'running',
        capabilities: {
          tools: ['*'],
          filesystem: 'write',
          network: true,
          providers: ['*'],
          canAskUser: true,
        },
        turnIds: [],
        mailboxCursor: 0,
        createdAt: now,
        updatedAt: now,
        revision: 1,
      }],
      turns: [],
      mailboxes: { '/root': [] },
      events: [],
    };
    const data = {
      messages: [
        { role: 'user' as const, content: 'Leave a tool call incomplete.' },
        {
          role: 'assistant' as const,
          content: [
            { type: 'tool_use' as const, id: 'call_owned', name: 'test', input: {} },
          ],
        },
      ],
      title: 'Owned maintenance',
      gitRoot: path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/'),
      scope: 'user' as const,
      actorSnapshot,
      errorMetadata: {
        lastError: 'interrupted',
        lastErrorTime: 1,
        consecutiveErrors: 1,
      },
    };
    await storage.save('owned-maintenance', data);

    await expect(storage.archive('owned-maintenance')).rejects.toMatchObject({
      code: 'actor_owner_conflict',
      ownerRuntimeId: owner.runtimeId,
    });
    await expect(storage.archiveOwned('owned-maintenance', 'wrong-owner'))
      .rejects.toMatchObject({ code: 'actor_owner_conflict' });
    await expect(storage.archiveOwned('owned-maintenance', owner.ownerId))
      .resolves.toBe(true);
    await expect(storage.unarchive('owned-maintenance')).rejects.toMatchObject({
      code: 'actor_owner_conflict',
    });
    await expect(storage.unarchiveOwned('owned-maintenance', owner.ownerId))
      .resolves.toBe(true);
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const mainPath = path.join(
      testSessionsDir(),
      deriveProjectKeyFromRoot(data.gitRoot).key,
      'owned-maintenance.jsonl',
    );
    const bytesBeforeOwnedLoad = await readFile(mainPath);
    await expect(storage.load('owned-maintenance')).resolves.toMatchObject({
      errorMetadata: { consecutiveErrors: 1 },
      actorSnapshot: { owner },
    });
    expect(await readFile(mainPath)).toEqual(bytesBeforeOwnedLoad);
    await expect(storage.delete('owned-maintenance')).rejects.toMatchObject({
      code: 'actor_owner_conflict',
    });
    await expect(storage.deleteOwned('owned-maintenance', owner.ownerId))
      .resolves.toBeUndefined();
    await expect(storage.load('owned-maintenance')).resolves.toBeNull();

    const unknownOwnerSnapshot: AgentActorSnapshot = {
      ...actorSnapshot,
      owner: undefined,
      revision: 2,
      turns: [{
        turnId: 'turn_root_worker_1',
        actorPath: '/root',
        sequence: 1,
        state: 'accepted',
        objective: 'Must not be removed during owner handoff.',
        forkTurns: 'none',
        createdAt: now,
        progress: [],
        revision: 1,
      }],
    };
    await storage.save('unknown-owner-maintenance', {
      ...data,
      actorSnapshot: unknownOwnerSnapshot,
    });
    await expect(storage.delete('unknown-owner-maintenance')).rejects.toMatchObject({
      code: 'actor_owner_unknown',
      currentRevision: 2,
    });
  });

  it('round-trips extension state and extension records through JSONL session storage', async () => {
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    vi.doMock('./workspace-runtime.js', async () => {
      const actual = await vi.importActual<typeof import('./workspace-runtime.js')>('./workspace-runtime.js');
      return {
        ...actual,
        inspectWorkspaceRuntime: vi.fn(async () => ({
          canonicalRepoRoot: gitRoot,
          workspaceRoot: gitRoot,
          executionCwd: `${gitRoot}/packages/repl`,
          branch: 'feature/runtime-truth',
          workspaceKind: 'detected',
        })),
      };
    });

    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const runtimeInfo = {
      canonicalRepoRoot: gitRoot,
      workspaceRoot: gitRoot,
      executionCwd: `${gitRoot}/packages/repl`,
      branch: 'feature/runtime-truth',
      workspaceKind: 'detected' as const,
    };

    await storage.save('session-1', {
      messages: [{ role: 'user', content: 'hello persisted runtime' }],
      title: 'Persisted Runtime',
      gitRoot,
      runtimeInfo,
      uiHistory: [
        { type: 'user', text: 'hello persisted runtime' },
        { type: 'assistant', text: 'managed transcript survives resume' },
      ],
      extensionState: {
        'api:extension:C:/repo/extensions/sample.mjs': {
          phase: 'collecting',
          visits: 2,
        },
      },
      extensionRecords: [
        {
          id: 'record-1',
          extensionId: 'api:extension:C:/repo/extensions/sample.mjs',
          type: 'hydrate',
          ts: 1,
          data: { visits: 2 },
          dedupeKey: 'latest',
        },
      ],
      artifactLedger: [
        {
          id: 'artifact-1',
          kind: 'file_read',
          sourceTool: 'read',
          action: 'read',
          target: 'src/app.ts',
          displayTarget: 'src/app.ts',
          summary: 'Read src/app.ts',
          timestamp: '2026-04-03T00:00:00.000Z',
          metadata: { reason: 'resume' },
        },
      ],
    });

    await expect(storage.load('session-1')).resolves.toEqual({
      messages: [{ role: 'user', content: 'hello persisted runtime' }],
      title: 'Persisted Runtime',
      gitRoot,
      runtimeInfo,
      scope: 'user',
      uiHistory: [
        { type: 'user', text: 'hello persisted runtime' },
        { type: 'assistant', text: 'managed transcript survives resume' },
      ],
      errorMetadata: undefined,
      artifactLedger: [
        {
          id: 'artifact-1',
          kind: 'file_read',
          sourceTool: 'read',
          action: 'read',
          target: 'src/app.ts',
          displayTarget: 'src/app.ts',
          summary: 'Read src/app.ts',
          timestamp: '2026-04-03T00:00:00.000Z',
          metadata: { reason: 'resume' },
        },
      ],
      extensionState: {
        'api:extension:C:/repo/extensions/sample.mjs': {
          phase: 'collecting',
          visits: 2,
        },
      },
      extensionRecords: [
        {
          id: 'record-1',
          extensionId: 'api:extension:C:/repo/extensions/sample.mjs',
          type: 'hydrate',
          ts: 1,
          data: { visits: 2 },
          dedupeKey: 'latest',
        },
      ],
      lineage: expect.objectContaining({
        version: 2,
        entries: [
          expect.objectContaining({
            type: 'message',
            parentId: null,
            message: { role: 'user', content: 'hello persisted runtime' },
          }),
        ],
      }),
    });

    // v0.7.46 — list() now surfaces `createdAt` so the fast path in
    // session/public-api.ts can populate SessionSummary.createdAt
    // instead of silently dropping it. Use objectContaining since the
    // session writer auto-stamps createdAt with `new Date().toISOString()`.
    const listed = await storage.list(gitRoot);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: 'session-1',
      title: 'Persisted Runtime',
      msgCount: 1,
      runtimeInfo,
    });
    expect(typeof listed[0]?.createdAt).toBe('string');
  });

  it('round-trips a presentation-only failed managed turn', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const uiHistory = [
      {
        type: 'assistant' as const,
        text: 'Complete experiment summary before verification.',
        timestamp: 1_000,
        presentationOnly: true as const,
      },
      {
        type: 'sidecar' as const,
        text: 'The experiment is blocked.',
        icon: 'blocked',
        timestamp: 2_000,
        presentationOnly: true as const,
      },
      {
        type: 'error' as const,
        text: 'The managed runtime failed after verification.',
        timestamp: 3_000,
        presentationOnly: true as const,
      },
    ];

    await storage.save('sidecar-ui-history', {
      messages: [],
      title: 'Sidecar UI History',
      gitRoot,
      uiHistory,
    });

    const resumed = await storage.load('sidecar-ui-history');
    expect(resumed).toMatchObject({ uiHistory });

    await storage.save('sidecar-ui-history', resumed!);
    await expect(storage.load('sidecar-ui-history')).resolves.toMatchObject({ uiHistory });
    await expect(storage.list(gitRoot)).resolves.toEqual([
      expect.objectContaining({ id: 'sidecar-ui-history', msgCount: 3 }),
    ]);
  });

  it('uses runtimeInfo.executionCwd as the project key for non-git sessions', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { UNKNOWN_PROJECT_KEY, deriveProjectKeyFromData } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const executionCwd = process.platform === 'win32'
      ? 'C:/Users/surui/tmp'
      : '/mnt/c/Users/surui/tmp';
    const runtimeInfo = {
      executionCwd,
      workspaceKind: 'detected' as const,
    };

    await storage.save('non-git-session', {
      messages: [{ role: 'user', content: 'hello from non-git cwd' }],
      title: 'Non Git Session',
      gitRoot: '',
      runtimeInfo,
      scope: 'user',
    });

    const expectedKey = deriveProjectKeyFromData({ gitRoot: '', runtimeInfo }).key;
    expect(expectedKey).not.toBe(UNKNOWN_PROJECT_KEY);
    expect(existsSync(path.join(testSessionsDir(), expectedKey, 'non-git-session.jsonl'))).toBe(true);
    expect(existsSync(path.join(testSessionsDir(), UNKNOWN_PROJECT_KEY, 'non-git-session.jsonl'))).toBe(false);
  });

  it('does not overwrite a conflicting project identity manifest', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromData } = await import('./project-key.js');
    const canonicalRoot = path.join(tempHome, 'repo');
    const foreignRoot = path.join(tempHome, 'foreign-repo');
    const runtimeInfo = { canonicalRepoRoot: canonicalRoot, executionCwd: canonicalRoot };
    const projectDir = path.join(
      testSessionsDir(),
      deriveProjectKeyFromData({ gitRoot: canonicalRoot, runtimeInfo }).key,
    );
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({ canonicalRoot: foreignRoot }),
      'utf8',
    );
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir(), cwd: canonicalRoot });

    await expect(storage.save('identity-collision', {
      messages: [{ role: 'user', content: 'must not change the bucket identity' }],
      title: 'Identity collision',
      gitRoot: canonicalRoot,
      runtimeInfo,
    })).rejects.toMatchObject({ code: 'data_changed' });

    const persisted: unknown = JSON.parse(
      await readFile(path.join(projectDir, 'project.json'), 'utf8'),
    );
    expect(persisted).toMatchObject({ canonicalRoot: foreignRoot });
    expect(existsSync(path.join(projectDir, 'identity-collision.jsonl'))).toBe(false);
  });

  it('does not claim a non-empty project bucket whose identity manifest is missing', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromData } = await import('./project-key.js');
    const { LAYOUT_VERSION } = await import('./session-migration.js');
    const canonicalRoot = path.join(tempHome, 'repo');
    const foreignRoot = path.join(tempHome, 'foreign-repo');
    const runtimeInfo = { canonicalRepoRoot: canonicalRoot, executionCwd: canonicalRoot };
    const sessionsDir = testSessionsDir();
    const projectDir = path.join(
      sessionsDir,
      deriveProjectKeyFromData({ gitRoot: canonicalRoot, runtimeInfo }).key,
    );
    await mkdir(projectDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(sessionsDir, '.layout.json'), JSON.stringify({ version: LAYOUT_VERSION }), 'utf8'),
      writeFile(path.join(projectDir, 'foreign.jsonl'), JSON.stringify({
        _type: 'meta', id: 'foreign', title: 'foreign', gitRoot: foreignRoot,
        activeMessageCount: 1, runtimeInfo: { canonicalRepoRoot: foreignRoot },
      }) + '\n', 'utf8'),
    ]);
    const storage = new FileSessionStorage({ sessionsDir, cwd: canonicalRoot });

    await expect(storage.save('current', {
      messages: [{ role: 'user', content: 'must not claim a mixed bucket' }],
      title: 'Current project',
      gitRoot: canonicalRoot,
      runtimeInfo,
    })).rejects.toMatchObject({ code: 'data_changed' });

    expect(existsSync(path.join(projectDir, 'project.json'))).toBe(false);
    expect(existsSync(path.join(projectDir, 'current.jsonl'))).toBe(false);
    expect(existsSync(path.join(projectDir, 'foreign.jsonl'))).toBe(true);
  });

  it('rejects an in-place save that changes project identity after the manifest is lost', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromData } = await import('./project-key.js');
    const canonicalRoot = path.join(tempHome, 'repo');
    const foreignRoot = path.join(tempHome, 'foreign-repo');
    const currentRuntime = { canonicalRepoRoot: canonicalRoot, executionCwd: canonicalRoot };
    const foreignRuntime = { canonicalRepoRoot: foreignRoot, executionCwd: foreignRoot };
    const sessionsDir = testSessionsDir();
    const currentDir = path.join(
      sessionsDir,
      deriveProjectKeyFromData({ gitRoot: canonicalRoot, runtimeInfo: currentRuntime }).key,
    );
    const foreignDir = path.join(
      sessionsDir,
      deriveProjectKeyFromData({ gitRoot: foreignRoot, runtimeInfo: foreignRuntime }).key,
    );
    const storage = new FileSessionStorage({ sessionsDir, cwd: canonicalRoot });
    await storage.save('identity-change', {
      messages: [{ role: 'user', content: 'current project' }],
      title: 'Current project',
      gitRoot: canonicalRoot,
      runtimeInfo: currentRuntime,
    });
    await fsPromises.rm(path.join(currentDir, 'project.json'));
    await expect(storage.load('identity-change')).resolves.toMatchObject({ gitRoot: canonicalRoot });

    await expect(storage.save('identity-change', {
      messages: [{ role: 'user', content: 'foreign project' }],
      title: 'Foreign project',
      gitRoot: foreignRoot,
      runtimeInfo: foreignRuntime,
    })).rejects.toMatchObject({ code: 'data_changed' });

    await writeFile(path.join(currentDir, 'identity-change.jsonl'), '', 'utf8');
    await expect(storage.save('identity-change', {
      messages: [{ role: 'user', content: 'foreign project after corrupt tail' }],
      title: 'Foreign project after corrupt tail',
      gitRoot: foreignRoot,
      runtimeInfo: foreignRuntime,
    })).rejects.toMatchObject({ code: 'data_changed' });

    expect(existsSync(path.join(currentDir, 'identity-change.jsonl'))).toBe(true);
    expect(existsSync(path.join(currentDir, 'project.json'))).toBe(false);
    expect(existsSync(path.join(foreignDir, 'identity-change.jsonl'))).toBe(false);
  });

  it('does not collapse synthetic and real same-content messages during snapshot merge', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const realMessage = { role: 'user' as const, content: 'repeat' };
    const syntheticMessage = { role: 'user' as const, content: 'repeat', _synthetic: true };

    await storage.save('synthetic-prefix', {
      messages: [realMessage],
      title: 'Synthetic Prefix',
      gitRoot,
    });
    await storage.save('synthetic-prefix', {
      messages: [syntheticMessage],
      title: 'Synthetic Prefix',
      gitRoot,
    });

    await expect(storage.load('synthetic-prefix')).resolves.toMatchObject({
      messages: [syntheticMessage],
    });
  });

  it('keeps valid uiHistory siblings when one persisted item is malformed', async () => {
    const sessionsDir = path.join(tempHome, '.kodax', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(sessionsDir, 'malformed-ui-history.jsonl'),
      `${JSON.stringify({
        _type: 'meta',
        title: 'Malformed UI History',
        id: 'malformed-ui-history',
        gitRoot: 'C:/repo',
        createdAt: '2026-06-17T00:00:00.000Z',
        uiHistory: [
          { type: 'user', text: 'read the file' },
          {
            type: 'tool_group',
            tools: [
              {
                id: 'tool-live',
                name: 'read',
                status: 'executing',
              },
            ],
          },
          {
            type: 'tool_group',
            tools: [
              {
                id: 'tool-done',
                name: 'read',
                status: 'success',
                input: { path: 'README.md' },
                output: 'ok',
              },
            ],
          },
          { type: 'assistant', text: 'done' },
        ],
      })}\n`,
      'utf8',
    );

    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });

    await expect(storage.load('malformed-ui-history')).resolves.toMatchObject({
      uiHistory: [
        { type: 'user', text: 'read the file' },
        {
          type: 'tool_group',
          tools: [
            {
              id: 'tool-done',
              name: 'read',
              status: 'success',
              input: { path: 'README.md' },
              output: 'ok',
            },
          ],
        },
        { type: 'assistant', text: 'done' },
      ],
    });
  });

  it('lists sibling workspace sessions when canonical repo identity matches', async () => {
    vi.doMock('./workspace-runtime.js', async () => {
      const actual = await vi.importActual<typeof import('./workspace-runtime.js')>('./workspace-runtime.js');
      return {
        ...actual,
        inspectWorkspaceRuntime: vi.fn(async () => ({
          canonicalRepoRoot: 'C:/repo',
          workspaceRoot: 'C:/repo/worktrees/main',
          executionCwd: 'C:/repo/worktrees/main',
          branch: 'main',
          workspaceKind: 'detected',
        })),
      };
    });

    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const canonicalRepoRoot = 'C:/repo';
    const mainWorkspace = 'C:/repo/worktrees/main';
    const siblingWorkspace = 'C:/repo/worktrees/feature-runtime';

    await storage.save('session-main', {
      messages: [{ role: 'user', content: 'main workspace session' }],
      title: 'Main Workspace',
      gitRoot: mainWorkspace,
      runtimeInfo: {
        canonicalRepoRoot,
        workspaceRoot: mainWorkspace,
        executionCwd: mainWorkspace,
        branch: 'main',
        workspaceKind: 'detected',
      },
      scope: 'user',
    });

    await storage.save('session-sibling', {
      messages: [{ role: 'user', content: 'sibling workspace session' }],
      title: 'Sibling Workspace',
      gitRoot: siblingWorkspace,
      runtimeInfo: {
        canonicalRepoRoot,
        workspaceRoot: siblingWorkspace,
        executionCwd: `${siblingWorkspace}/packages/repl`,
        branch: 'feature/runtime-truth',
        workspaceKind: 'managed',
      },
      scope: 'user',
    });

    await storage.save('session-other-repo', {
      messages: [{ role: 'user', content: 'other repo session' }],
      title: 'Other Repo',
      gitRoot: 'C:/other/workspace',
      runtimeInfo: {
        canonicalRepoRoot: 'C:/other',
        workspaceRoot: 'C:/other/workspace',
        executionCwd: 'C:/other/workspace',
        branch: 'main',
        workspaceKind: 'detected',
      },
      scope: 'user',
    });

    const sessions = await storage.list(mainWorkspace);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((session) => session.id)).toEqual(
      expect.arrayContaining(['session-main', 'session-sibling']),
    );
    expect(sessions.map((session) => session.id)).not.toContain('session-other-repo');
    expect(sessions.find((session) => session.id === 'session-sibling')).toMatchObject({
      runtimeInfo: {
        canonicalRepoRoot,
        workspaceRoot: siblingWorkspace,
        branch: 'feature/runtime-truth',
        workspaceKind: 'managed',
      },
    });
  });

  it('does not let a stale git root override a foreign canonical identity while listing', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = testSessionsDir();
    const projectRoot = path.join(tempHome, 'current-project');
    const foreignRoot = path.join(tempHome, 'foreign-project');
    const projectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(projectRoot).key);
    await mkdir(projectDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(projectDir, 'project.json'), JSON.stringify({ canonicalRoot: projectRoot }), 'utf8'),
      writeFile(path.join(projectDir, 'conflicting-identity.jsonl'), `${JSON.stringify({
        _type: 'meta',
        id: 'conflicting-identity',
        title: 'Conflicting identity',
        gitRoot: projectRoot,
        scope: 'user',
        activeMessageCount: 1,
        runtimeInfo: { canonicalRepoRoot: foreignRoot },
      })}\n`, 'utf8'),
    ]);

    await expect(new FileSessionStorage({ sessionsDir, cwd: projectRoot }).list(projectRoot))
      .resolves.toEqual([]);
  });

  // v0.7.38 FEATURE_157 — Windows-aware path equality in session-list
  // gating. Production reproduction (user report 2026-05-11): session
  // saved with `gitRoot: 'C:/Works/.../KodaX'`; a subsequent shell where
  // `getGitRoot()` returns lowercase drive letter `c:/Works/.../KodaX`
  // hit the literal `===` comparison and excluded every prior
  // same-repo session, leaving `kodax -c` / `kodax -r` to start fresh
  // with no resume context (the user's "previous conversation lost"
  // symptom). Two arms cover: (a) the workspaceRoot branch when
  // sessionRuntime carries it, (b) the gitRoot fallback when it
  // doesn't (older sessions without runtimeInfo are exactly this
  // shape — every session in the user's reproduction lacked the
  // runtimeInfo field).
  it('FEATURE_157: lists same-repo sessions across drive-letter case differences (Windows / darwin parity)', async () => {
    // The bug only manifests on case-insensitive filesystems (win32 +
    // darwin). On strict-case POSIX (most Linux) the pre-fix literal
    // equality is correct, so the case-insensitive branch should not
    // fire — skip the test there so we don't pin behaviour we don't
    // want.
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      return;
    }
    // The session was saved with uppercase drive letter (typical when
    // launched from a fresh PowerShell where node returns the literal
    // user-typed path).
    const savedGitRoot = 'C:/Works/GitWorks/KodaX-author/KodaX';
    // The session is being listed from a shell where the runtime
    // returns a different case (typical from a VS Code-spawned shell
    // or from a path that went through `process.cwd()` normalisation
    // on some Windows configurations).
    const lookupGitRoot = 'c:/Works/GitWorks/KodaX-author/KodaX';

    vi.doMock('./workspace-runtime.js', async () => {
      const actual = await vi.importActual<typeof import('./workspace-runtime.js')>('./workspace-runtime.js');
      return {
        ...actual,
        // Mock returns the lowercase variant — what the resume-time
        // shell perceives. The session on disk has the uppercase
        // variant. Pre-FEATURE_157 the literal `===` would fail and
        // exclude the session; post-FEATURE_157 `pathsEqual` folds
        // case on win32/darwin and the session is included.
        inspectWorkspaceRuntime: vi.fn(async () => ({
          canonicalRepoRoot: undefined,
          workspaceRoot: undefined,
          executionCwd: lookupGitRoot,
          branch: undefined,
          workspaceKind: 'detected',
        })),
      };
    });

    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });

    // Save a session as it appears on disk in the production
    // reproduction — no runtimeInfo (legacy sessions don't have it).
    await storage.save('session-uppercase', {
      messages: [{ role: 'user', content: 'session saved with uppercase C:' }],
      title: 'Pre-existing Conversation',
      gitRoot: savedGitRoot,
      scope: 'user',
    });

    // Listing with the lowercase variant MUST surface the session.
    const sessions = await storage.list(lookupGitRoot);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('session-uppercase');
  });

  it('supports branch switching, checkpoint labels, and forking without losing prior history', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');

    await storage.save('session-tree', {
      messages: [
        { role: 'user', content: 'root task' },
        { role: 'assistant', content: 'first pass' },
      ],
      title: 'Tree Session',
      gitRoot,
    });

    const initial = await storage.getLineage?.('session-tree');
    expect(initial?.entries).toHaveLength(2);
    const rootId = initial?.entries[0]?.id;
    expect(rootId).toBeTruthy();

    const rewound = await storage.setActiveEntry?.(
      'session-tree',
      rootId!,
      { summarizeCurrentBranch: true },
    );
    expect(rewound).toMatchObject({
      messages: [
        { role: 'user', content: 'root task' },
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('The following is a summary of a branch'),
        }),
      ],
    });

    await storage.save('session-tree', {
      messages: [
        ...(rewound?.messages ?? []),
        { role: 'user', content: 'root task follow-up' },
        { role: 'assistant', content: 'second pass' },
      ],
      title: 'Tree Session',
      gitRoot,
    });

    const labeled = await storage.setLabel?.('session-tree', rootId!, 'checkpoint-a');
    if (labeled?.lineage === undefined) throw new Error('expected labeled lineage');

    // Ink adopts the returned canonical lineage before its next ordinary
    // turn. Reproduce that transition so a later full snapshot cannot erase
    // the just-persisted checkpoint label.
    const continuedMessages = [
      ...labeled.messages,
      { role: 'user' as const, content: 'continue after checkpoint' },
      { role: 'assistant' as const, content: 'checkpoint preserved' },
    ];
    await storage.appendSessionDelta('session-tree', {
      ...labeled,
      messages: continuedMessages,
      lineage: createSessionLineage(continuedMessages, labeled.lineage),
    });

    const branched = await storage.getLineage?.('session-tree');
    expect(branched?.entries.filter((entry: { type: string }) => entry.type === 'label')).toHaveLength(1);
    expect(branched?.entries.filter((entry: { type: string }) => entry.type === 'branch_summary')).toHaveLength(1);
    expect(branched?.entries.filter((entry: { type: string }) => entry.type === 'message')).toHaveLength(6);

    const forked = await storage.fork?.('session-tree', 'checkpoint-a', { sessionId: 'forked-tree' });
    expect(forked?.sessionId).toBe('forked-tree');
    expect(forked?.data.messages).toEqual([
      { role: 'user', content: 'root task' },
    ]);

    await expect(storage.load('session-tree')).resolves.toMatchObject({
      messages: [
        { role: 'user', content: 'root task' },
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('The following is a summary of a branch'),
        }),
        { role: 'user', content: 'root task follow-up' },
        { role: 'assistant', content: 'second pass' },
        { role: 'user', content: 'continue after checkpoint' },
        { role: 'assistant', content: 'checkpoint preserved' },
      ],
    });
  });

  it('persists compaction anchors and artifact ledgers through JSONL round-trips', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');

    const baseLineage = createSessionLineage([
      { role: 'user', content: 'root task' },
      { role: 'assistant', content: 'initial implementation' },
    ]);
    const lineage = applySessionCompaction(
      baseLineage,
      [
        { role: 'system', content: '[对话历史摘要]\n\nCompacted summary' },
        { role: 'assistant', content: 'continue from summary' },
      ],
      {
        summary: 'Compacted summary',
        tokensBefore: 1000,
        tokensAfter: 250,
        artifactLedgerId: 'ledger_abc123',
        reason: 'automatic_compaction',
        details: {
          readFiles: ['src/app.ts'],
          modifiedFiles: ['src/feature.ts'],
        },
        memorySeed: {
          objective: 'Continue from summary',
          constraints: ['Keep scope tight'],
          progress: {
            completed: ['Compacted old context'],
            inProgress: ['Resume latest implementation'],
            blockers: [],
          },
          keyDecisions: ['Keep the summary durable'],
          nextSteps: ['Continue the feature'],
          keyContext: ['src/app.ts'],
          importantTargets: ['src/feature.ts'],
          tombstones: [],
        },
      },
    );

    await storage.save('session-compacted', {
      messages: [
        { role: 'system', content: '[对话历史摘要]\n\nCompacted summary' },
        { role: 'assistant', content: 'continue from summary' },
      ],
      title: 'Compacted Session',
      gitRoot,
      lineage,
      artifactLedger: [
        {
          id: 'artifact-1',
          kind: 'file_modified',
          sourceTool: 'edit',
          action: 'edit',
          target: 'src/feature.ts',
          displayTarget: 'src/feature.ts',
          summary: 'Edited src/feature.ts',
          timestamp: '2026-04-03T00:00:00.000Z',
        },
      ],
    });

    await expect(storage.load('session-compacted')).resolves.toEqual(
      expect.objectContaining({
        title: 'Compacted Session',
        artifactLedger: [
          expect.objectContaining({
            id: 'artifact-1',
            kind: 'file_modified',
            target: 'src/feature.ts',
          }),
        ],
        lineage: expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({
              type: 'compaction',
              summary: 'Compacted summary',
              artifactLedgerId: 'ledger_abc123',
              firstKeptEntryId: expect.any(String),
              memorySeed: expect.objectContaining({
                objective: 'Continue from summary',
              }),
            }),
          ]),
        }),
      }),
    );
  });

  it('hides managed-task worker sessions from default session listing and sorts by createdAt', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');

    await storage.save('20260326_100000', {
      messages: [{ role: 'user', content: 'older user session' }],
      title: 'Older User',
      gitRoot,
      scope: 'user',
    });
    await storage.save('managed-task-worker-task-abc-sidecar', {
      messages: [{ role: 'assistant', content: 'internal sidecar session' }],
      title: 'Internal Worker',
      gitRoot,
      scope: 'managed-task-worker',
    });
    await storage.save('custom-user-session', {
      messages: [{ role: 'user', content: 'newer user session' }],
      title: 'Newer User',
      gitRoot,
      scope: 'user',
    });

    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = path.join(tempHome, '.kodax', 'sessions', deriveProjectKeyFromRoot(gitRoot).key);
    const olderPath = path.join(sessionsDir, '20260326_100000.jsonl');
    const newerPath = path.join(sessionsDir, 'custom-user-session.jsonl');
    const olderContent = await readFile(olderPath, 'utf8');
    const newerContent = await readFile(newerPath, 'utf8');
    const newerCreatedAt = '2026-03-26T11:00:00.000Z';
    const olderCreatedAt = '2026-03-26T10:00:00.000Z';

    await Promise.all([
      writeFile(
        olderPath,
        olderContent.replace(/\"createdAt\":\"[^\"]+\"/, `"createdAt":"${olderCreatedAt}"`),
        'utf8',
      ),
      writeFile(
        newerPath,
        newerContent.replace(/\"createdAt\":\"[^\"]+\"/, `"createdAt":"${newerCreatedAt}"`),
        'utf8',
      ),
    ]);

    // v0.7.46 — list() now surfaces `createdAt` (F3 fix). Verify
    // ordering + payload via toMatchObject so we don't have to enumerate
    // exact timestamps.
    const listed = await storage.list(gitRoot);
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({
      id: 'custom-user-session',
      title: 'Newer User',
      msgCount: 1,
    });
    expect(listed[1]).toMatchObject({
      id: '20260326_100000',
      title: 'Older User',
      msgCount: 1,
    });
    // createdAt is the sort key for these two — verify both are present
    // strings so a future regression that drops it surfaces here too.
    expect(typeof listed[0]?.createdAt).toBe('string');
    expect(typeof listed[1]?.createdAt).toBe('string');
  });

  it('excludes .archive.jsonl and archived- prefixed files from the session list', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');

    await storage.save('20260401_120000', {
      messages: [{ role: 'user', content: 'live session' }],
      title: 'Live',
      gitRoot,
      scope: 'user',
    });

    const sessionsDir = path.join(tempHome, '.kodax', 'sessions');
    const metaLine = (title: string, createdAt: string) =>
      `${JSON.stringify({ _type: 'meta', title, gitRoot, createdAt, scope: 'user', activeMessageCount: 9 })}\n`;
    // A round archive ends in `.jsonl` too — the old listing logic read it and
    // surfaced a bogus `<id>.archive` session. It must be excluded.
    await writeFile(path.join(sessionsDir, '20260330_090000.archive.jsonl'), metaLine('RoundArchive', '2026-03-30T09:00:00.000Z'), 'utf8');
    // FEATURE_219 — the renamed island sidecar must also be excluded.
    await writeFile(path.join(sessionsDir, '20260330_091000.islands.jsonl'), metaLine('IslandSidecar', '2026-03-30T09:10:00.000Z'), 'utf8');
    // `archived-` prefixed files are the session-archive mechanism — hidden from
    // the picker/SDK fast path, consistent with the public-api slow path.
    await writeFile(path.join(sessionsDir, 'archived-20260301_080000.jsonl'), metaLine('ArchivedSession', '2026-03-01T08:00:00.000Z'), 'utf8');

    const ids = (await storage.list(gitRoot)).map((session) => session.id);
    expect(ids).toContain('20260401_120000');
    expect(ids).not.toContain('20260330_090000.archive');
    expect(ids).not.toContain('20260330_090000');
    expect(ids).not.toContain('20260330_091000.islands');
    expect(ids).not.toContain('20260330_091000');
    expect(ids).not.toContain('archived-20260301_080000');
  });

  it('reports msgCount from the meta head only — ignores appended body lines (no full-file read)', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');

    await storage.save('20260401_130000', {
      messages: [{ role: 'user', content: 'hi' }],
      title: 'Head',
      gitRoot,
      scope: 'user',
    });

    // Append 2000 junk lines AFTER the meta line. A whole-file line count would
    // inflate msgCount; the head-read path uses the meta's activeMessageCount and
    // never sees these lines. FEATURE_219: the file lives under the per-project dir.
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const projectKey = deriveProjectKeyFromRoot(gitRoot).key;
    const filePath = path.join(tempHome, '.kodax', 'sessions', projectKey, '20260401_130000.jsonl');
    const junk = `${Array.from({ length: 2000 }, (_, i) => JSON.stringify({ _type: 'noise', i })).join('\n')}\n`;
    await writeFile(filePath, `${await readFile(filePath, 'utf8')}${junk}`, 'utf8');

    const session = (await storage.list(gitRoot)).find((s) => s.id === '20260401_130000');
    expect(session?.msgCount).toBe(1);
  });

  it('cleanupOldSessions removes files (and archives) older than the retention window, keeps recent', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');

    await storage.save('20260101_000000', {
      messages: [{ role: 'user', content: 'old' }],
      title: 'Old',
      gitRoot,
      scope: 'user',
    });
    await storage.save('20260401_000000', {
      messages: [{ role: 'user', content: 'recent' }],
      title: 'Recent',
      gitRoot,
      scope: 'user',
    });

    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = path.join(tempHome, '.kodax', 'sessions', deriveProjectKeyFromRoot(gitRoot).key);
    const oldPath = path.join(sessionsDir, '20260101_000000.jsonl');
    const oldArchivePath = path.join(sessionsDir, '20260101_000000.archive.jsonl');
    const recentPath = path.join(sessionsDir, '20260401_000000.jsonl');
    await writeFile(oldArchivePath, 'archived\n', 'utf8');

    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await utimes(oldPath, sixtyDaysAgo, sixtyDaysAgo);
    await utimes(oldArchivePath, sixtyDaysAgo, sixtyDaysAgo);

    const removed = await storage.cleanupOldSessions(30);
    expect(removed).toBe(2);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(oldArchivePath)).toBe(false);
    expect(existsSync(recentPath)).toBe(true);
  });

  it('recovers a valid canonical prefix and diagnoses a partially written tail', async () => {
    const sessionsDir = path.join(tempHome, '.kodax', 'sessions');
    const sessionId = 'partial-tail-prefix-recovery';
    const timestamp = '2026-08-04T19:54:11.000Z';
    const entry = {
      id: 'entry_before_daemon_crash',
      parentId: null,
      timestamp,
      type: 'message' as const,
      message: { role: 'user' as const, content: 'durable before crash' },
    };
    const diagnostics: string[] = [];
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          _type: 'meta',
          id: sessionId,
          title: 'Partial Tail Prefix Recovery',
          gitRoot: '/tmp/test-repo',
          createdAt: timestamp,
          lineageVersion: 2,
          activeEntryId: entry.id,
          activeMessageCount: 1,
        }),
        JSON.stringify({ _type: 'lineage_entry', entry }),
        '{"_type":"lineage_entry","entry":',
      ].join('\n'),
      'utf8',
    );

    const { FileSessionStorage } = await import('./storage.js');
    const { setKodaXDiagnosticSink } = await import('@kodax-ai/agent');
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => {
      diagnostics.push(diagnostic.message);
    });
    try {
      const storage = new FileSessionStorage({ sessionsDir });

      await expect(storage.load(sessionId)).resolves.toMatchObject({
        messages: [{ role: 'user', content: 'durable before crash' }],
      });
      expect(diagnostics).toContainEqual(
        expect.stringContaining(`${sessionId}.jsonl`),
      );
    } finally {
      restoreDiagnostics();
    }
  });

  it('cleanupOldSessions never removes an old Session with a durable Actor owner', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const sessionId = 'retention-owned-actor';
    const now = '2026-07-28T00:00:00.000Z';
    const actorSnapshot = {
      schemaVersion: 2 as const,
      revision: 1,
      maxConcurrentThreads: 4,
      owner: {
        ownerId: 'owner-retention',
        runtimeId: 'runtime-retention',
        pid: process.pid,
        startedAt: now,
      },
      actors: [{
        path: '/root',
        taskName: 'root',
        kind: 'native' as const,
        state: 'running' as const,
        capabilities: {
          tools: ['*'],
          filesystem: 'write' as const,
          network: true,
          providers: ['*'],
          canAskUser: true,
        },
        turnIds: [],
        mailboxCursor: 0,
        createdAt: now,
        updatedAt: now,
        revision: 1,
      }],
      turns: [],
      mailboxes: { '/root': [] },
      events: [],
    };
    await storage.save(sessionId, {
      messages: [],
      title: 'Owned Actor',
      gitRoot,
      scope: 'user',
      actorSnapshot,
    });
    const mainPath = path.join(
      testSessionsDir(),
      deriveProjectKeyFromRoot(gitRoot).key,
      `${sessionId}.jsonl`,
    );
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await utimes(mainPath, sixtyDaysAgo, sixtyDaysAgo);

    await expect(storage.cleanupOldSessions(30)).resolves.toBe(0);
    expect(existsSync(mainPath)).toBe(true);
    await expect(storage.load(sessionId)).resolves.toMatchObject({
      actorSnapshot: {
        owner: expect.objectContaining({ ownerId: 'owner-retention' }),
      },
    });
  });

  it('cleanupOldSessions is a no-op when retention is disabled (0 / negative / NaN)', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');

    await storage.save('20260101_010000', {
      messages: [{ role: 'user', content: 'old' }],
      title: 'Old',
      gitRoot,
      scope: 'user',
    });
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const oldPath = path.join(
      tempHome, '.kodax', 'sessions', deriveProjectKeyFromRoot(gitRoot).key, '20260101_010000.jsonl',
    );
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await utimes(oldPath, sixtyDaysAgo, sixtyDaysAgo);

    await expect(storage.cleanupOldSessions(0)).resolves.toBe(0);
    await expect(storage.cleanupOldSessions(-5)).resolves.toBe(0);
    await expect(storage.cleanupOldSessions(Number.NaN)).resolves.toBe(0);
    expect(existsSync(oldPath)).toBe(true);
  });

  it('appendSessionDelta round-trips correctly: append → load → data consistent', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');

    // First save to seed the file
    const lineage1 = createSessionLineage([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]);
    await storage.save('session-append', {
      messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }],
      title: 'Append Test',
      gitRoot,
      lineage: lineage1,
    });

    // Load to initialize watermark
    const loaded1 = await storage.load('session-append');
    expect(loaded1).toBeTruthy();

    // Append new messages
    const lineage2 = createSessionLineage([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
      { role: 'user', content: 'follow-up' },
      { role: 'assistant', content: 'follow-up reply' },
    ], loaded1!.lineage);
    await storage.appendSessionDelta('session-append', {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
        { role: 'user', content: 'follow-up' },
        { role: 'assistant', content: 'follow-up reply' },
      ],
      title: 'Append Test Updated',
      gitRoot,
      lineage: lineage2,
    });

    // Reload and verify
    const loaded2 = await storage.load('session-append');
    expect(loaded2?.title).toBe('Append Test Updated');
    expect(loaded2?.messages).toHaveLength(4);
    expect(loaded2?.messages[2]).toEqual({ role: 'user', content: 'follow-up' });
    expect(loaded2?.lineage?.entries.length).toBe(lineage2.entries.length);
  });

  it('does not duplicate or lose deltas appended by separate storage instances', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const first = new FileSessionStorage({ sessionsDir });
    const second = new FileSessionStorage({ sessionsDir });
    const sessionId = 'session-cross-instance-append';
    const baseMessages = [{ role: 'user' as const, content: 'shared base' }];
    await first.save(sessionId, {
      messages: baseMessages,
      title: 'Cross-instance append',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(baseMessages),
    });
    const [firstBase, secondBase] = await Promise.all([
      first.load(sessionId),
      second.load(sessionId),
    ]);
    if (!firstBase?.lineage || !secondBase?.lineage) {
      throw new Error('expected both storage instances to load the base lineage');
    }
    const firstMessages = [
      ...baseMessages,
      { role: 'assistant' as const, content: 'delta from first runtime' },
    ];
    const secondMessages = [
      ...baseMessages,
      { role: 'assistant' as const, content: 'delta from second runtime' },
    ];

    await Promise.all([
      first.appendSessionDelta(sessionId, {
        ...firstBase,
        messages: firstMessages,
        lineage: createSessionLineage(firstMessages, firstBase.lineage),
      }),
      second.appendSessionDelta(sessionId, {
        ...secondBase,
        messages: secondMessages,
        lineage: createSessionLineage(secondMessages, secondBase.lineage),
      }),
    ]);

    const full = await new FileSessionStorage({ sessionsDir }).loadFullLineage(sessionId);
    const persistedMessages = full?.entries
      .filter((entry) => entry.type === 'message')
      .map((entry) => entry.message.content);
    expect(persistedMessages?.filter(
      (content) => content === 'delta from first runtime',
    )).toHaveLength(1);
    expect(persistedMessages?.filter(
      (content) => content === 'delta from second runtime',
    )).toHaveLength(1);
  });

  it('preserves a durable same-ID rewrite when a stale instance rewrites that ID', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const first = new FileSessionStorage({ sessionsDir });
    const second = new FileSessionStorage({ sessionsDir });
    const sessionId = 'session-concurrent-same-id-rewrite';
    const baseMessages = [{ role: 'user' as const, content: 'shared original' }];
    await first.save(sessionId, {
      messages: baseMessages,
      title: 'Concurrent same-ID rewrite',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(baseMessages),
    });
    const [firstBase, secondBase] = await Promise.all([
      first.load(sessionId),
      second.load(sessionId),
    ]);
    const firstEntry = firstBase?.lineage?.entries[0];
    const secondEntry = secondBase?.lineage?.entries[0];
    if (
      !firstBase?.lineage
      || !secondBase?.lineage
      || firstEntry?.type !== 'message'
      || secondEntry?.type !== 'message'
    ) {
      throw new Error('expected both instances to load the base message lineage');
    }
    const firstRewrite = {
      ...firstEntry,
      message: { ...firstEntry.message, content: 'first durable rewrite' },
    };
    const firstTail = {
      type: 'message' as const,
      id: 'entry_first_rewrite_tail',
      parentId: firstRewrite.id,
      logicalId: 'entry_first_rewrite_tail',
      timestamp: '2026-08-02T00:00:02.000Z',
      message: { role: 'assistant' as const, content: 'first durable tail' },
    };
    await first.appendSessionDelta(sessionId, {
      ...firstBase,
      messages: [firstRewrite.message, firstTail.message],
      lineage: {
        ...firstBase.lineage,
        activeEntryId: firstTail.id,
        entries: [firstRewrite, firstTail],
      },
    });

    const secondRewrite = {
      ...secondEntry,
      message: { ...secondEntry.message, content: 'second stale rewrite' },
    };
    const secondTail = {
      type: 'message' as const,
      id: 'entry_second_rewrite_tail',
      parentId: secondRewrite.id,
      logicalId: 'entry_second_rewrite_tail',
      timestamp: '2026-08-02T00:00:03.000Z',
      message: { role: 'assistant' as const, content: 'second stale tail' },
    };
    await second.appendSessionDelta(sessionId, {
      ...secondBase,
      messages: [secondRewrite.message, secondTail.message],
      lineage: {
        ...secondBase.lineage,
        activeEntryId: secondTail.id,
        entries: [secondRewrite, secondTail],
      },
    });

    const reader = new FileSessionStorage({ sessionsDir });
    const full = await reader.loadFullLineage(sessionId);
    expect(full?.entries).toContainEqual(expect.objectContaining({
      id: firstEntry.id,
      type: 'message',
      message: expect.objectContaining({ content: 'first durable rewrite' }),
    }));
    expect(full?.entries).not.toContainEqual(expect.objectContaining({
      id: firstEntry.id,
      type: 'message',
      message: expect.objectContaining({ content: 'second stale rewrite' }),
    }));
    expect(full?.entries.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      firstTail.id,
      secondTail.id,
    ]));
    await expect(reader.load(sessionId)).resolves.toMatchObject({
      messages: [
        { content: 'first durable rewrite' },
        { content: 'second stale tail' },
      ],
    });
  });

  it('appends to the exact archived path after another storage instance moves the Session', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = testSessionsDir();
    const writer = new FileSessionStorage({ sessionsDir });
    const mover = new FileSessionStorage({ sessionsDir });
    const sessionId = 'session-archived-cross-instance-append';
    const baseMessages = [{ role: 'user' as const, content: 'archive base' }];
    await writer.save(sessionId, {
      messages: baseMessages,
      title: 'Archived append',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(baseMessages),
    });
    const stale = await writer.load(sessionId);
    if (!stale?.lineage) throw new Error('expected stale lineage');
    await mover.archive(sessionId);
    const messages = [
      ...baseMessages,
      { role: 'assistant' as const, content: 'archived delta' },
    ];

    await writer.appendSessionDelta(sessionId, {
      ...stale,
      messages,
      lineage: createSessionLineage(messages, stale.lineage),
    });

    const projectDir = path.join(
      sessionsDir,
      deriveProjectKeyFromRoot(KODAX_REPO_ROOT).key,
    );
    expect(existsSync(path.join(projectDir, `${sessionId}.jsonl`))).toBe(false);
    expect(existsSync(path.join(projectDir, 'archived', `${sessionId}.jsonl`))).toBe(true);
    await expect(writer.load(sessionId)).resolves.toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ content: 'archived delta' }),
      ]),
    });
  });

  it('merges a same-length cross-instance lineage rewrite before appending', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const first = new FileSessionStorage({ sessionsDir });
    const staleWriter = new FileSessionStorage({ sessionsDir });
    const sessionId = 'session-same-length-rewrite';
    const baseMessages = [{ role: 'user' as const, content: 'original base' }];
    await first.save(sessionId, {
      messages: baseMessages,
      title: 'Same length rewrite',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(baseMessages),
    });
    const stale = await staleWriter.load(sessionId);
    if (!stale?.lineage) throw new Error('expected stale lineage');
    const rewrittenMessages = [{ role: 'user' as const, content: 'rewritten base' }];
    await first.save(sessionId, {
      ...stale,
      messages: rewrittenMessages,
      lineage: createSessionLineage(rewrittenMessages),
    });
    const staleMessages = [
      ...baseMessages,
      { role: 'assistant' as const, content: 'stale writer delta' },
    ];

    await staleWriter.appendSessionDelta(sessionId, {
      ...stale,
      messages: staleMessages,
      lineage: createSessionLineage(staleMessages, stale.lineage),
    });

    const full = await first.loadFullLineage(sessionId);
    const ids = new Set(full?.entries.map((entry) => entry.id));
    expect(full?.entries.every(
      (entry) => entry.parentId === null || ids.has(entry.parentId),
    )).toBe(true);
    expect(full?.entries).toContainEqual(expect.objectContaining({
      type: 'message',
      message: expect.objectContaining({ content: 'rewritten base' }),
    }));
    expect(full?.entries).toContainEqual(expect.objectContaining({
      type: 'message',
      message: expect.objectContaining({ content: 'stale writer delta' }),
    }));
  });

  it('persists a caller-owned same-ID prefix rewrite before appending its tail', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const sessionId = 'session-local-prefix-rewrite';
    const originalMessages = [{ role: 'user' as const, content: 'before rewrite' }];
    await storage.save(sessionId, {
      messages: originalMessages,
      title: 'Local prefix rewrite',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(originalMessages),
    });
    const loaded = await storage.load(sessionId);
    const original = loaded?.lineage?.entries[0];
    if (!loaded?.lineage || original?.type !== 'message') {
      throw new Error('expected persisted message lineage');
    }
    const rewritten = {
      ...original,
      message: { ...original.message, content: 'after rewrite' },
    };
    const tail = {
      type: 'message' as const,
      id: 'entry_local_tail',
      parentId: rewritten.id,
      logicalId: 'entry_local_tail',
      timestamp: '2026-08-02T00:00:00.000Z',
      message: { role: 'assistant' as const, content: 'new tail' },
    };

    await storage.appendSessionDelta(sessionId, {
      ...loaded,
      messages: [rewritten.message, tail.message],
      lineage: {
        ...loaded.lineage,
        activeEntryId: tail.id,
        entries: [rewritten, tail],
      },
    });

    await expect(storage.load(sessionId)).resolves.toMatchObject({
      messages: [
        { content: 'after rewrite' },
        { content: 'new tail' },
      ],
    });
  });

  it('persists caller-owned same-ID parent and provenance rewrites', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const sessionId = 'session-local-topology-rewrite';
    const messages = [
      { role: 'user' as const, content: 'retired parent' },
      { role: 'assistant' as const, content: 'rewritten root' },
    ];
    await storage.save(sessionId, {
      messages,
      title: 'Local topology rewrite',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(messages),
    });
    const loaded = await storage.load(sessionId);
    const rewrittenTarget = loaded?.lineage?.entries[1];
    if (!loaded?.lineage || rewrittenTarget?.type !== 'message') {
      throw new Error('expected two persisted message entries');
    }
    const rewritten = {
      ...rewrittenTarget,
      parentId: null,
      logicalId: 'logical_rewritten_root',
      sourceEntryId: 'source_rewritten_root',
    };
    const tail = {
      type: 'message' as const,
      id: 'entry_topology_tail',
      parentId: rewritten.id,
      logicalId: 'entry_topology_tail',
      timestamp: '2026-08-02T00:00:01.000Z',
      message: { role: 'user' as const, content: 'topology tail' },
    };

    await storage.appendSessionDelta(sessionId, {
      ...loaded,
      messages: [rewritten.message, tail.message],
      lineage: {
        ...loaded.lineage,
        activeEntryId: tail.id,
        entries: [loaded.lineage.entries[0]!, rewritten, tail],
      },
    });

    const full = await storage.loadFullLineage(sessionId);
    expect(full?.entries.find((entry) => entry.id === rewritten.id)).toMatchObject({
      parentId: null,
      logicalId: 'logical_rewritten_root',
      sourceEntryId: 'source_rewritten_root',
    });
    await expect(storage.load(sessionId)).resolves.toMatchObject({
      messages: [
        { content: 'rewritten root' },
        { content: 'topology tail' },
      ],
    });
  });

  it('appendSessionDelta meta_update overwrites title but preserves extensionState from disk', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');

    // Save with extensionState
    await storage.save('session-meta-update', {
      messages: [{ role: 'user', content: 'test' }],
      title: 'Original Title',
      gitRoot,
      extensionState: { 'ext:sample': { phase: 'active', visits: 5 } },
    });

    // Load to init watermark
    const loaded1 = await storage.load('session-meta-update');
    expect(loaded1?.extensionState).toEqual({ 'ext:sample': { phase: 'active', visits: 5 } });

    // Append — caller doesn't provide extensionState (like InkREPL.persistContextState)
    await storage.appendSessionDelta('session-meta-update', {
      messages: [{ role: 'user', content: 'test' }, { role: 'assistant', content: 'reply' }],
      title: 'Updated Title',
      gitRoot,
      lineage: createSessionLineage([
        { role: 'user', content: 'test' },
        { role: 'assistant', content: 'reply' },
      ], loaded1!.lineage),
    });

    // Load — title should be updated, extensionState preserved from disk
    const loaded2 = await storage.load('session-meta-update');
    expect(loaded2?.title).toBe('Updated Title');
    // extensionState is in the meta line (first save), meta_update doesn't overwrite it
    expect(loaded2?.extensionState).toEqual({ 'ext:sample': { phase: 'active', visits: 5 } });
  });

  it('fences review jobs against the exact branch on setActiveEntry and rewind', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const configHome = path.join(tempHome, '.kodax');
    const storage = new FileSessionStorage({
      sessionsDir: testSessionsDir(),
      configHome,
    });
    const sessionId = 'session-review-fence';
    const reviewIdentity = {
      configHome,
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      projectId: 'project-a',
      sessionId,
    } as const;
    const makeDigest = (
      id: string,
      reviewKey: string,
      sequence: number,
    ): KodaXMemoryOutcomeDigest => ({
      id,
      reviewKey,
      sessionId,
      branchId: sessionId,
      sequence,
      objective: 'branch fence',
      approach: 'review',
      outcome: 'succeeded',
      summary: id,
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: `2026-07-27T00:00:0${sequence}.000Z`,
    });
    const digestA = makeDigest('digest-a', 'review-a', 9);
    const digestB = makeDigest('digest-b', 'review-b', 1);
    const jobA = await persistPendingEpisodeReview(reviewIdentity, digestA);
    const jobB = await persistPendingEpisodeReview(reviewIdentity, digestB);
    const lineage: KodaXSessionLineage = {
      version: 2,
      activeEntryId: 'branch-b',
      entries: [
        {
          type: 'message',
          id: 'root',
          logicalId: 'root',
          parentId: null,
          timestamp: '2026-07-27T00:00:00.000Z',
          message: { role: 'user', content: 'root' },
        },
        {
          type: 'message',
          id: 'branch-a',
          logicalId: 'branch-a',
          parentId: 'root',
          timestamp: '2026-07-27T00:00:01.000Z',
          message: { role: 'user', content: 'a' },
        },
        {
          type: 'memory_outcome_digest',
          id: 'lineage-digest-a',
          logicalId: 'lineage-digest-a',
          parentId: 'branch-a',
          timestamp: digestA.createdAt,
          jobId: jobA.entry.jobId,
          digest: digestA,
        },
        {
          type: 'message',
          id: 'branch-b',
          logicalId: 'branch-b',
          parentId: 'root',
          timestamp: '2026-07-27T00:00:02.000Z',
          message: { role: 'user', content: 'b' },
        },
        {
          type: 'memory_outcome_digest',
          id: 'lineage-digest-b',
          logicalId: 'lineage-digest-b',
          parentId: 'branch-b',
          timestamp: digestB.createdAt,
          jobId: jobB.entry.jobId,
          digest: digestB,
        },
      ],
    };
    await storage.save(sessionId, {
      messages: [
        { role: 'user', content: 'root' },
        { role: 'user', content: 'b' },
      ],
      lineage,
    });

    await storage.setActiveEntry(sessionId, 'branch-a');
    expect(await listPendingEpisodeReviews({
      configHome,
      tenantId: reviewIdentity.tenantId,
    })).toMatchObject([{ jobId: jobA.entry.jobId }]);

    await storage.rewind(sessionId, 'root');
    expect(await listPendingEpisodeReviews({
      configHome,
      tenantId: reviewIdentity.tenantId,
    })).toEqual([]);
  });

  it('atomically preserves a memory digest across a stale host snapshot save', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({
      sessionsDir: testSessionsDir(),
      configHome: path.join(tempHome, '.kodax'),
    });
    const sessionId = 'session-memory-atomic-lineage';
    const initialMessages = [{ role: 'user' as const, content: 'before review' }];
    await storage.save(sessionId, {
      messages: initialMessages,
      title: 'atomic lineage',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(initialMessages),
    });
    const stale = await storage.load(sessionId);
    if (stale?.lineage === undefined) throw new Error('expected stale host lineage');
    const digest: KodaXMemoryOutcomeDigest = {
      id: 'digest-atomic-lineage',
      reviewKey: 'review-atomic-lineage',
      sessionId,
      branchId: sessionId,
      sequence: 1,
      objective: 'preserve a fenced outcome',
      approach: 'mutate latest lineage',
      outcome: 'succeeded',
      summary: 'outcome persisted',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-07-27T00:00:00.000Z',
    };

    await storage.mutateLineage(sessionId, (lineage) => {
      const withDigest = appendMemoryOutcomeDigest(lineage, digest, 'job-atomic-lineage');
      const withReceipt = appendMemoryReviewReceipt(withDigest, {
        jobId: 'job-atomic-lineage',
        reviewKey: digest.reviewKey,
        proposalIds: ['proposal-atomic-lineage'],
        completedAt: '2026-07-27T00:01:00.000Z',
      });
      return appendMemoryClientNotice(withReceipt, {
        episodeId: digest.id,
        summaries: ['durable update'],
        proposalIds: ['proposal-atomic-lineage'],
        createdAt: '2026-07-27T00:01:00.000Z',
      });
    });
    const nextMessages = [
      ...initialMessages,
      { role: 'assistant' as const, content: 'new host state' },
    ];
    await storage.save(sessionId, {
      ...stale,
      messages: nextMessages,
      lineage: createSessionLineage(nextMessages, stale.lineage),
    });

    const loaded = await storage.load(sessionId);
    expect(loaded?.messages).toEqual(nextMessages);
    expect(loaded?.lineage?.entries).toContainEqual(expect.objectContaining({
      type: 'memory_outcome_digest',
      jobId: 'job-atomic-lineage',
    }));
    expect(loaded?.lineage?.entries).toContainEqual(expect.objectContaining({
      type: 'memory_review_receipt',
      jobId: 'job-atomic-lineage',
    }));
    expect(loaded?.lineage?.entries).toContainEqual(expect.objectContaining({
      type: 'client_notice',
      payload: { episodeId: digest.id, proposalIds: ['proposal-atomic-lineage'] },
    }));
  });

  it('atomically preserves sandbox worktree roots across a stale Session snapshot', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const sessionId = 'session-worktree-roots-atomic-runtime-info';
    const messages = [{ role: 'user' as const, content: 'before worktree registration' }];
    await storage.save(sessionId, {
      messages,
      title: 'atomic runtime info',
      gitRoot: KODAX_REPO_ROOT,
      runtimeInfo: {
        canonicalRepoRoot: KODAX_REPO_ROOT,
        surface: 'code',
      },
    });
    const stale = await storage.load(sessionId);
    if (stale === null) throw new Error('expected stale Session snapshot');

    await expect(storage.mutateRuntimeInfo(sessionId, (runtimeInfo) => ({
      ...(runtimeInfo ?? {}),
      sandboxWorktreeRoots: ['/repo/.kodax-worktree-one'],
    }))).resolves.toBe(true);
    await storage.save(sessionId, {
      ...stale,
      messages: [...messages, { role: 'assistant', content: 'stale host update' }],
      runtimeInfo: {
        canonicalRepoRoot: KODAX_REPO_ROOT,
        workspaceRoot: KODAX_REPO_ROOT,
      },
    });

    await expect(storage.load(sessionId)).resolves.toMatchObject({
      runtimeInfo: {
        canonicalRepoRoot: KODAX_REPO_ROOT,
        workspaceRoot: KODAX_REPO_ROOT,
        sandboxWorktreeRoots: ['/repo/.kodax-worktree-one'],
      },
    });
    await expect(storage.mutateRuntimeInfo(sessionId, (runtimeInfo) => ({
      ...(runtimeInfo ?? {}),
      sandboxWorktreeRoots: [],
    }))).resolves.toBe(true);
    await expect(storage.load(sessionId)).resolves.toMatchObject({
      runtimeInfo: { sandboxWorktreeRoots: [] },
    });

    const staleWithRegisteredRoot = await storage.load(sessionId);
    if (staleWithRegisteredRoot === null) throw new Error('expected registered-root snapshot');
    await expect(storage.mutateRuntimeInfo(sessionId, (runtimeInfo) => ({
      ...(runtimeInfo ?? {}),
      sandboxWorktreeRoots: ['/repo/.kodax-worktree-two'],
    }))).resolves.toBe(true);
    const staleBeforeRevocation = await storage.load(sessionId);
    if (staleBeforeRevocation === null) throw new Error('expected pre-revocation snapshot');
    await expect(storage.mutateRuntimeInfo(sessionId, (runtimeInfo) => ({
      ...(runtimeInfo ?? {}),
      sandboxWorktreeRoots: [],
    }))).resolves.toBe(true);
    await storage.save(sessionId, {
      ...staleBeforeRevocation,
      messages: [...messages, { role: 'assistant', content: 'stale post-revocation update' }],
    });
    await expect(storage.load(sessionId)).resolves.toMatchObject({
      runtimeInfo: { sandboxWorktreeRoots: [] },
    });
  });

  it('does not let a pre-rewind host snapshot restore the retired branch', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({
      sessionsDir: testSessionsDir(),
      configHome: path.join(tempHome, '.kodax'),
    });
    const sessionId = 'session-stale-after-rewind';
    const messages = [
      { role: 'user' as const, content: 'first question' },
      { role: 'assistant' as const, content: 'first answer' },
      { role: 'user' as const, content: 'retired question' },
      { role: 'assistant' as const, content: 'retired answer' },
    ];
    await storage.save(sessionId, {
      messages,
      title: 'rewind topology',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(messages),
    });
    const stale = await storage.load(sessionId);
    const target = stale?.lineage?.entries.find((entry) => entry.type === 'message')?.id;
    if (stale === null || target === undefined) throw new Error('expected stale rewind snapshot');

    await storage.rewind(sessionId, target);
    await storage.save(sessionId, stale);

    const loaded = await storage.load(sessionId);
    expect(loaded?.messages).toEqual([{ role: 'user', content: 'first question' }]);
    expect(loaded?.lineage?.entries).toContainEqual(expect.objectContaining({
      type: 'rewind_marker',
      targetId: target,
    }));
  });

  it('does not let a pre-compaction host snapshot restore compacted context', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({
      sessionsDir: testSessionsDir(),
      configHome: path.join(tempHome, '.kodax'),
    });
    const sessionId = 'session-stale-after-compaction';
    const messages = [
      { role: 'user' as const, content: 'old question' },
      { role: 'assistant' as const, content: 'old answer' },
    ];
    const initial = createSessionLineage(messages);
    await storage.save(sessionId, {
      messages,
      title: 'compaction topology',
      gitRoot: KODAX_REPO_ROOT,
      lineage: initial,
    });
    const stale = await storage.load(sessionId);
    if (stale === null) throw new Error('expected stale compaction snapshot');
    const keptMessages = [{ role: 'user' as const, content: 'kept context' }];
    const compacted = applySessionCompaction(initial, keptMessages, {
      summary: 'old work',
      reason: 'automatic_compaction',
    });
    await storage.save(sessionId, {
      ...stale,
      messages: keptMessages,
      lineage: compacted,
    });

    await storage.save(sessionId, stale);

    const loaded = await storage.load(sessionId);
    expect(loaded?.messages).toEqual(keptMessages);
    expect(loaded?.lineage?.entries).toContainEqual(expect.objectContaining({
      type: 'compaction',
      summary: 'old work',
    }));
  });

  it('rejects a stale compaction that did not inherit the persisted rewind', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({
      sessionsDir: testSessionsDir(),
      configHome: path.join(tempHome, '.kodax'),
    });
    const sessionId = 'session-stale-compaction-after-rewind';
    const messages = [
      { role: 'user' as const, content: 'first question' },
      { role: 'assistant' as const, content: 'first answer' },
      { role: 'user' as const, content: 'retired question' },
      { role: 'assistant' as const, content: 'retired answer' },
    ];
    const initial = createSessionLineage(messages);
    await storage.save(sessionId, {
      messages,
      title: 'conflicting topology',
      gitRoot: KODAX_REPO_ROOT,
      lineage: initial,
    });
    const stale = await storage.load(sessionId);
    const target = stale?.lineage?.entries.find((entry) => entry.type === 'message')?.id;
    if (stale?.lineage === undefined || target === undefined) {
      throw new Error('expected stale topology snapshot');
    }
    await storage.rewind(sessionId, target);
    const staleMessages = [{ role: 'user' as const, content: 'stale compacted branch' }];
    const staleCompaction = applySessionCompaction(stale.lineage, staleMessages, {
      summary: 'stale branch',
      reason: 'automatic_compaction',
    });

    await storage.save(sessionId, {
      ...stale,
      messages: staleMessages,
      lineage: staleCompaction,
    });

    const loaded = await storage.load(sessionId);
    expect(loaded?.messages).toEqual([{ role: 'user', content: 'first question' }]);
    expect(loaded?.lineage?.entries).toContainEqual(expect.objectContaining({
      type: 'rewind_marker',
      targetId: target,
    }));
    expect(loaded?.lineage?.entries).not.toContainEqual(expect.objectContaining({
      type: 'compaction',
      summary: 'stale branch',
    }));
  });

  it('serializes full saves and lineage mutations across storage instances', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const host = new FileSessionStorage({ sessionsDir });
    const reviewer = new FileSessionStorage({ sessionsDir });
    const sessionId = 'session-cross-instance-mutation';
    const initialMessages = [{ role: 'user' as const, content: 'base turn' }];
    await host.save(sessionId, {
      messages: initialMessages,
      title: 'cross-instance owner',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(initialMessages),
    });
    const originalRename = fsPromises.rename.bind(fsPromises);
    let releaseHostRename!: () => void;
    const hostRenameReleased = new Promise<void>((resolve) => {
      releaseHostRename = resolve;
    });
    let signalHostRename!: () => void;
    const hostRenameReached = new Promise<void>((resolve) => {
      signalHostRename = resolve;
    });
    let blocked = false;
    const rename = vi.spyOn(fsPromises, 'rename');
    rename.mockImplementation(async (oldPath, newPath) => {
      if (!blocked && String(newPath).endsWith(`${sessionId}.jsonl`)) {
        blocked = true;
        signalHostRename();
        await hostRenameReleased;
      }
      await originalRename(oldPath, newPath);
    });
    try {
      const nextMessages = [
        ...initialMessages,
        { role: 'assistant' as const, content: 'new owner turn' },
      ];
      const hostSave = host.save(sessionId, {
        messages: nextMessages,
        title: 'cross-instance owner',
        gitRoot: KODAX_REPO_ROOT,
        lineage: createSessionLineage(nextMessages),
      });
      await hostRenameReached;
      const receiptMutation = reviewer.mutateLineage(sessionId, (lineage) => (
        appendMemoryReviewReceipt(lineage, {
          jobId: 'job-cross-instance',
          reviewKey: 'review-cross-instance',
          proposalIds: ['proposal-cross-instance'],
          completedAt: '2026-07-27T00:01:00.000Z',
        })
      ));
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      releaseHostRename();
      await Promise.all([hostSave, receiptMutation]);

      const loaded = await host.load(sessionId);
      expect(loaded?.messages).toEqual(nextMessages);
      expect(loaded?.lineage?.entries).toContainEqual(expect.objectContaining({
        type: 'memory_review_receipt',
        jobId: 'job-cross-instance',
      }));
    } finally {
      releaseHostRename();
      rename.mockRestore();
    }
  });

  it('waits for a live session writer held longer than the learning lock timeout', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const storage = new FileSessionStorage({ sessionsDir });
    const sessionId = 'session-long-cross-instance-writer';
    const lockKey = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    const lockPath = path.join(sessionsDir, '.write-locks', `${lockKey}.lock`);
    let markLockHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      markLockHeld = resolve;
    });
    const holder = withKodaXFileLock(lockPath, async () => {
      markLockHeld();
      await new Promise<void>((resolve) => setTimeout(resolve, 5_600));
    });
    await lockHeld;

    const messages = [{ role: 'user' as const, content: 'wait for the live writer' }];
    await expect(storage.save(sessionId, {
      messages,
      title: 'long writer',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(messages),
    })).resolves.toBeUndefined();
    await holder;

    expect((await storage.load(sessionId))?.messages).toEqual(messages);
  });

  it('admits a phase-aware Actor save after a legal long Session lock wait', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const storage = new FileSessionStorage({ sessionsDir });
    const sessionId = 'actor-long-cross-instance-writer';
    const snapshot = actorStorageSnapshot(1);
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'wait before Actor CAS' }],
      title: 'Actor long writer',
      gitRoot: KODAX_REPO_ROOT,
      actorSnapshot: snapshot,
    });
    const lockKey = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    const lockPath = path.join(sessionsDir, '.write-locks', `${lockKey}.lock`);
    let markLockHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => { markLockHeld = resolve; });
    const holder = withKodaXFileLock(lockPath, async () => {
      markLockHeld();
      await new Promise<void>((resolve) => setTimeout(resolve, 5_600));
    });
    await lockHeld;

    const attempt = storage.beginActorSnapshotSave(
      sessionId,
      { ...snapshot, revision: 2 },
      1,
    );
    let eligible = false;
    void attempt.eligible.then(() => { eligible = true; });
    await attempt.dequeued;
    await new Promise<void>((resolve) => setTimeout(resolve, 5_100));
    expect(eligible).toBe(false);
    expect(attempt.phase()).toBe('queued');

    await holder;
    await attempt.eligible;
    await attempt.canonical;
    await attempt.completion;

    expect(attempt.phase()).toBe('committed');
    expect(attempt.diagnostics().timingsMs).toMatchObject({
      storageQueue: expect.any(Number),
      fileLock: expect.any(Number),
      readCas: expect.any(Number),
      lineage: expect.any(Number),
      tempWrite: expect.any(Number),
      fsync: expect.any(Number),
      rename: expect.any(Number),
      postCommit: expect.any(Number),
      total: expect.any(Number),
    });
    expect(attempt.diagnostics().timingsMs.fileLock).toBeGreaterThan(5_000);
    expect((await storage.peek(sessionId))?.actorSnapshot).toMatchObject({ revision: 2 });
  });

  it('keeps the outer review fence live while a branch mutation waits on a long session writer', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const configHome = path.join(tempHome, '.kodax');
    const storage = new FileSessionStorage({ sessionsDir, configHome });
    const sessionId = 'session-long-writer-branch-fence';
    const identity = {
      configHome,
      tenantId: 'tenant-long-writer-branch-fence',
      agentId: 'agent-long-writer-branch-fence',
      projectId: 'project-long-writer-branch-fence',
      sessionId,
    };
    const messages = [
      { role: 'user' as const, content: 'root turn' },
      { role: 'assistant' as const, content: 'branch turn' },
    ];
    const lineage = createSessionLineage(messages);
    const targetId = lineage.entries[0]?.id;
    if (targetId === undefined) throw new Error('expected branch target');
    await storage.save(sessionId, {
      messages,
      title: 'long writer branch fence',
      gitRoot: KODAX_REPO_ROOT,
      lineage,
    });
    await persistPendingEpisodeReview(identity, {
      id: 'digest-long-writer-branch-fence',
      reviewKey: 'review-long-writer-branch-fence',
      sessionId,
      branchId: sessionId,
      sequence: 1,
      objective: 'preserve branch authority',
      approach: 'wait through session contention',
      outcome: 'succeeded',
      summary: 'review is pending',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-07-27T00:00:00.000Z',
    });

    const sessionLockKey = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    const sessionLockPath = path.join(
      sessionsDir,
      '.write-locks',
      `${sessionLockKey}.lock`,
    );
    let markSessionLockHeld!: () => void;
    const sessionLockHeld = new Promise<void>((resolve) => {
      markSessionLockHeld = resolve;
    });
    const holder = withKodaXFileLock(sessionLockPath, async () => {
      markSessionLockHeld();
      await new Promise<void>((resolve) => setTimeout(resolve, 6_500));
    });
    await sessionLockHeld;

    const branchChange = storage.setActiveEntry(sessionId, targetId);
    const branchLockPath = path.join(
      configHome,
      'memory-review-inbox',
      hashMemoryIdentityComponent('tenant', identity.tenantId),
      hashMemoryIdentityComponent('session', sessionId),
      '.branch-authority.lock',
    );
    const branchLockDeadline = Date.now() + 2_000;
    while (!existsSync(branchLockPath) && Date.now() < branchLockDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(branchLockPath)).toBe(true);

    const completionFence = withPendingEpisodeReviewSessionFence(
      { configHome, sessionId },
      async () => 'completed',
    );
    const results = await Promise.allSettled([branchChange, completionFence]);
    await holder;

    expect(results).toEqual([
      expect.objectContaining({ status: 'fulfilled' }),
      { status: 'fulfilled', value: 'completed' },
    ]);
  });

  it('serializes review completion before a concurrent branch change without timing out or attaching the receipt to the new branch', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const configHome = path.join(tempHome, '.kodax');
    const storage = new FileSessionStorage({
      sessionsDir: testSessionsDir(),
      configHome,
    });
    const sessionId = 'session-review-completion-race';
    const identity = {
      configHome,
      tenantId: 'tenant-review-completion-race',
      agentId: 'agent-review-completion-race',
      projectId: 'project-review-completion-race',
      sessionId,
    };
    const digest: KodaXMemoryOutcomeDigest = {
      id: 'digest-review-completion-race',
      reviewKey: 'review-completion-race',
      sessionId,
      branchId: sessionId,
      sequence: 1,
      objective: 'complete a delayed review',
      approach: 'persist its owner-session receipt',
      outcome: 'succeeded',
      summary: 'review completed',
      evidenceRefs: [],
      visibility: 'prompt_safe',
      createdAt: '2026-07-27T00:00:00.000Z',
    };
    const pending = await persistPendingEpisodeReview(identity, digest);
    const messages = [
      { role: 'user' as const, content: 'root' },
      { role: 'assistant' as const, content: 'old branch' },
    ];
    const initialLineage = createSessionLineage(messages);
    const targetEntryId = initialLineage.entries[0]?.id;
    if (targetEntryId === undefined) throw new Error('expected branch target');
    await storage.save(sessionId, {
      messages,
      title: 'completion race',
      gitRoot: KODAX_REPO_ROOT,
      lineage: appendMemoryOutcomeDigest(initialLineage, digest, pending.entry.jobId),
    });

    let markCompletionStarted!: () => void;
    const completionStarted = new Promise<void>((resolve) => {
      markCompletionStarted = resolve;
    });
    let releaseCompletion!: () => void;
    const completionRelease = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const drain = drainPendingEpisodeReviews(identity, {
      revalidate: async () => 'eligible',
      review: async () => [],
      onV2Completed: async (entry, _decision, proposalIds) => {
        markCompletionStarted();
        await completionRelease;
        const owner = await storage.load(sessionId);
        if (owner?.lineage === undefined) throw new Error('expected owner lineage');
        await storage.save(sessionId, {
          ...owner,
          lineage: appendMemoryReviewReceipt(owner.lineage, {
            jobId: entry.jobId,
            reviewKey: entry.reviewKey,
            proposalIds,
            completedAt: '2026-07-27T00:01:00.000Z',
          }),
        });
      },
    });
    await completionStarted;
    const branchChange = storage.setActiveEntry(sessionId, targetEntryId);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    releaseCompletion();

    await expect(Promise.all([drain, branchChange])).resolves.toMatchObject([
      { reviewed: 1, failed: 0 },
      { lineage: { activeEntryId: targetEntryId } },
    ]);
    const loaded = await storage.load(sessionId);
    const receipt = loaded?.lineage?.entries.find((entry) =>
      entry.type === 'memory_review_receipt' && entry.jobId === pending.entry.jobId);
    const activePathIds = new Set(
      loaded?.lineage === undefined
        ? []
        : getSessionLineagePath(loaded.lineage).map((entry) => entry.id),
    );
    expect(receipt).toBeDefined();
    expect(receipt?.parentId === null || activePathIds.has(receipt?.parentId ?? '')).toBe(false);
  }, 10_000);

  it('archives exact pre-compaction messages before accepting an evicted snapshot', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const originalMessages = [
      { role: 'user' as const, content: '旧需求精确值是 ALPHA-9274，不得猜测。' },
      { role: 'assistant' as const, content: '已记录 ALPHA-9274，并完成第一阶段。' },
    ];
    const initialLineage = createSessionLineage(originalMessages);

    await storage.save('durable-before-evict', {
      messages: originalMessages,
      title: 'Durable compaction',
      gitRoot,
      lineage: initialLineage,
    });

    const compacted = applySessionCompaction(
      initialLineage,
      [
        { role: 'system', content: '[对话历史摘要]\n\n已完成第一阶段。' },
        { role: 'user', content: '继续第二阶段' },
      ],
      { summary: '已完成第一阶段。', reason: 'automatic_compaction' },
    );
    const evicted = evictOldIslandMessageContent(compacted);
    await storage.save('durable-before-evict', {
      messages: [{ role: 'user', content: '继续第二阶段' }],
      title: 'Durable compaction',
      gitRoot,
      lineage: evicted,
    });

    const restarted = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const fullLineage = await restarted.loadFullLineage('durable-before-evict');
    const exactBodies = fullLineage?.entries
      .filter((entry) => entry.type === 'message')
      .map((entry) => entry.message.content);
    expect(exactBodies).toContain('旧需求精确值是 ALPHA-9274，不得猜测。');
    expect(exactBodies).toContain('已记录 ALPHA-9274，并完成第一阶段。');
  });

  it('keeps the direct predecessor of a retained clone exact after two compaction saves', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const sessionId = 'two-compactions-direct-predecessor';
    const originalMessages = [
      { role: 'user' as const, content: '旧需求精确值是 BETA-5501，不得猜测。' },
      { role: 'assistant' as const, content: '已记录 BETA-5501，并完成第一阶段。' },
    ];
    const initialLineage = createSessionLineage(originalMessages);

    await storage.save(sessionId, {
      messages: originalMessages,
      title: 'Two compactions',
      gitRoot,
      lineage: initialLineage,
    });

    const firstCompaction = applySessionCompaction(
      initialLineage,
      [
        { role: 'system', content: '[对话历史摘要]\n\n第一阶段摘要。' },
        originalMessages[1]!,
      ],
      { summary: '第一阶段摘要。', reason: 'automatic_compaction' },
    );
    // Durable commit first, then the host releases old-island bodies from
    // memory — the eviction transaction boundary.
    await storage.save(sessionId, {
      messages: getSessionMessagesFromLineage(firstCompaction),
      title: 'Two compactions',
      gitRoot,
      lineage: firstCompaction,
    });
    await storage.save(sessionId, {
      messages: getSessionMessagesFromLineage(firstCompaction),
      title: 'Two compactions',
      gitRoot,
      lineage: evictOldIslandMessageContent(firstCompaction),
    });

    const restarted = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const reloaded = await restarted.load(sessionId);
    if (!reloaded?.lineage) throw new Error('expected a reloaded lineage');
    const firstClone = getSessionLineagePath(reloaded.lineage)
      .filter((entry): entry is KodaXSessionMessageEntry => entry.type === 'message')
      .at(-1);
    if (!firstClone) throw new Error('expected the first-compaction retained clone');

    const secondCompaction = applySessionCompaction(
      reloaded.lineage,
      [
        { role: 'system', content: '[对话历史摘要]\n\n第二阶段摘要。' },
        firstClone.message,
      ],
      { summary: '第二阶段摘要。', reason: 'automatic_compaction' },
    );
    await restarted.save(sessionId, {
      messages: getSessionMessagesFromLineage(secondCompaction),
      title: 'Two compactions',
      gitRoot,
      lineage: evictOldIslandMessageContent(secondCompaction),
    });

    const finalReload = await new FileSessionStorage({ sessionsDir: testSessionsDir() })
      .load(sessionId);
    if (!finalReload?.lineage) throw new Error('expected a final lineage');
    const secondClone = getSessionLineagePath(finalReload.lineage)
      .filter((entry): entry is KodaXSessionMessageEntry => entry.type === 'message')
      .at(-1);
    if (!secondClone) throw new Error('expected the second-compaction retained clone');

    // The second compaction clone names the first clone's physical id as its
    // direct predecessor…
    expect(secondClone.sourceEntryId).toBe(firstClone.id);
    // …and that predecessor must survive in the slimmed main lineage with its
    // exact body instead of being archived or placeholder-evicted.
    const predecessor = finalReload.lineage.entries.find(
      (entry) => entry.id === secondClone.sourceEntryId,
    );
    expect(predecessor).toBeDefined();
    expect(
      predecessor?.type === 'message' && predecessor.message.content,
    ).toBe('已记录 BETA-5501，并完成第一阶段。');
  });

  it('round-trips full lineage by merging the main file and island sidecar', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const originalMessages = [
      { role: 'user' as const, content: 'sidecar evidence USER-441' },
      { role: 'assistant' as const, content: 'sidecar evidence ASSISTANT-442' },
    ];
    const lineage = applySessionCompaction(
      createSessionLineage(originalMessages),
      [{ role: 'user', content: 'active tail' }],
      { summary: 'old work', reason: 'manual_compaction' },
    );

    await storage.save('full-lineage-merge', {
      messages: [{ role: 'user', content: 'active tail' }],
      title: 'Full lineage merge',
      gitRoot,
      lineage,
    });

    const fullLineage = await storage.loadFullLineage('full-lineage-merge');
    expect(fullLineage?.entries.filter((entry) => entry.type === 'message')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.objectContaining({ content: 'sidecar evidence USER-441' }) }),
        expect.objectContaining({ message: expect.objectContaining({ content: 'sidecar evidence ASSISTANT-442' }) }),
      ]),
    );
  });

  it('merges historical island batches with stable topology instead of timestamps', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { setKodaXDiagnosticSink } = await import('@kodax-ai/agent');
    const sessionsDir = testSessionsDir();
    const projectDir = path.join(sessionsDir, 'topology-project');
    const sessionId = 'topology-aware-full-lineage';
    const timestamp = '2026-07-30T00:00:00.000Z';
    await mkdir(projectDir, { recursive: true });

    const messageEntry = (
      id: string,
      parentId: string | null,
      content: string,
    ) => ({
      id,
      parentId,
      timestamp,
      type: 'message' as const,
      message: { role: 'user' as const, content },
    });
    const retainedParent = messageEntry('entry_parent', null, 'retained parent');
    const overlapPlaceholder = messageEntry('entry_overlap', 'entry_legacy_child', '[compacted]');
    const retainedNext = messageEntry('entry_retained_next', 'entry_parent', 'retained next');
    const current = messageEntry('entry_current', null, 'current');

    await writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          _type: 'meta',
          id: sessionId,
          title: 'Topology-aware recovery',
          gitRoot: '/tmp/topology-project',
          createdAt: timestamp,
          scope: 'user',
          lineageVersion: 2,
          activeEntryId: current.id,
          activeMessageCount: 1,
          lineageEntryCount: 4,
        }),
        ...[retainedParent, overlapPlaceholder, retainedNext, current].map((entry) =>
          JSON.stringify({ _type: 'lineage_entry', entry })),
      ].join('\n') + '\n',
      'utf8',
    );

    const legacyChild = messageEntry('entry_legacy_child', retainedParent.id, 'legacy child');
    const batchIndependent = messageEntry('entry_batch_independent', null, 'batch independent');
    const exactOverlap = messageEntry('entry_overlap', legacyChild.id, 'exact overlap');
    const secondBatchChild = messageEntry('entry_second_batch', exactOverlap.id, 'second batch');
    const anchoredMiddle = messageEntry('entry_anchored_middle', null, 'anchored middle');
    const legacyOnly = messageEntry('entry_legacy_only', current.id, 'legacy only');
    await writeFile(
      path.join(projectDir, `${sessionId}.islands.jsonl`),
      [
        JSON.stringify({ _type: 'archive_batch', archiveBatchId: 'batch_one' }),
        JSON.stringify({
          _type: 'archived_entry',
          archiveBatchId: 'batch_one',
          entry: legacyChild,
        }),
        JSON.stringify({
          _type: 'archived_entry',
          archiveBatchId: 'batch_one',
          entry: batchIndependent,
        }),
        JSON.stringify({
          _type: 'archived_entry',
          archiveBatchId: 'batch_one',
          entry: exactOverlap,
        }),
        JSON.stringify({ _type: 'archive_batch', archiveBatchId: 'batch_two' }),
        JSON.stringify({
          _type: 'archived_entry',
          archiveBatchId: 'batch_two',
          entry: secondBatchChild,
        }),
        JSON.stringify({ _type: 'archive_batch', archiveBatchId: 'batch_three' }),
        JSON.stringify({
          _type: 'archived_entry',
          archiveBatchId: 'batch_three',
          previousEntryId: retainedNext.id,
          nextEntryId: current.id,
          entry: anchoredMiddle,
        }),
        '{"_type":"archived_entry","archiveBatchId":"crash_tail","entry":',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(projectDir, `${sessionId}.archive.jsonl`),
      [
        JSON.stringify({
          _type: 'archived_entry',
          archiveBatchId: 'legacy_overlap',
          entry: exactOverlap,
        }),
        JSON.stringify({
          _type: 'archived_entry',
          archiveBatchId: 'legacy_only',
          previousEntryId: 42,
          entry: legacyOnly,
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const storage = new FileSessionStorage({ sessionsDir });
    const diagnostics: string[] = [];
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => {
      if (diagnostic.source === 'repl:session-storage') {
        diagnostics.push(diagnostic.message);
      }
    });
    let full: Awaited<ReturnType<typeof storage.loadFullLineage>>;
    try {
      full = await storage.loadFullLineage(sessionId);
    } finally {
      restoreDiagnostics();
    }
    const messages = full?.entries
      .filter((entry) => entry.type === 'message')
      .map((entry) => ({ id: entry.id, content: entry.message.content }));

    expect(messages).toEqual([
      { id: retainedParent.id, content: 'retained parent' },
      { id: legacyChild.id, content: 'legacy child' },
      { id: batchIndependent.id, content: 'batch independent' },
      { id: exactOverlap.id, content: 'exact overlap' },
      { id: secondBatchChild.id, content: 'second batch' },
      { id: retainedNext.id, content: 'retained next' },
      { id: anchoredMiddle.id, content: 'anchored middle' },
      { id: current.id, content: 'current' },
      { id: legacyOnly.id, content: 'legacy only' },
    ]);
    expect(new Set(messages?.map((entry) => entry.id)).size).toBe(messages?.length);
    expect(diagnostics).toContain(
      `Ignored incomplete island sidecar tail ${sessionId}.islands.jsonl:9.`,
    );

    const expectedIds = messages?.map((entry) => entry.id);
    expect(await storage.archive(sessionId)).toBe(true);
    expect((await storage.loadFullLineage(sessionId))?.entries.map((entry) => entry.id))
      .toEqual(expectedIds);
    expect(await storage.unarchive(sessionId)).toBe(true);
    expect((await storage.loadFullLineage(sessionId))?.entries.map((entry) => entry.id))
      .toEqual(expectedIds);
  });

  it('keeps exact-main authority after rewind moves a conflicting overlap to the sidecar', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const projectDir = path.join(sessionsDir, 'overlap-authority-project');
    const sessionId = 'overlap-authority';
    const timestamp = '2026-07-30T00:00:00.000Z';
    const rootEntry = {
      id: 'entry_overlap_root',
      parentId: null,
      timestamp,
      type: 'message' as const,
      message: { role: 'user' as const, content: 'rewind target' },
    };
    const mainEntry = {
      id: 'entry_overlap_authority',
      parentId: null,
      timestamp,
      type: 'message' as const,
      message: { role: 'user' as const, content: 'authoritative main body' },
    };
    const tailEntry = {
      id: 'entry_overlap_tail',
      parentId: mainEntry.id,
      timestamp,
      type: 'message' as const,
      message: { role: 'assistant' as const, content: 'authoritative tail' },
    };
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          _type: 'meta',
          id: sessionId,
          title: 'Overlap authority',
          gitRoot: '/tmp/overlap-authority-project',
          createdAt: timestamp,
          scope: 'user',
          lineageVersion: 2,
          activeEntryId: tailEntry.id,
          activeMessageCount: 2,
          lineageEntryCount: 3,
        }),
        JSON.stringify({ _type: 'lineage_entry', entry: rootEntry }),
        JSON.stringify({ _type: 'lineage_entry', entry: mainEntry }),
        JSON.stringify({ _type: 'lineage_entry', entry: tailEntry }),
      ].join('\n') + '\n',
      'utf8',
    );
    await writeFile(
      path.join(projectDir, `${sessionId}.islands.jsonl`),
      JSON.stringify({
        _type: 'archived_entry',
        archiveBatchId: 'overlap',
        previousEntryId: tailEntry.id,
        nextEntryId: rootEntry.id,
        entry: {
          ...mainEntry,
          message: { role: 'user', content: 'stale sidecar body' },
        },
      }) + '\n',
      'utf8',
    );

    const storage = new FileSessionStorage({ sessionsDir });
    expect((await storage.loadFullLineage(sessionId))?.entries).toEqual([
      rootEntry,
      mainEntry,
      tailEntry,
    ]);

    expect(await storage.rewind(sessionId, rootEntry.id)).not.toBeNull();
    const full = await storage.loadFullLineage(sessionId);
    expect(full?.entries.map((entry) => entry.id)).toEqual([
      rootEntry.id,
      mainEntry.id,
      tailEntry.id,
      expect.stringMatching(/^entry_/),
    ]);
    expect(full?.entries.find((entry) => entry.id === mainEntry.id)).toEqual(mainEntry);
  });

  it('limits corrupt parent-cycle fallback to the cycle and preserves downstream topology', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const projectDir = path.join(sessionsDir, 'cycle-fallback-project');
    const sessionId = 'cycle-fallback';
    const timestamp = '2026-07-30T00:00:00.000Z';
    const entry = (id: string, parentId: string | null) => ({
      id,
      parentId,
      timestamp,
      type: 'message' as const,
      message: { role: 'user' as const, content: id },
    });
    const current = entry('entry_cycle_current', 'entry_cycle_y');
    const cycleA = entry('entry_cycle_a', 'entry_cycle_b');
    const cycleB = entry('entry_cycle_b', 'entry_cycle_a');
    const downstream = entry('entry_cycle_y', 'entry_cycle_b');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          _type: 'meta',
          id: sessionId,
          title: 'Cycle fallback',
          gitRoot: '/tmp/cycle-fallback-project',
          createdAt: timestamp,
          scope: 'user',
          lineageVersion: 2,
          activeEntryId: current.id,
          activeMessageCount: 1,
          lineageEntryCount: 1,
        }),
        JSON.stringify({ _type: 'lineage_entry', entry: current }),
      ].join('\n') + '\n',
      'utf8',
    );
    await writeFile(
      path.join(projectDir, `${sessionId}.islands.jsonl`),
      [current, cycleA, cycleB, downstream].map((archived) => JSON.stringify({
        _type: 'archived_entry',
        archiveBatchId: 'corrupt_cycle',
        entry: archived,
      })).join('\n') + '\n',
      'utf8',
    );

    const full = await new FileSessionStorage({ sessionsDir }).loadFullLineage(sessionId);
    const ids = full?.entries.map((candidate) => candidate.id) ?? [];
    expect(new Set(ids)).toEqual(new Set([current.id, cycleA.id, cycleB.id, downstream.id]));
    expect(ids.indexOf(cycleB.id)).toBeLessThan(ids.indexOf(downstream.id));
    expect(ids.indexOf(downstream.id)).toBeLessThan(ids.indexOf(current.id));
  });

  it('reads the main transcript and sidecars under the Session write lock', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'locked-full-lineage-read';
    const storage = new FileSessionStorage({ sessionsDir });
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'consistent snapshot' }],
      title: 'Locked full lineage read',
      gitRoot: path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/'),
      lineage: createSessionLineage([{ role: 'user', content: 'consistent snapshot' }]),
    });
    const lockKey = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    const lockPath = path.join(sessionsDir, '.write-locks', `${lockKey}.lock`);
    const reads: Array<ReturnType<typeof storage.loadFullLineage>> = [];
    let settled = false;

    await withKodaXFileLock(lockPath, async () => {
      reads.push(storage.loadFullLineage(sessionId).finally(() => {
        settled = true;
      }));
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
    });

    const read = reads[0];
    if (!read) throw new Error('Expected a pending full-lineage read.');
    expect(await read).not.toBeNull();
  });

  it('fails strict reads without creating lock artifacts while a writer is active', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'strict-active-writer';
    const storage = new FileSessionStorage({ sessionsDir });
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'consistent snapshot' }],
      title: 'Strict active writer',
      gitRoot: path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/'),
      lineage: createSessionLineage([{ role: 'user', content: 'consistent snapshot' }]),
    });
    const lockKey = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    const lockPath = path.join(sessionsDir, '.write-locks', `${lockKey}.lock`);

    await withKodaXFileLock(lockPath, async () => {
      await expect(storage.readFullSnapshot(sessionId)).rejects.toMatchObject({
        code: 'data_changed',
      });
    });

    const lockQueue = `${lockPath}.queue`;
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(lockQueue)).toBe(true);
    expect(await fsPromises.readdir(lockQueue)).toEqual([]);
  });

  it('reads each strict Session bundle payload at most once', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'strict-single-payload-read';
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const storage = new FileSessionStorage({ sessionsDir });
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'read once' }],
      title: 'Strict single payload read',
      gitRoot,
      lineage: createSessionLineage([{ role: 'user', content: 'read once' }]),
    });
    const projectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(gitRoot).key);
    const payloadPaths = [
      path.join(projectDir, `${sessionId}.jsonl`),
      path.join(projectDir, `${sessionId}.islands.jsonl`),
      path.join(projectDir, `${sessionId}.archive.jsonl`),
    ];
    await writeFile(payloadPaths[1]!, '', 'utf8');
    await writeFile(payloadPaths[2]!, '', 'utf8');

    const readFileSpy = vi.spyOn(fsPromises, 'readFile');
    const openSpy = vi.spyOn(fsPromises, 'open');
    const snapshot = await storage.readFullSnapshot(sessionId);
    expect(snapshot).not.toBeNull();
    for (const payloadPath of payloadPaths) {
      const readFileCalls = readFileSpy.mock.calls.filter(
        ([candidate]) => path.resolve(String(candidate)) === path.resolve(payloadPath),
      ).length;
      const openCalls = openSpy.mock.calls.filter(
        ([candidate]) => path.resolve(String(candidate)) === path.resolve(payloadPath),
      ).length;
      expect(readFileCalls + openCalls).toBe(1);
    }
  });

  it('fails a discovery-based strict capture when a duplicate appears mid-read', async () => {
    const { readStableSessionBundleFiles } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'strict-location-topology-change';
    const firstDir = path.join(sessionsDir, 'topology-a');
    const secondDir = path.join(sessionsDir, 'topology-b');
    const firstPath = path.join(firstDir, `${sessionId}.jsonl`);
    const secondPath = path.join(secondDir, `${sessionId}.jsonl`);
    const payload = `${JSON.stringify({
      _type: 'meta',
      id: sessionId,
      title: 'Topology change',
      createdAt: '2026-07-31T00:00:00.000Z',
      scope: 'user',
    })}\n`;
    await mkdir(firstDir, { recursive: true });
    await writeFile(firstPath, payload, 'utf8');
    const originalOpen = fsPromises.open.bind(fsPromises);
    let releaseOpen: (() => void) | undefined;
    let markOpenStarted: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const openStarted = new Promise<void>((resolve) => {
      markOpenStarted = resolve;
    });
    const open = vi.spyOn(fsPromises, 'open').mockImplementation(
      async (file, flags, mode) => {
        if (path.resolve(String(file)) === path.resolve(firstPath)) {
          markOpenStarted?.();
          await openGate;
        }
        return originalOpen(file, flags, mode);
      },
    );
    try {
      const capture = readStableSessionBundleFiles(sessionsDir, sessionId);
      await openStarted;
      await mkdir(secondDir, { recursive: true });
      await writeFile(secondPath, payload, 'utf8');
      releaseOpen?.();
      await expect(capture).rejects.toMatchObject({ code: 'data_changed' });
    } finally {
      releaseOpen?.();
      open.mockRestore();
    }
  });

  it('does not grant strict locator authority when the sessions-root traversal fails', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'strict-incomplete-root-traversal';
    const flatPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(flatPath, `${JSON.stringify({
      _type: 'meta',
      id: sessionId,
      title: 'Incomplete root traversal',
      createdAt: '2026-07-31T00:00:00.000Z',
      scope: 'user',
      lineageVersion: 2,
      activeEntryId: null,
      activeMessageCount: 0,
    })}\n`, 'utf8');

    const originalReaddir = fsPromises.readdir.bind(fsPromises);
    const readdir = vi.spyOn(fsPromises, 'readdir').mockImplementation(
      async (directory, options) => {
        if (path.resolve(String(directory)) === path.resolve(sessionsDir)) {
          throw Object.assign(new Error('sessions root unreadable'), { code: 'EACCES' });
        }
        return originalReaddir(directory, options as never);
      },
    );
    try {
      await expect(new FileSessionStorage({ sessionsDir }).readFullSnapshot(sessionId))
        .rejects.toMatchObject({ code: 'data_changed' });
    } finally {
      readdir.mockRestore();
    }
  });

  it.each(['main', 'archived'] as const)(
    'fails strict candidate discovery closed when a project %s path is inaccessible',
    async (candidateKind) => {
      const { FileSessionStorage, readStableSessionBundleFiles } = await import('./storage.js');
      const sessionsDir = testSessionsDir();
      const sessionId = `strict-inaccessible-project-${candidateKind}`;
      const firstDir = path.join(sessionsDir, 'accessible-project');
      const secondDir = path.join(sessionsDir, 'inaccessible-project');
      const inaccessiblePath = candidateKind === 'main'
        ? path.join(secondDir, `${sessionId}.jsonl`)
        : path.join(secondDir, 'archived', `${sessionId}.jsonl`);
      const payload = `${JSON.stringify({
        _type: 'meta',
        id: sessionId,
        title: 'Inaccessible project candidate',
        createdAt: '2026-07-31T00:00:00.000Z',
        scope: 'user',
        lineageVersion: 2,
        activeEntryId: null,
        activeMessageCount: 0,
      })}\n`;
      await mkdir(firstDir, { recursive: true });
      await mkdir(path.dirname(inaccessiblePath), { recursive: true });
      await writeFile(path.join(firstDir, `${sessionId}.jsonl`), payload, 'utf8');
      const originalStat = fsSync.statSync.bind(fsSync);
      const stat = vi.spyOn(fsSync, 'statSync').mockImplementation(
        (candidate, options) => {
          if (path.resolve(String(candidate)) === path.resolve(inaccessiblePath)) {
            throw Object.assign(new Error('candidate inaccessible'), { code: 'EACCES' });
          }
          return originalStat(candidate, options as never);
        },
      );
      const originalAsyncStat = fsPromises.stat.bind(fsPromises);
      const asyncStat = vi.spyOn(fsPromises, 'stat').mockImplementation(
        async (candidate, options) => {
          if (path.resolve(String(candidate)) === path.resolve(inaccessiblePath)) {
            throw Object.assign(new Error('candidate inaccessible'), { code: 'EACCES' });
          }
          return originalAsyncStat(candidate, options as never);
        },
      );
      try {
        await expect(new FileSessionStorage({ sessionsDir }).readFullSnapshot(sessionId))
          .rejects.toMatchObject({ code: 'data_changed' });
        await expect(readStableSessionBundleFiles(sessionsDir, sessionId))
          .rejects.toMatchObject({ code: 'data_changed' });
      } finally {
        asyncStat.mockRestore();
        stat.mockRestore();
      }
    },
  );

  it('invalidates a verified strict locator when another process adds a project candidate', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'strict-cross-process-topology-change';
    const firstDir = path.join(sessionsDir, 'cross-process-a');
    const secondDir = path.join(sessionsDir, 'cross-process-b');
    const payload = `${JSON.stringify({
      _type: 'meta',
      id: sessionId,
      title: 'Cross-process topology change',
      createdAt: '2026-07-31T00:00:00.000Z',
      scope: 'user',
      lineageVersion: 2,
      activeEntryId: null,
      activeMessageCount: 0,
    })}\n`;
    await mkdir(firstDir, { recursive: true });
    await writeFile(path.join(firstDir, `${sessionId}.jsonl`), payload, 'utf8');

    const storage = new FileSessionStorage({ sessionsDir });
    await expect(storage.readFullSnapshot(sessionId)).resolves.not.toBeNull();

    // A raw filesystem write models a second process whose topology mutation
    // is invisible to this process-local positive locator cache.
    await mkdir(secondDir, { recursive: true });
    await writeFile(path.join(secondDir, `${sessionId}.jsonl`), payload, 'utf8');
    await expect(storage.readFullSnapshot(sessionId)).rejects.toMatchObject({
      code: 'data_changed',
    });
  });

  it('invalidates a verified strict locator for a cross-process candidate in an existing project', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'strict-existing-project-topology-change';
    const firstDir = path.join(sessionsDir, 'existing-project-a');
    const secondDir = path.join(sessionsDir, 'existing-project-b');
    const topologyEpochPath = path.join(sessionsDir, '.location-topology');
    const payload = `${JSON.stringify({
      _type: 'meta',
      id: sessionId,
      title: 'Existing project topology change',
      createdAt: '2026-07-31T00:00:00.000Z',
      scope: 'user',
      lineageVersion: 2,
      activeEntryId: null,
      activeMessageCount: 0,
    })}\n`;
    await mkdir(firstDir, { recursive: true });
    await mkdir(secondDir, { recursive: true });
    await writeFile(topologyEpochPath, 'epoch-before\n', 'utf8');
    await writeFile(path.join(firstDir, `${sessionId}.jsonl`), payload, 'utf8');

    const storage = new FileSessionStorage({ sessionsDir });
    await expect(storage.readFullSnapshot(sessionId)).resolves.not.toBeNull();

    // Simulate the durable topology epoch advanced by another SDK process
    // before it exposes a same-ID main file in an already-known project.
    await writeFile(topologyEpochPath, 'epoch-after\n', 'utf8');
    await writeFile(path.join(secondDir, `${sessionId}.jsonl`), payload, 'utf8');
    await expect(storage.readFullSnapshot(sessionId)).rejects.toMatchObject({
      code: 'data_changed',
    });
  });

  it('invalidates a verified locator after a legacy writer uses the Session lock', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'strict-legacy-writer-topology-change';
    const firstDir = path.join(sessionsDir, 'legacy-writer-a');
    const secondDir = path.join(sessionsDir, 'legacy-writer-b');
    const lockKey = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    const lockPath = path.join(sessionsDir, '.write-locks', `${lockKey}.lock`);
    const payload = `${JSON.stringify({
      _type: 'meta',
      id: sessionId,
      title: 'Legacy writer topology change',
      createdAt: '2026-07-31T00:00:00.000Z',
      scope: 'user',
      lineageVersion: 2,
      activeEntryId: null,
      activeMessageCount: 0,
    })}\n`;
    await mkdir(firstDir, { recursive: true });
    await mkdir(secondDir, { recursive: true });
    // Pre-create both the old global lock directory and this Session's queue
    // so the legacy write does not alter the sessions-root identity.
    await mkdir(`${lockPath}.queue`, { recursive: true });
    await writeFile(path.join(firstDir, `${sessionId}.jsonl`), payload, 'utf8');

    const storage = new FileSessionStorage({ sessionsDir });
    await expect(storage.readFullSnapshot(sessionId)).resolves.not.toBeNull();

    await withKodaXFileLock(lockPath, async () => {
      await writeFile(path.join(secondDir, `${sessionId}.jsonl`), payload, 'utf8');
    });
    await expect(storage.readFullSnapshot(sessionId)).rejects.toMatchObject({
      code: 'data_changed',
    });
  });

  it('does not rebind a stale durable locator after a legacy writer adds a duplicate', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'durable-locator-legacy-writer-race';
    const firstDir = path.join(sessionsDir, 'durable-race-a');
    const secondDir = path.join(sessionsDir, 'durable-race-b');
    const lockKey = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    const lockPath = path.join(sessionsDir, '.write-locks', `${lockKey}.lock`);
    const payload = `${JSON.stringify({
      _type: 'meta',
      id: sessionId,
      title: 'Durable locator legacy writer race',
      createdAt: '2026-07-31T00:00:00.000Z',
      scope: 'user',
      lineageVersion: 2,
      activeEntryId: null,
      activeMessageCount: 0,
    })}\n`;
    await mkdir(firstDir, { recursive: true });
    await mkdir(secondDir, { recursive: true });
    await mkdir(`${lockPath}.queue`, { recursive: true });
    await writeFile(path.join(firstDir, `${sessionId}.jsonl`), payload, 'utf8');

    const storage = new FileSessionStorage({ sessionsDir });
    await expect(storage.readFullSnapshot(sessionId)).resolves.not.toBeNull();
    const internal = storage as unknown as {
      persistSessionLocationHint(id: string): Promise<void>;
    };
    await internal.persistSessionLocationHint(sessionId);

    await withKodaXFileLock(lockPath, async () => {
      await writeFile(path.join(secondDir, `${sessionId}.jsonl`), payload, 'utf8');
    });
    await internal.persistSessionLocationHint(sessionId);

    await expect(new FileSessionStorage({ sessionsDir }).readFullSnapshot(sessionId))
      .rejects.toMatchObject({ code: 'data_changed' });
  });

  it('fails a cached strict capture when the verified root topology changes mid-read', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'strict-cached-topology-change';
    const firstDir = path.join(sessionsDir, 'cached-topology-a');
    const secondDir = path.join(sessionsDir, 'cached-topology-b');
    const firstPath = path.join(firstDir, `${sessionId}.jsonl`);
    const payload = `${JSON.stringify({
      _type: 'meta',
      id: sessionId,
      title: 'Cached topology change',
      createdAt: '2026-07-31T00:00:00.000Z',
      scope: 'user',
      lineageVersion: 2,
      activeEntryId: null,
      activeMessageCount: 0,
    })}\n`;
    await mkdir(firstDir, { recursive: true });
    await writeFile(firstPath, payload, 'utf8');
    const storage = new FileSessionStorage({ sessionsDir });
    await expect(storage.readFullSnapshot(sessionId)).resolves.not.toBeNull();

    const originalOpen = fsPromises.open.bind(fsPromises);
    let releaseOpen: (() => void) | undefined;
    let markOpenStarted: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const openStarted = new Promise<void>((resolve) => { markOpenStarted = resolve; });
    const open = vi.spyOn(fsPromises, 'open').mockImplementation(
      async (file, flags, mode) => {
        if (path.resolve(String(file)) === path.resolve(firstPath)) {
          markOpenStarted?.();
          await openGate;
        }
        return originalOpen(file, flags, mode);
      },
    );
    try {
      const capture = storage.readFullSnapshot(sessionId);
      await openStarted;
      await mkdir(secondDir, { recursive: true });
      await writeFile(path.join(secondDir, `${sessionId}.jsonl`), payload, 'utf8');
      releaseOpen?.();
      await expect(capture).rejects.toMatchObject({ code: 'data_changed' });
    } finally {
      releaseOpen?.();
      open.mockRestore();
    }
  });

  it('shares known Session locations and re-verifies them after lifecycle moves', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'process-location-index';
    const writer = new FileSessionStorage({ sessionsDir });
    await writer.save(sessionId, {
      messages: [{ role: 'user', content: 'indexed' }],
      title: 'Process location index',
      gitRoot: path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/'),
      lineage: createSessionLineage([{ role: 'user', content: 'indexed' }]),
    });
    const root = path.resolve(sessionsDir);
    const assertIndexedRead = async (
      expectedPresent: boolean,
      expectIndexed = true,
    ): Promise<void> => {
      const readdirSpy = vi.spyOn(fsPromises, 'readdir');
      const snapshot = await new FileSessionStorage({ sessionsDir })
        .readFullSnapshot(sessionId);
      expect(snapshot !== null).toBe(expectedPresent);
      const rootReads = readdirSpy.mock.calls.filter(
        ([candidate]) => path.resolve(String(candidate)) === root,
      );
      expect(rootReads.length === 0).toBe(expectIndexed);
      readdirSpy.mockRestore();
    };

    await assertIndexedRead(true);
    expect(await writer.archive(sessionId)).toBe(true);
    await assertIndexedRead(true, false);
    await assertIndexedRead(true);
    expect(await writer.unarchive(sessionId)).toBe(true);
    await assertIndexedRead(true, false);
    await assertIndexedRead(true);
    await writer.delete(sessionId);
    await assertIndexedRead(false, false);
  });

  it('uses a durable id locator without scanning every project directory', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'durable-location-index';
    await Promise.all(Array.from({ length: 300 }, (_, index) =>
      mkdir(path.join(sessionsDir, `unrelated-project-${index}`), { recursive: true })));
    const writer = new FileSessionStorage({ sessionsDir });
    await writer.save(sessionId, {
      messages: [{ role: 'user', content: 'indexed durably' }],
      title: 'Durable location index',
      gitRoot: path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/'),
      lineage: createSessionLineage([{ role: 'user', content: 'indexed durably' }]),
    });
    const internal = writer as unknown as {
      readonly sessionLocations: Map<string, unknown>;
    };
    internal.sessionLocations.clear();

    const readdir = vi.spyOn(fsPromises, 'readdir');
    try {
      await expect(new FileSessionStorage({ sessionsDir }).readFullSnapshot(sessionId))
        .resolves.not.toBeNull();
      expect(readdir.mock.calls.filter(
        ([candidate]) => path.resolve(String(candidate)) === path.resolve(sessionsDir),
      )).toHaveLength(0);
    } finally {
      readdir.mockRestore();
    }
  });

  it('indexes Session paths discovered by list for later id-only reads', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'list-location-index';
    const projectDir = path.join(sessionsDir, 'manually-discovered-project');
    const mainPath = path.join(projectDir, `${sessionId}.jsonl`);
    const timestamp = '2026-07-31T00:00:00.000Z';
    const entry = {
      id: 'entry_list_location_index',
      parentId: null,
      timestamp,
      type: 'message' as const,
      message: { role: 'user' as const, content: 'discovered by list' },
    };
    await mkdir(projectDir, { recursive: true });
    await writeFile(mainPath, [
      JSON.stringify({
        _type: 'meta',
        id: sessionId,
        title: 'List location index',
        createdAt: timestamp,
        scope: 'user',
        lineageVersion: 2,
        activeEntryId: entry.id,
        activeMessageCount: 1,
      }),
      JSON.stringify({ _type: 'lineage_entry', entry }),
    ].join('\n') + '\n', 'utf8');

    const storage = new FileSessionStorage({ sessionsDir });
    expect((await storage.list(undefined, { limit: 10 }))
      .some((session) => session.id === sessionId)).toBe(true);
    const readdirSpy = vi.spyOn(fsPromises, 'readdir');
    await expect(new FileSessionStorage({ sessionsDir }).readFullSnapshot(sessionId))
      .resolves.not.toBeNull();
    expect(readdirSpy.mock.calls.filter(
      ([candidate]) => path.resolve(String(candidate)) === path.resolve(sessionsDir),
    )).toHaveLength(0);
  });

  it('does not inspect the current Git workspace for an unscoped global list', async () => {
    const inspectWorkspaceRuntime = vi.fn(async () => ({
      executionCwd: process.cwd(),
      workspaceKind: 'rootless' as const,
    }));
    vi.doMock('./workspace-runtime.js', async () => {
      const actual = await vi.importActual<typeof import('./workspace-runtime.js')>(
        './workspace-runtime.js',
      );
      return { ...actual, inspectWorkspaceRuntime };
    });
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    await mkdir(path.join(sessionsDir, 'project-with-session'), { recursive: true });

    await new FileSessionStorage({ sessionsDir }).list(undefined, { limit: 10 });

    expect(inspectWorkspaceRuntime).not.toHaveBeenCalled();
  });

  it('invalidates a list-derived locator after a legacy Session writer completes', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'list-legacy-writer-topology-change';
    const firstDir = path.join(sessionsDir, 'list-legacy-writer-a');
    const secondDir = path.join(sessionsDir, 'list-legacy-writer-b');
    const lockKey = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    const lockPath = path.join(sessionsDir, '.write-locks', `${lockKey}.lock`);
    const payload = `${JSON.stringify({
      _type: 'meta',
      id: sessionId,
      title: 'List legacy writer topology change',
      createdAt: '2026-07-31T00:00:00.000Z',
      scope: 'user',
      lineageVersion: 2,
      activeEntryId: null,
      activeMessageCount: 0,
    })}\n`;
    await mkdir(firstDir, { recursive: true });
    await mkdir(secondDir, { recursive: true });
    await mkdir(`${lockPath}.queue`, { recursive: true });
    await writeFile(path.join(firstDir, `${sessionId}.jsonl`), payload, 'utf8');

    const storage = new FileSessionStorage({ sessionsDir });
    expect((await storage.list(undefined, { limit: 10 }))
      .some((session) => session.id === sessionId)).toBe(true);

    await withKodaXFileLock(lockPath, async () => {
      await writeFile(path.join(secondDir, `${sessionId}.jsonl`), payload, 'utf8');
    });
    await expect(new FileSessionStorage({ sessionsDir }).readFullSnapshot(sessionId))
      .rejects.toMatchObject({ code: 'data_changed' });
  });

  it('does not authorize a list locator when a legacy writer finishes mid-traversal', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'list-mid-traversal-legacy-writer';
    const firstDir = path.join(sessionsDir, 'list-mid-traversal-a');
    const secondDir = path.join(sessionsDir, 'list-mid-traversal-b');
    const gateDir = path.join(sessionsDir, 'list-mid-traversal-gate');
    const lockKey = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    const lockPath = path.join(sessionsDir, '.write-locks', `${lockKey}.lock`);
    const payload = `${JSON.stringify({
      _type: 'meta',
      id: sessionId,
      title: 'List mid-traversal legacy writer',
      createdAt: '2026-07-31T00:00:00.000Z',
      scope: 'user',
      lineageVersion: 2,
      activeEntryId: null,
      activeMessageCount: 0,
    })}\n`;
    await mkdir(firstDir, { recursive: true });
    await mkdir(secondDir, { recursive: true });
    await mkdir(gateDir, { recursive: true });
    await mkdir(`${lockPath}.queue`, { recursive: true });
    await writeFile(path.join(firstDir, `${sessionId}.jsonl`), payload, 'utf8');

    const originalReaddir = fsPromises.readdir.bind(fsPromises);
    let markSecondScanned: (() => void) | undefined;
    let markGateStarted: (() => void) | undefined;
    let releaseGate: (() => void) | undefined;
    const secondScanned = new Promise<void>((resolve) => { markSecondScanned = resolve; });
    const gateStarted = new Promise<void>((resolve) => { markGateStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const readdir = vi.spyOn(fsPromises, 'readdir').mockImplementation(
      async (directory, options) => {
        const resolved = path.resolve(String(directory));
        if (resolved === path.resolve(gateDir)) {
          markGateStarted?.();
          await gate;
        }
        const result = await originalReaddir(directory, options);
        if (resolved === path.resolve(secondDir)) markSecondScanned?.();
        return result;
      },
    );
    try {
      const storage = new FileSessionStorage({ sessionsDir });
      const listing = storage.list(undefined, { limit: 10 });
      await Promise.all([secondScanned, gateStarted]);
      await withKodaXFileLock(lockPath, async () => {
        await writeFile(path.join(secondDir, `${sessionId}.jsonl`), payload, 'utf8');
      });
      releaseGate?.();
      await listing;
    } finally {
      releaseGate?.();
      readdir.mockRestore();
    }

    await expect(new FileSessionStorage({ sessionsDir }).readFullSnapshot(sessionId))
      .rejects.toMatchObject({ code: 'data_changed' });
  });

  it('keeps a list-derived locator authoritative after an unrelated legacy write', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const firstId = 'list-unrelated-writer-first';
    const secondId = 'list-unrelated-writer-second';
    const projectDir = path.join(sessionsDir, 'list-unrelated-writer-project');
    const secondLockKey = createHash('sha256').update(secondId, 'utf8').digest('hex');
    const secondLockPath = path.join(
      sessionsDir,
      '.write-locks',
      `${secondLockKey}.lock`,
    );
    const payload = (id: string): string => `${JSON.stringify({
      _type: 'meta',
      id,
      title: id,
      createdAt: '2026-07-31T00:00:00.000Z',
      scope: 'user',
      lineageVersion: 2,
      activeEntryId: null,
      activeMessageCount: 0,
    })}\n`;
    await mkdir(projectDir, { recursive: true });
    await mkdir(`${secondLockPath}.queue`, { recursive: true });
    await writeFile(path.join(projectDir, `${firstId}.jsonl`), payload(firstId), 'utf8');
    await writeFile(path.join(projectDir, `${secondId}.jsonl`), payload(secondId), 'utf8');

    const storage = new FileSessionStorage({ sessionsDir });
    expect(await storage.list(undefined, { limit: 10 })).toHaveLength(2);
    await withKodaXFileLock(secondLockPath, async () => {
      await writeFile(
        path.join(projectDir, `${secondId}.jsonl`),
        payload(secondId),
        'utf8',
      );
    });

    const firstRead = vi.spyOn(fsPromises, 'readdir');
    try {
      await expect(new FileSessionStorage({ sessionsDir }).readFullSnapshot(firstId))
        .resolves.not.toBeNull();
      expect(firstRead.mock.calls.some(
        ([candidate]) => path.resolve(String(candidate)) === path.resolve(sessionsDir),
      )).toBe(false);
    } finally {
      firstRead.mockRestore();
    }
    const secondRead = vi.spyOn(fsPromises, 'readdir');
    try {
      await expect(new FileSessionStorage({ sessionsDir }).readFullSnapshot(secondId))
        .resolves.not.toBeNull();
      expect(secondRead.mock.calls.some(
        ([candidate]) => path.resolve(String(candidate)) === path.resolve(sessionsDir),
      )).toBe(true);
    } finally {
      secondRead.mockRestore();
    }
  });

  it('invalidates a list-derived locator after a legacy writer held the lock throughout listing', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'list-active-legacy-writer';
    const firstDir = path.join(sessionsDir, 'list-active-writer-a');
    const secondDir = path.join(sessionsDir, 'list-active-writer-b');
    const lockKey = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    const lockPath = path.join(sessionsDir, '.write-locks', `${lockKey}.lock`);
    const payload = `${JSON.stringify({
      _type: 'meta',
      id: sessionId,
      title: 'Active legacy writer',
      createdAt: '2026-07-31T00:00:00.000Z',
      scope: 'user',
      lineageVersion: 2,
      activeEntryId: null,
      activeMessageCount: 0,
    })}\n`;
    await mkdir(firstDir, { recursive: true });
    await mkdir(secondDir, { recursive: true });
    await mkdir(`${lockPath}.queue`, { recursive: true });
    await writeFile(path.join(firstDir, `${sessionId}.jsonl`), payload, 'utf8');
    let releaseWriter: (() => void) | undefined;
    let markWriterStarted: (() => void) | undefined;
    const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const writerStarted = new Promise<void>((resolve) => { markWriterStarted = resolve; });
    const writer = withKodaXFileLock(lockPath, async () => {
      markWriterStarted?.();
      await writerGate;
      await writeFile(path.join(secondDir, `${sessionId}.jsonl`), payload, 'utf8');
    });
    await writerStarted;
    const storage = new FileSessionStorage({ sessionsDir });
    expect((await storage.list(undefined, { limit: 10 }))
      .some((session) => session.id === sessionId)).toBe(true);
    releaseWriter?.();
    await writer;

    await expect(new FileSessionStorage({ sessionsDir }).readFullSnapshot(sessionId))
      .rejects.toMatchObject({ code: 'data_changed' });
  });

  it('keeps strict ambiguity fail-closed after a default list hides archived summaries', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'list-location-ambiguity';
    const projectDir = path.join(sessionsDir, 'ambiguous-list-project');
    const activePath = path.join(projectDir, `${sessionId}.jsonl`);
    const archivedDir = path.join(projectDir, 'archived');
    const archivedPath = path.join(archivedDir, `${sessionId}.jsonl`);
    const payload = `${JSON.stringify({
      _type: 'meta',
      id: sessionId,
      title: 'Ambiguous list location',
      createdAt: '2026-07-31T00:00:00.000Z',
      scope: 'user',
      lineageVersion: 2,
      activeEntryId: null,
      activeMessageCount: 0,
    })}\n`;
    await mkdir(archivedDir, { recursive: true });
    await writeFile(activePath, payload, 'utf8');
    await writeFile(archivedPath, payload, 'utf8');

    const storage = new FileSessionStorage({ sessionsDir });
    const listed = await storage.list(undefined, { limit: 10 });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: sessionId });
    expect(listed[0]?.archived).toBeUndefined();
    await expect(storage.readFullSnapshot(sessionId)).rejects.toMatchObject({
      code: 'data_changed',
    });
  });

  it('does not treat a project-scoped list location as globally verified', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'scoped-list-location-ambiguity';
    const projectRoots = process.platform === 'win32'
      ? ['C:/scoped-list-a', 'C:/scoped-list-b']
      : ['/scoped-list-a', '/scoped-list-b'];
    for (const projectRoot of projectRoots) {
      const projectDir = path.join(
        sessionsDir,
        deriveProjectKeyFromRoot(projectRoot).key,
      );
      await mkdir(projectDir, { recursive: true });
      await writeFile(path.join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify({
        _type: 'meta',
        id: sessionId,
        title: 'Scoped list ambiguity',
        gitRoot: projectRoot,
        runtimeInfo: { canonicalRepoRoot: projectRoot, workspaceRoot: projectRoot },
        createdAt: '2026-07-31T00:00:00.000Z',
        scope: 'user',
        lineageVersion: 2,
        activeEntryId: null,
        activeMessageCount: 0,
      })}\n`, 'utf8');
    }

    const storage = new FileSessionStorage({ sessionsDir });
    expect(await storage.list(projectRoots[0], { limit: 10 })).toHaveLength(1);
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'rewrite one legacy duplicate' }],
      title: 'Scoped list ambiguity rewrite',
      gitRoot: projectRoots[0]!,
      lineage: createSessionLineage([
        { role: 'user', content: 'rewrite one legacy duplicate' },
      ]),
    });
    await expect(storage.readFullSnapshot(sessionId)).rejects.toMatchObject({
      code: 'data_changed',
    });
  });

  it('does not hash unrelated writer queues for a project-scoped list', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = testSessionsDir();
    const projectRoot = path.join(sessionsDir, 'scoped-project-root');
    const projectDir = path.join(
      sessionsDir,
      deriveProjectKeyFromRoot(projectRoot).key,
    );
    const writeLocks = path.join(sessionsDir, '.write-locks');
    await mkdir(projectDir, { recursive: true });
    await Promise.all(Array.from({ length: 20 }, (_unused, index) =>
      mkdir(path.join(writeLocks, `${index}.lock.queue`), { recursive: true })));
    await writeFile(path.join(projectDir, 'scoped-list.jsonl'), `${JSON.stringify({
      _type: 'meta',
      id: 'scoped-list',
      title: 'Scoped list',
      gitRoot: projectRoot,
      createdAt: '2026-08-15T00:00:00.000Z',
      scope: 'user',
      activeMessageCount: 1,
    })}\n`, 'utf8');
    const statSync = vi.spyOn(fsSync, 'statSync');

    try {
      await expect(new FileSessionStorage({ sessionsDir }).list(projectRoot, { limit: 10 }))
        .resolves.toHaveLength(1);
      expect(statSync.mock.calls.some(([candidate]) =>
        String(candidate).endsWith('.lock.queue'))).toBe(false);
    } finally {
      statSync.mockRestore();
    }
  });

  it('drops a partial location hint when its file disappears before indexing', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'vanished-partial-location';
    const mainPath = path.join(sessionsDir, 'vanished-project', `${sessionId}.jsonl`);
    await mkdir(path.dirname(mainPath), { recursive: true });
    await writeFile(mainPath, '{}\n', 'utf8');
    await rm(mainPath);

    const storage = new FileSessionStorage({ sessionsDir });
    storage.indexSessionLocations([mainPath], false);
    await expect(storage.readFullSnapshot(sessionId)).resolves.toBeNull();
  });

  it('does not treat an empty hinted payload as proof that the id is globally missing', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'empty-hinted-location-ambiguity';
    const projectRoots = process.platform === 'win32'
      ? ['C:/empty-hint-a', 'C:/empty-hint-b']
      : ['/empty-hint-a', '/empty-hint-b'];
    const projectDirs = projectRoots.map((projectRoot) => path.join(
      sessionsDir,
      deriveProjectKeyFromRoot(projectRoot).key,
    ));
    await Promise.all(projectDirs.map((projectDir) => mkdir(projectDir, {
      recursive: true,
    })));
    await writeFile(
      path.join(projectDirs[0]!, `${sessionId}.jsonl`),
      '',
      'utf8',
    );
    await writeFile(
      path.join(projectDirs[1]!, `${sessionId}.jsonl`),
      `${JSON.stringify({
        _type: 'meta',
        id: sessionId,
        title: 'Other duplicate',
        createdAt: '2026-07-31T00:00:00.000Z',
        scope: 'user',
      })}\n`,
      'utf8',
    );

    const storage = new FileSessionStorage({ sessionsDir });
    expect(await storage.list(projectRoots[0], { limit: 10 })).toEqual([]);
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'replace empty hinted payload' }],
      title: 'Replaced empty hint',
      gitRoot: projectRoots[0]!,
      lineage: createSessionLineage([
        { role: 'user', content: 'replace empty hinted payload' },
      ]),
    });
    await expect(storage.readFullSnapshot(sessionId)).rejects.toMatchObject({
      code: 'data_changed',
    });
  });

  it('does not verify a global list index when one project traversal fails', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'incomplete-global-list-index';
    const projectDirs = [
      path.join(sessionsDir, 'incomplete-list-a'),
      path.join(sessionsDir, 'incomplete-list-b'),
    ];
    const payload = `${JSON.stringify({
      _type: 'meta',
      id: sessionId,
      title: 'Incomplete global list',
      createdAt: '2026-07-31T00:00:00.000Z',
      scope: 'user',
      lineageVersion: 2,
      activeEntryId: null,
      activeMessageCount: 0,
    })}\n`;
    const storage = new FileSessionStorage({ sessionsDir });
    await storage.list(undefined, { limit: 10 });
    for (const projectDir of projectDirs) {
      await mkdir(projectDir, { recursive: true });
      await writeFile(path.join(projectDir, `${sessionId}.jsonl`), payload, 'utf8');
    }
    const originalReaddir = fsPromises.readdir.bind(fsPromises);
    const readdir = vi.spyOn(fsPromises, 'readdir').mockImplementation(
      async (directory, options) => {
        if (path.resolve(String(directory)) === path.resolve(projectDirs[1]!)) {
          throw Object.assign(new Error('project unreadable'), { code: 'EACCES' });
        }
        return originalReaddir(directory, options as never);
      },
    );
    try {
      expect(await storage.list(undefined, { limit: 10 })).toHaveLength(1);
    } finally {
      readdir.mockRestore();
    }
    await expect(storage.readFullSnapshot(sessionId)).rejects.toMatchObject({
      code: 'data_changed',
    });
  });

  it('fails strict reads closed during an in-progress layout migration', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'strict-mid-migration';
    const projectDir = path.join(sessionsDir, 'migration-target');
    const mainPath = path.join(projectDir, `${sessionId}.jsonl`);
    const strandedSidecarPath = path.join(sessionsDir, `${sessionId}.islands.jsonl`);
    const timestamp = '2026-07-30T00:00:00.000Z';
    const parent = {
      id: 'entry_migration_parent',
      parentId: null,
      timestamp,
      type: 'message' as const,
      message: { role: 'user' as const, content: 'parent' },
    };
    const child = {
      id: 'entry_migration_child',
      parentId: parent.id,
      timestamp,
      type: 'message' as const,
      message: { role: 'assistant' as const, content: 'archived child' },
    };
    await mkdir(projectDir, { recursive: true });
    await writeFile(mainPath, [
      JSON.stringify({
        _type: 'meta',
        id: sessionId,
        title: 'Mid migration',
        gitRoot: '/tmp/test-repo',
        createdAt: timestamp,
        lineageVersion: 2,
        activeEntryId: parent.id,
        activeMessageCount: 1,
      }),
      JSON.stringify({ _type: 'lineage_entry', entry: parent }),
    ].join('\n') + '\n', 'utf8');
    await writeFile(strandedSidecarPath, JSON.stringify({
      _type: 'archived_entry',
      archiveBatchId: 'migration-batch',
      entry: child,
    }) + '\n', 'utf8');
    await mkdir(path.join(sessionsDir, '.migration-lock'));

    await expect(
      new FileSessionStorage({ sessionsDir }).readFullSnapshot(sessionId),
    ).rejects.toMatchObject({ code: 'data_changed' });

    expect(await readFile(mainPath, 'utf8')).toContain(parent.id);
    expect(await readFile(strandedSidecarPath, 'utf8')).toContain(child.id);
    expect(existsSync(path.join(sessionsDir, '.write-locks'))).toBe(false);
  });

  it('reports a malformed sidecar tail as data_corrupt in strict mode', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'strict-corrupt-sidecar-tail';
    const mainPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    const timestamp = '2026-07-30T00:00:00.000Z';
    const entry = {
      id: 'entry_strict_tail',
      parentId: null,
      timestamp,
      type: 'message' as const,
      message: { role: 'user' as const, content: 'retained' },
    };
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(mainPath, [
      JSON.stringify({
        _type: 'meta',
        id: sessionId,
        title: 'Strict corrupt tail',
        gitRoot: '/tmp/test-repo',
        createdAt: timestamp,
        lineageVersion: 2,
        activeEntryId: entry.id,
        activeMessageCount: 1,
      }),
      JSON.stringify({ _type: 'lineage_entry', entry }),
    ].join('\n') + '\n', 'utf8');
    await writeFile(
      path.join(sessionsDir, `${sessionId}.islands.jsonl`),
      '{"_type":"archived_entry","archiveBatchId":"partial","entry":',
      'utf8',
    );

    await expect(
      new FileSessionStorage({ sessionsDir }).readFullSnapshot(sessionId),
    ).rejects.toMatchObject({ code: 'data_corrupt' });
  });

  it('persists private lineage adjacency anchors for newly archived entries', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'sidecar-adjacency-anchors';
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const initial = createSessionLineage([
      { role: 'user', content: 'retained parent' },
      { role: 'assistant', content: 'archived child one' },
      { role: 'assistant', content: 'archived child two' },
    ]);
    const retainedParent = initial.entries[0]!;
    const archivedChildOne = initial.entries[1]!;
    const archivedChildTwo = initial.entries[2]!;
    const label = {
      type: 'label' as const,
      id: 'label_retained_parent',
      parentId: null,
      logicalId: 'label_retained_parent',
      timestamp: '2026-07-30T00:00:00.000Z',
      targetId: retainedParent.id,
      label: 'retain-parent',
    };
    const labeled: KodaXSessionLineage = {
      ...initial,
      entries: [...initial.entries, label],
    };
    const compacted = applySessionCompaction(
      labeled,
      [{ role: 'user', content: 'current island' }],
      { summary: 'old island' },
    );

    await new FileSessionStorage({ sessionsDir }).save(sessionId, {
      messages: [{ role: 'user', content: 'current island' }],
      title: 'Sidecar adjacency anchors',
      gitRoot,
      lineage: compacted,
    });

    const sidecarPath = path.join(
      sessionsDir,
      deriveProjectKeyFromRoot(gitRoot).key,
      `${sessionId}.islands.jsonl`,
    );
    const archived = (await readFile(sidecarPath, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        _type?: string;
        previousEntryId?: string | null;
        nextEntryId?: string | null;
        entry?: { id?: string };
      })
      .filter((line) => line._type === 'archived_entry');
    const byId = new Map(archived.map((line) => [line.entry?.id, line]));

    expect(byId.get(archivedChildOne.id)).toMatchObject({
      previousEntryId: retainedParent.id,
      nextEntryId: archivedChildTwo.id,
    });
    expect(byId.get(archivedChildTwo.id)).toMatchObject({
      previousEntryId: archivedChildOne.id,
      nextEntryId: label.id,
    });
  });

  it('does not replace the exact main file when the island sidecar flush fails', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const initialMessages = [{ role: 'user' as const, content: 'sidecar failure exact FOXTROT-661' }];
    const initialLineage = createSessionLineage(initialMessages);
    await storage.save('sidecar-flush-failure', {
      messages: initialMessages,
      title: 'Sidecar failure ordering',
      gitRoot,
      lineage: initialLineage,
    });

    const compacted = applySessionCompaction(
      initialLineage,
      [{ role: 'user', content: 'active after rejected compact' }],
      { summary: 'old exact value exists' },
    );
    const originalOpen = fsPromises.open.bind(fsPromises);
    const open = vi.spyOn(fsPromises, 'open');
    open.mockImplementation(async (filePath, flags, mode) => {
      if (String(filePath).endsWith('.islands.jsonl')) {
        throw Object.assign(new Error('simulated sidecar flush failure'), { code: 'EIO' });
      }
      return originalOpen(filePath, flags, mode);
    });
    try {
      await expect(storage.save('sidecar-flush-failure', {
        messages: [{ role: 'user', content: 'active after rejected compact' }],
        title: 'Sidecar failure ordering',
        gitRoot,
        lineage: compacted,
      })).rejects.toThrow('simulated sidecar flush failure');
    } finally {
      open.mockRestore();
    }

    const restarted = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    expect((await restarted.load('sidecar-flush-failure'))?.messages).toEqual(initialMessages);
    expect((await restarted.loadFullLineage('sidecar-flush-failure'))?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'message',
          message: expect.objectContaining({ content: 'sidecar failure exact FOXTROT-661' }),
        }),
      ]),
    );
  });

  it('keeps the prior main file authoritative when the post-archive replace fails', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const initialMessages = [{ role: 'user' as const, content: 'failure-safe exact ECHO-551' }];
    const initialLineage = createSessionLineage(initialMessages);
    await storage.save('archive-before-replace', {
      messages: initialMessages,
      title: 'Failure ordering',
      gitRoot,
      lineage: initialLineage,
    });

    const compacted = applySessionCompaction(
      initialLineage,
      [{ role: 'user', content: 'active after failed compact' }],
      { summary: 'old exact value exists' },
    );
    const originalRename = fsPromises.rename.bind(fsPromises);
    const rename = vi.spyOn(fsPromises, 'rename');
    rename.mockImplementation(async (oldPath, newPath) => {
      if (String(newPath).endsWith('archive-before-replace.jsonl')) {
        throw Object.assign(new Error('simulated durable replace failure'), { code: 'EIO' });
      }
      await originalRename(oldPath, newPath);
    });
    try {
      await expect(storage.save('archive-before-replace', {
        messages: [{ role: 'user', content: 'active after failed compact' }],
        title: 'Failure ordering',
        gitRoot,
        lineage: compacted,
      })).rejects.toThrow('simulated durable replace failure');
    } finally {
      rename.mockRestore();
    }

    const restarted = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    expect((await restarted.load('archive-before-replace'))?.messages).toEqual(initialMessages);
    const full = await restarted.loadFullLineage('archive-before-replace');
    expect(full?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({ content: 'failure-safe exact ECHO-551' }),
      }),
    ]));
  });

  it('preserves the unslimmed append watermark across archive maintenance', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const oldMessages = Array.from({ length: 501 }, (_, index) => ({
      role: 'user' as const,
      content: `old branch ${index}`,
    }));
    const oldLineage = createSessionLineage(oldMessages);
    await storage.save('maintenance-watermark', {
      messages: oldMessages,
      title: 'Maintenance watermark',
      gitRoot,
      lineage: oldLineage,
    });

    const switched = createSessionLineage([{ role: 'user', content: 'new root' }], oldLineage);
    await storage.appendSessionDelta('maintenance-watermark', {
      messages: [{ role: 'user', content: 'new root' }],
      title: 'Maintenance watermark',
      gitRoot,
      lineage: switched,
    });
    const extended = createSessionLineage([
      { role: 'user', content: 'new root' },
      { role: 'assistant', content: 'new root reply' },
    ], switched);
    await storage.appendSessionDelta('maintenance-watermark', {
      messages: [
        { role: 'user', content: 'new root' },
        { role: 'assistant', content: 'new root reply' },
      ],
      title: 'Maintenance watermark',
      gitRoot,
      lineage: extended,
    });
    // archive/unarchive are serialized behind both queued maintenance runs.
    await storage.archive('maintenance-watermark');
    await storage.unarchive('maintenance-watermark');

    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sidecarPath = path.join(
      testSessionsDir(),
      deriveProjectKeyFromRoot(gitRoot).key,
      'maintenance-watermark.islands.jsonl',
    );
    const archivedIds = (await readFile(sidecarPath, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { _type?: string; entry?: { id?: string } })
      .filter((line) => line._type === 'archived_entry')
      .map((line) => line.entry?.id)
      .filter((id): id is string => typeof id === 'string');
    expect(new Set(archivedIds).size).toBe(archivedIds.length);
    expect((await storage.load('maintenance-watermark'))?.messages).toEqual([
      { role: 'user', content: 'new root' },
      { role: 'assistant', content: 'new root reply' },
    ]);
  });

  it('appendSessionDelta full-merges when caller provides updated extensionState', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');

    await storage.save('session-extension-state-update', {
      messages: [{ role: 'user', content: 'test' }],
      title: 'Original Title',
      gitRoot,
      extensionState: { 'ext:sample': { visits: 1 } },
    });

    const loaded1 = await storage.load('session-extension-state-update');
    expect(loaded1?.extensionState).toEqual({ 'ext:sample': { visits: 1 } });

    const messages = [
      { role: 'user' as const, content: 'test' },
      { role: 'assistant' as const, content: 'reply' },
    ];
    await storage.appendSessionDelta('session-extension-state-update', {
      messages,
      title: 'Updated Title',
      gitRoot,
      lineage: createSessionLineage(messages, loaded1!.lineage),
      extensionState: { 'ext:sample': { visits: 2 } },
    });

    const loaded2 = await storage.load('session-extension-state-update');
    expect(loaded2?.title).toBe('Updated Title');
    expect(loaded2?.extensionState).toEqual({ 'ext:sample': { visits: 2 } });
  });

  it('appendSessionDelta full-merges when caller clears extensionRecords', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');
    const initialMessages = [{ role: 'user' as const, content: 'test' }];

    await storage.save('session-extension-records-clear', {
      messages: initialMessages,
      title: 'Original Title',
      gitRoot,
      lineage: createSessionLineage(initialMessages),
      extensionRecords: [
        {
          id: 'record-1',
          extensionId: 'ext:sample',
          type: 'turn',
          ts: 1,
        },
      ],
    });

    const loaded1 = await storage.load('session-extension-records-clear');
    expect(loaded1?.extensionRecords).toHaveLength(1);

    const messages = [
      ...initialMessages,
      { role: 'assistant' as const, content: 'reply' },
    ];
    await storage.appendSessionDelta('session-extension-records-clear', {
      messages,
      title: 'Updated Title',
      gitRoot,
      lineage: createSessionLineage(messages, loaded1!.lineage),
      extensionRecords: [],
    });

    const loaded2 = await storage.load('session-extension-records-clear');
    expect(loaded2?.title).toBe('Updated Title');
    expect(loaded2?.extensionRecords).toEqual([]);
  });

  it('full-merges an in-place extension record replacement followed by an append', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const sessionId = 'session-extension-record-replace-append';
    const initialMessages = [{ role: 'user' as const, content: 'extension base' }];
    await storage.save(sessionId, {
      messages: initialMessages,
      title: 'Extension replace and append',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(initialMessages),
      extensionRecords: [{
        id: 'record-original',
        extensionId: 'ext:sample',
        type: 'turn',
        ts: 1,
        dedupeKey: 'same-turn',
        data: { revision: 1 },
      }],
    });
    const loaded = await storage.load(sessionId);
    if (!loaded?.lineage || !loaded.extensionRecords) {
      throw new Error('expected extension record state');
    }
    loaded.extensionRecords.splice(0, 1, {
      id: 'record-replacement',
      extensionId: 'ext:sample',
      type: 'turn',
      ts: 2,
      dedupeKey: 'same-turn',
      data: { revision: 2 },
    });
    loaded.extensionRecords.push({
      id: 'record-tail',
      extensionId: 'ext:sample',
      type: 'turn',
      ts: 3,
      dedupeKey: 'new-turn',
    });
    const messages = [
      ...initialMessages,
      { role: 'assistant' as const, content: 'extension tail' },
    ];

    await storage.appendSessionDelta(sessionId, {
      ...loaded,
      messages,
      lineage: createSessionLineage(messages, loaded.lineage),
    });

    await expect(storage.load(sessionId)).resolves.toMatchObject({
      extensionRecords: [
        { id: 'record-replacement', data: { revision: 2 } },
        { id: 'record-tail' },
      ],
    });
  });

  it('appendSessionDelta fallback preserves runtimeInfo and errorMetadata', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');

    // Save with runtimeInfo and errorMetadata
    await storage.save('session-fallback', {
      messages: [{ role: 'user', content: 'test' }],
      title: 'Fallback Test',
      gitRoot,
      runtimeInfo: {
        canonicalRepoRoot: gitRoot,
        workspaceRoot: gitRoot,
        executionCwd: gitRoot,
        branch: 'main',
        workspaceKind: 'detected' as const,
      },
      errorMetadata: { lastError: 'test error', lastErrorTime: 12345, consecutiveErrors: 0 },
    });

    // appendSessionDelta WITHOUT lineage → triggers fallback mergeAndWriteInternal
    await storage.appendSessionDelta('session-fallback', {
      messages: [{ role: 'user', content: 'test' }, { role: 'assistant', content: 'reply' }],
      title: 'Fallback Updated',
      gitRoot,
      // No lineage → fallback
    });

    // Verify runtimeInfo and errorMetadata are preserved
    const loaded = await storage.load('session-fallback');
    expect(loaded?.runtimeInfo).toEqual(expect.objectContaining({
      canonicalRepoRoot: gitRoot,
      branch: 'main',
    }));
    expect(loaded?.errorMetadata).toEqual(expect.objectContaining({
      lastError: 'test error',
    }));
    expect(loaded?.title).toBe('Fallback Updated');
  });

  it('clears errorMetadata when a full save explicitly supplies undefined', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');
    const messages = [{ role: 'user' as const, content: 'request' }];

    await storage.save('session-error-clear', {
      messages,
      title: 'Error Clear',
      gitRoot,
      errorMetadata: {
        lastError: 'runtime run aborted',
        lastErrorTime: 1,
        consecutiveErrors: 1,
      },
    });
    await storage.save('session-error-clear', {
      messages,
      title: 'Successful Turn',
      gitRoot,
      errorMetadata: undefined,
    });

    expect((await storage.load('session-error-clear'))?.errorMetadata)
      .toBeUndefined();
  });

  it('preserves errorMetadata when a partial full save omits the field', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');
    const messages = [{ role: 'user' as const, content: 'request' }];

    await storage.save('session-error-preserve', {
      messages,
      title: 'Error Preserve',
      gitRoot,
      errorMetadata: {
        lastError: 'runtime run aborted',
        lastErrorTime: 1,
        consecutiveErrors: 1,
      },
    });
    await storage.save('session-error-preserve', {
      messages,
      title: 'Partial Update',
      gitRoot,
    });

    expect((await storage.load('session-error-preserve'))?.errorMetadata)
      .toMatchObject({
        lastError: 'runtime run aborted',
        consecutiveErrors: 1,
      });
  });

  it('clears errorMetadata through appendSessionDelta when explicitly undefined', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');
    const firstMessages = [{ role: 'user' as const, content: 'request' }];
    const firstLineage = createSessionLineage(firstMessages);

    await storage.save('session-error-append-clear', {
      messages: firstMessages,
      title: 'Append Error Clear',
      gitRoot,
      lineage: firstLineage,
      errorMetadata: {
        lastError: 'runtime run aborted',
        lastErrorTime: 1,
        consecutiveErrors: 1,
      },
    });
    const messages = [
      ...firstMessages,
      { role: 'assistant' as const, content: 'successful answer' },
    ];
    await storage.appendSessionDelta('session-error-append-clear', {
      messages,
      title: 'Append Error Clear',
      gitRoot,
      lineage: createSessionLineage(messages, firstLineage),
      errorMetadata: undefined,
    });

    expect((await storage.load('session-error-append-clear'))?.errorMetadata)
      .toBeUndefined();
  });

  it('preserves errorMetadata through appendSessionDelta when omitted', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');
    const firstMessages = [{ role: 'user' as const, content: 'request' }];
    const firstLineage = createSessionLineage(firstMessages);

    await storage.save('session-error-append-preserve', {
      messages: firstMessages,
      title: 'Append Error Preserve',
      gitRoot,
      lineage: firstLineage,
      errorMetadata: {
        lastError: 'runtime run aborted',
        lastErrorTime: 1,
        consecutiveErrors: 1,
      },
    });
    const messages = [
      ...firstMessages,
      { role: 'assistant' as const, content: 'partial host update' },
    ];
    await storage.appendSessionDelta('session-error-append-preserve', {
      messages,
      title: 'Append Error Preserve',
      gitRoot,
      lineage: createSessionLineage(messages, firstLineage),
    });

    expect((await storage.load('session-error-append-preserve'))?.errorMetadata)
      .toMatchObject({
        lastError: 'runtime run aborted',
        consecutiveErrors: 1,
      });
  });

  it('appendSessionDelta fallback persists session tag into the initial meta line', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');

    await storage.appendSessionDelta('session-host-tag', {
      messages: [{ role: 'user', content: 'partner request' }],
      title: 'Host Owned Partner',
      gitRoot,
      scope: 'user',
      tag: 'partner',
    });

    const loaded = await storage.load('session-host-tag');
    expect(loaded?.tag).toBe('partner');

    const sessionPath = path.join(
      tempHome,
      '.kodax',
      'sessions',
      deriveProjectKeyFromRoot(gitRoot).key,
      'session-host-tag.jsonl',
    );
    const firstLine = (await readFile(sessionPath, 'utf-8')).split('\n')[0]!;
    expect(JSON.parse(firstLine).tag).toBe('partner');
  });

  it('appendSessionDelta hot path preserves an existing tag when the partial payload omits it', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');

    const lineage1 = createSessionLineage([
      { role: 'user', content: 'hello' },
    ]);
    await storage.save('session-tag-preserve', {
      messages: [{ role: 'user', content: 'hello' }],
      title: 'Tagged Session',
      gitRoot,
      scope: 'user',
      lineage: lineage1,
      tag: 'partner',
    });

    const loaded1 = await storage.load('session-tag-preserve');
    const lineage2 = createSessionLineage([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'reply' },
    ], loaded1!.lineage);

    await storage.appendSessionDelta('session-tag-preserve', {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'reply' },
      ],
      title: 'Tagged Session Updated',
      gitRoot,
      lineage: lineage2,
    });

    const loaded2 = await storage.load('session-tag-preserve');
    expect(loaded2?.title).toBe('Tagged Session Updated');
    expect(loaded2?.tag).toBe('partner');
  });

  it('does not re-serialize persisted lineage entries while initializing a load watermark', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const writer = new FileSessionStorage({ sessionsDir });
    const messages = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `load watermark message ${index}`,
    }));
    await writer.save('session-load-watermark-cost', {
      messages,
      title: 'Load watermark cost',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(messages),
    });
    const stringify = vi.spyOn(JSON, 'stringify');

    try {
      await new FileSessionStorage({ sessionsDir }).load('session-load-watermark-cost');
      const serializedPersistedEntry = stringify.mock.calls.some(([value]) => {
        if (value === null || typeof value !== 'object') return false;
        const candidate = value as { type?: unknown; message?: { content?: unknown } };
        return candidate.type === 'message'
          && typeof candidate.message?.content === 'string'
          && candidate.message.content.startsWith('load watermark message ');
      });
      expect(serializedPersistedEntry).toBe(false);
    } finally {
      stringify.mockRestore();
    }
  });

  it('does not re-serialize the persisted prefix on the prepared tail path', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const baseMessages = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `append watermark message ${index}`,
    }));
    await storage.save('session-append-watermark-cost', {
      messages: baseMessages,
      title: 'Append watermark cost',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(baseMessages),
    });
    const loaded = await storage.load('session-append-watermark-cost');
    const persistedPrefixEntry = loaded?.lineage?.entries[0];
    if (!loaded?.lineage || persistedPrefixEntry === undefined) {
      throw new Error('expected persisted lineage');
    }
    const messages = [
      ...baseMessages,
      { role: 'user' as const, content: 'new append tail' },
    ];
    const lineage = createSessionLineage(messages, loaded.lineage);
    const baseline = await storage.prepareSessionAppend('session-append-watermark-cost');
    if (baseline === null) throw new Error('expected prepared append boundary');
    const stringify = vi.spyOn(JSON, 'stringify');

    try {
      await storage.appendPreparedSessionTail('session-append-watermark-cost', {
        baseline,
        title: loaded.title,
        activeEntryId: lineage.activeEntryId,
        lineageEntries: lineage.entries.slice(baseline.lineageCount),
      });
      expect(stringify.mock.calls.some(([value]) => value === persistedPrefixEntry)).toBe(false);
    } finally {
      stringify.mockRestore();
    }
  });

  it('does not bind an append watermark to a file replaced during load', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = testSessionsDir();
    const writer = new FileSessionStorage({ sessionsDir });
    const sessionId = 'session-load-replace-race';
    const baseMessages = [{ role: 'user' as const, content: 'identity race base' }];
    await writer.save(sessionId, {
      messages: baseMessages,
      title: 'Load replace race',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(baseMessages),
    });
    const mainPath = path.join(
      sessionsDir,
      deriveProjectKeyFromRoot(KODAX_REPO_ROOT).key,
      `${sessionId}.jsonl`,
    );
    const oldContent = await readFile(mainPath, 'utf8');
    const replacementContent = oldContent.replace(
      'identity race base',
      'identity race durable replacement',
    );
    const reader = new FileSessionStorage({ sessionsDir });
    await reader.isArchived(sessionId);
    const originalReadFile = fsPromises.readFile.bind(fsPromises);
    let replaced = false;
    const raceRead = vi.spyOn(fsPromises, 'readFile').mockImplementation(async (candidate, options) => {
      if (!replaced && path.resolve(String(candidate)) === path.resolve(mainPath)) {
        replaced = true;
        const replacementPath = `${mainPath}.replacement`;
        await writeFile(replacementPath, replacementContent, 'utf8');
        await fsPromises.rename(replacementPath, mainPath);
        return oldContent;
      }
      return originalReadFile(candidate, options);
    });
    const loaded = await reader.load(sessionId);
    raceRead.mockRestore();
    if (!loaded?.lineage) throw new Error('expected raced load lineage');
    const messages = [
      ...baseMessages,
      { role: 'assistant' as const, content: 'identity race tail' },
    ];
    const appendRead = vi.spyOn(fsPromises, 'readFile');

    await reader.appendSessionDelta(sessionId, {
      ...loaded,
      messages,
      lineage: createSessionLineage(messages, loaded.lineage),
    });

    expect(appendRead.mock.calls.filter(
      ([candidate]) => path.resolve(String(candidate)) === path.resolve(mainPath),
    ).length).toBeGreaterThan(0);
  });

  it('fails a strict read when the main Session file is replaced during the read', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = testSessionsDir();
    const writer = new FileSessionStorage({ sessionsDir });
    const sessionId = 'session-strict-read-replace-race';
    const baseMessages = [{ role: 'user' as const, content: 'strict identity race base' }];
    await writer.save(sessionId, {
      messages: baseMessages,
      title: 'Strict read replace race',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(baseMessages),
    });
    const mainPath = path.join(
      sessionsDir,
      deriveProjectKeyFromRoot(KODAX_REPO_ROOT).key,
      `${sessionId}.jsonl`,
    );
    const oldContent = await readFile(mainPath, 'utf8');
    const replacementContent = oldContent.replace(
      'strict identity race base',
      'strict identity race durable replacement',
    );
    const reader = new FileSessionStorage({ sessionsDir });
    await reader.isArchived(sessionId);
    const originalReadFile = fsPromises.readFile.bind(fsPromises);
    let replaced = false;
    const raceRead = vi.spyOn(fsPromises, 'readFile').mockImplementation(async (candidate, options) => {
      if (!replaced && path.resolve(String(candidate)) === path.resolve(mainPath)) {
        replaced = true;
        const replacementPath = `${mainPath}.replacement`;
        await writeFile(replacementPath, replacementContent, 'utf8');
        await fsPromises.rename(replacementPath, mainPath);
        return oldContent;
      }
      return originalReadFile(candidate, options);
    });

    try {
      await expect(reader.read(sessionId)).rejects.toMatchObject({ code: 'data_changed' });
    } finally {
      raceRead.mockRestore();
    }
  });

  it('does not reload and parse the main Session payload on the prepared tail path', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = testSessionsDir();
    const storage = new FileSessionStorage({ sessionsDir });
    const gitRoot = tempHome.replace(/\\/g, '/');
    const first = createSessionLineage([{ role: 'user', content: 'first' }]);
    await storage.save('session-single-append-read', {
      messages: [{ role: 'user', content: 'first' }],
      title: 'Single append read',
      gitRoot,
      lineage: first,
    });
    const loaded = await storage.load('session-single-append-read');
    const next = createSessionLineage([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    ], loaded!.lineage);
    const mainPath = path.join(
      sessionsDir,
      deriveProjectKeyFromRoot(gitRoot).key,
      'session-single-append-read.jsonl',
    );
    const readFile = vi.spyOn(fsPromises, 'readFile');
    const baseline = await storage.prepareSessionAppend('session-single-append-read');
    if (baseline === null) throw new Error('expected prepared append boundary');

    await storage.appendPreparedSessionTail('session-single-append-read', {
      baseline,
      title: 'Single append read',
      activeEntryId: next.activeEntryId,
      lineageEntries: next.entries.slice(baseline.lineageCount),
    });

    expect(readFile.mock.calls.filter(
      ([candidate]) => path.resolve(String(candidate)) === path.resolve(mainPath),
    )).toHaveLength(0);
  });

  it('rejects prepared tail ids that are not new without consuming the boundary', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const storage = new FileSessionStorage({ sessionsDir });
    const sessionId = 'session-prepared-tail-id-collision';
    const initialMessages = [{ role: 'user' as const, content: 'collision base' }];
    const initialLineage = createSessionLineage(initialMessages);
    await storage.save(sessionId, {
      messages: initialMessages,
      title: 'Prepared tail id collision',
      gitRoot: KODAX_REPO_ROOT,
      lineage: initialLineage,
      artifactLedger: [{
        id: 'artifact-existing',
        kind: 'file_read',
        target: 'existing.ts',
        timestamp: '2026-08-02T00:00:00.000Z',
      }],
      extensionRecords: [{
        id: 'extension-existing',
        extensionId: 'ext:prepared-tail',
        type: 'turn',
        ts: 1,
      }],
    });
    await storage.load(sessionId);
    const baseline = await storage.prepareSessionAppend(sessionId);
    if (baseline === null) throw new Error('expected prepared append boundary');

    const duplicateLineageEntry: KodaXSessionEntry = {
      type: 'message',
      id: initialLineage.entries[0]!.id,
      parentId: baseline.activeEntryId,
      logicalId: 'duplicate-lineage-tail',
      timestamp: '2026-08-02T00:00:01.000Z',
      message: { role: 'assistant', content: 'must not duplicate history' },
    };
    await expect(storage.appendPreparedSessionTail(sessionId, {
      baseline,
      title: 'Prepared tail id collision',
      activeEntryId: duplicateLineageEntry.id,
      lineageEntries: [duplicateLineageEntry],
    })).rejects.toMatchObject({ code: 'data_changed' });

    await expect(storage.appendPreparedSessionTail(sessionId, {
      baseline,
      title: 'Prepared tail id collision',
      activeEntryId: baseline.activeEntryId,
      lineageEntries: [],
      artifactEntries: [{
        id: 'artifact-existing',
        kind: 'file_modified',
        target: 'replacement.ts',
        timestamp: '2026-08-02T00:00:02.000Z',
      }],
    })).rejects.toMatchObject({ code: 'data_changed' });

    await expect(storage.appendPreparedSessionTail(sessionId, {
      baseline,
      title: 'Prepared tail id collision',
      activeEntryId: baseline.activeEntryId,
      lineageEntries: [],
      extensionRecords: [{
        id: 'extension-existing',
        extensionId: 'ext:prepared-tail',
        type: 'turn',
        ts: 2,
      }],
    })).rejects.toMatchObject({ code: 'data_changed' });

    const orphanEntry: KodaXSessionEntry = {
      type: 'message',
      id: 'orphan-prepared-tail',
      parentId: baseline.activeEntryId,
      logicalId: 'orphan-prepared-tail',
      timestamp: '2026-08-02T00:00:02.500Z',
      message: { role: 'assistant', content: 'must not remain outside the active path' },
    };
    await expect(storage.appendPreparedSessionTail(sessionId, {
      baseline,
      title: 'Prepared tail id collision',
      activeEntryId: baseline.activeEntryId,
      lineageEntries: [orphanEntry],
    })).rejects.toMatchObject({ code: 'data_changed' });

    const repeatedEntry: KodaXSessionEntry = {
      ...orphanEntry,
      id: 'repeated-prepared-tail',
      logicalId: 'repeated-prepared-tail',
    };
    await expect(storage.appendPreparedSessionTail(sessionId, {
      baseline,
      title: 'Prepared tail id collision',
      activeEntryId: repeatedEntry.id,
      lineageEntries: [repeatedEntry, { ...repeatedEntry }],
    })).rejects.toMatchObject({ code: 'data_changed' });

    const validEntry: KodaXSessionEntry = {
      type: 'message',
      id: 'unique-prepared-tail',
      parentId: baseline.activeEntryId,
      logicalId: 'unique-prepared-tail',
      timestamp: '2026-08-02T00:00:03.000Z',
      message: { role: 'assistant', content: 'unique tail persists' },
    };
    await storage.appendPreparedSessionTail(sessionId, {
      baseline,
      title: 'Prepared tail id collision',
      activeEntryId: validEntry.id,
      lineageEntries: [validEntry],
    });
    expect((await storage.load(sessionId))?.messages.at(-1)?.content).toBe('unique tail persists');
  });

  it('rejects prepared artifact dedup replacements and ledger-cap rollover', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const storage = new FileSessionStorage({ sessionsDir });
    const baseMessages = [{ role: 'user' as const, content: 'artifact base' }];
    await storage.save('session-prepared-artifact-dedup', {
      messages: baseMessages,
      title: 'Prepared artifact dedup',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(baseMessages),
      artifactLedger: [{
        id: 'artifact-original',
        kind: 'file_read',
        sourceTool: 'read',
        action: 'read',
        target: 'same.ts',
        timestamp: '2026-08-02T00:00:00.000Z',
      }],
    });
    await storage.load('session-prepared-artifact-dedup');
    const dedupBaseline = await storage.prepareSessionAppend('session-prepared-artifact-dedup');
    if (dedupBaseline === null) throw new Error('expected prepared artifact boundary');
    await expect(storage.appendPreparedSessionTail('session-prepared-artifact-dedup', {
      baseline: dedupBaseline,
      title: 'Prepared artifact dedup',
      activeEntryId: dedupBaseline.activeEntryId,
      lineageEntries: [],
      artifactEntries: [{
        id: 'artifact-replacement',
        kind: 'file_read',
        sourceTool: 'read',
        action: 'read',
        target: 'same.ts',
        timestamp: '2026-08-02T00:00:01.000Z',
      }],
    })).rejects.toMatchObject({ code: 'data_changed' });

    const cappedArtifacts: KodaXSessionArtifactLedgerEntry[] = Array.from(
      { length: 256 },
      (_, index) => ({
        id: `capped-artifact-${index}`,
        kind: 'file_read',
        target: `capped-${index}.ts`,
        timestamp: '2026-08-02T00:00:00.000Z',
      }),
    );
    await storage.save('session-prepared-artifact-cap', {
      messages: baseMessages,
      title: 'Prepared artifact cap',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(baseMessages),
      artifactLedger: cappedArtifacts,
    });
    await storage.load('session-prepared-artifact-cap');
    const capBaseline = await storage.prepareSessionAppend('session-prepared-artifact-cap');
    if (capBaseline === null) throw new Error('expected capped artifact boundary');
    await expect(storage.appendPreparedSessionTail('session-prepared-artifact-cap', {
      baseline: capBaseline,
      title: 'Prepared artifact cap',
      activeEntryId: capBaseline.activeEntryId,
      lineageEntries: [],
      artifactEntries: [{
        id: 'artifact-over-cap',
        kind: 'file_read',
        target: 'over-cap.ts',
        timestamp: '2026-08-02T00:00:01.000Z',
      }],
    })).rejects.toMatchObject({ code: 'data_changed' });
  });

  it('uses a canonical-hash-bound identity filter for archived ids and keeps the page cache hot', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { buildSessionConversationHistory } = await import('../session/conversation-history.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = testSessionsDir();
    const gitRoot = tempHome.replace(/\\/g, '/');
    const sessionId = 'session-prepared-archived-identity';
    const messages = [
      { role: 'user' as const, content: 'archived identity root' },
      { role: 'assistant' as const, content: 'active identity leaf' },
    ];
    const lineage = createSessionLineage(messages);
    const storage = new FileSessionStorage({ sessionsDir });
    await storage.save(sessionId, {
      messages,
      title: 'Prepared archived identity',
      gitRoot,
      lineage,
    });
    const projectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(gitRoot).key);
    const mainPath = path.join(projectDir, `${sessionId}.jsonl`);
    const archivedEntry = lineage.entries[0]!;
    const mainLines = (await readFile(mainPath, 'utf8')).trimEnd().split('\n')
      .filter((line) => {
        const parsed = JSON.parse(line) as { _type?: string; entry?: { id?: string } };
        return parsed._type !== 'lineage_entry' || parsed.entry?.id !== archivedEntry.id;
      });
    await writeFile(mainPath, `${mainLines.join('\n')}\n`, 'utf8');
    await writeFile(
      path.join(projectDir, `${sessionId}.islands.jsonl`),
      `${JSON.stringify({
        _type: 'archived_entry',
        archiveBatchId: 'archived-identity-batch',
        entry: archivedEntry,
      })}\n`,
      'utf8',
    );
    const capture = await storage.readFullSnapshot(sessionId);
    if (capture === null || capture.lineage === null) throw new Error('expected full archived capture');
    await storage.prepareConversationPageCache(
      sessionId,
      buildSessionConversationHistory(capture.lineage, capture.sourceRevision),
      capture.lineage,
      capture.data.runtimeInfo,
      capture.boundaryRevision,
      capture.sourceRevisionState,
    );

    const cold = new FileSessionStorage({ sessionsDir });
    await cold.load(sessionId);
    const baseline = await cold.prepareSessionAppend(sessionId);
    if (baseline === null) throw new Error('expected cold archived prepared boundary');
    const duplicateArchived: KodaXSessionEntry = {
      type: 'message',
      id: archivedEntry.id,
      parentId: baseline.activeEntryId,
      logicalId: archivedEntry.id,
      timestamp: '2026-08-02T00:00:02.000Z',
      message: { role: 'user', content: 'must not replace archived history' },
    };
    await expect(cold.appendPreparedSessionTail(sessionId, {
      baseline,
      title: 'Prepared archived identity',
      activeEntryId: duplicateArchived.id,
      lineageEntries: [duplicateArchived],
    })).rejects.toMatchObject({ code: 'data_changed' });

    const validEntry: KodaXSessionEntry = {
      ...duplicateArchived,
      id: 'archived-identity-valid-tail',
      logicalId: 'archived-identity-valid-tail',
      message: { role: 'user', content: 'valid archived tail' },
    };
    await cold.appendPreparedSessionTail(sessionId, {
      baseline,
      title: 'Prepared archived identity',
      activeEntryId: validEntry.id,
      lineageEntries: [validEntry],
    });
    const page = await cold.readConversationPageCache(sessionId, {
      limit: 2,
      maxPageBytes: 64 * 1024,
      maxInlineEntryBytes: 64 * 1024,
      reservedBytes: 0,
    });
    const direct = await cold.readFullSnapshot(sessionId);
    expect(page?.sourceRevision).toBe(direct?.sourceRevision);
    expect(page?.entries.at(-1)?.entry?.message.content).toBe('valid archived tail');
  });

  it('rejects a prepared tail after a sidecar-only bundle change', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = testSessionsDir();
    const gitRoot = tempHome.replace(/\\/g, '/');
    const sessionId = 'session-prepared-sidecar-boundary';
    const messages = [{ role: 'user' as const, content: 'sidecar boundary base' }];
    const storage = new FileSessionStorage({ sessionsDir });
    await storage.save(sessionId, {
      messages,
      title: 'Prepared sidecar boundary',
      gitRoot,
      lineage: createSessionLineage(messages),
    });
    await storage.load(sessionId);
    const baseline = await storage.prepareSessionAppend(sessionId);
    if (baseline === null) throw new Error('expected prepared sidecar boundary');
    const projectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(gitRoot).key);
    const sidecarEntry: KodaXSessionEntry = {
      type: 'message',
      id: 'sidecar-only-change',
      parentId: null,
      logicalId: 'sidecar-only-change',
      timestamp: '2026-08-02T00:00:01.000Z',
      message: { role: 'user', content: 'sidecar changed independently' },
    };
    await writeFile(
      path.join(projectDir, `${sessionId}.islands.jsonl`),
      `${JSON.stringify({
        _type: 'archived_entry',
        archiveBatchId: 'sidecar-only-batch',
        entry: sidecarEntry,
      })}\n`,
      'utf8',
    );
    const tail: KodaXSessionEntry = {
      type: 'message',
      id: 'tail-after-sidecar-change',
      parentId: baseline.activeEntryId,
      logicalId: 'tail-after-sidecar-change',
      timestamp: '2026-08-02T00:00:02.000Z',
      message: { role: 'assistant', content: 'must not commit' },
    };
    await expect(storage.appendPreparedSessionTail(sessionId, {
      baseline,
      title: 'Prepared sidecar boundary',
      activeEntryId: tail.id,
      lineageEntries: [tail],
    })).rejects.toMatchObject({ code: 'data_changed' });
    expect(await readFile(path.join(projectDir, `${sessionId}.jsonl`), 'utf8'))
      .not.toContain('must not commit');
  });

  it('does not authorize a prepared append from a tampered recoverable identity filter', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = testSessionsDir();
    const gitRoot = tempHome.replace(/\\/g, '/');
    const sessionId = 'session-prepared-tampered-filter';
    const messages = [{ role: 'user' as const, content: 'tampered filter base' }];
    const storage = new FileSessionStorage({ sessionsDir });
    await storage.save(sessionId, {
      messages,
      title: 'Prepared tampered filter',
      gitRoot,
      lineage: createSessionLineage(messages),
    });
    const projectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(gitRoot).key);
    const manifestPath = path.join(projectDir, `${sessionId}.conversation-cache.json`);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.identityFilter = Buffer.alloc(128 * 1024).toString('base64');
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    const cold = new FileSessionStorage({ sessionsDir });
    await cold.load(sessionId);
    await expect(cold.prepareSessionAppend(sessionId)).resolves.toBeNull();
  });

  it('does not trust a forged cache prepared through the public SDK API', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { buildSessionConversationHistory } = await import('../session/conversation-history.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'session-prepared-forged-public-cache';
    const messages = [
      { role: 'user' as const, content: 'canonical root' },
      { role: 'assistant' as const, content: 'canonical leaf' },
    ];
    const canonicalLineage = createSessionLineage(messages);
    const storage = new FileSessionStorage({ sessionsDir });
    await storage.save(sessionId, {
      messages,
      title: 'Prepared forged public cache',
      gitRoot: KODAX_REPO_ROOT,
      lineage: canonicalLineage,
    });
    const capture = await storage.readFullSnapshot(sessionId);
    if (capture === null) throw new Error('expected canonical capture');
    const canonicalLeaf = canonicalLineage.entries.at(-1)!;
    const forgedLineage: KodaXSessionLineage = {
      entries: [{ ...canonicalLeaf, parentId: null }],
      activeEntryId: canonicalLeaf.id,
    };
    await storage.prepareConversationPageCache(
      sessionId,
      buildSessionConversationHistory(forgedLineage, capture.sourceRevision),
      forgedLineage,
      capture.data.runtimeInfo,
      capture.boundaryRevision,
      capture.sourceRevisionState,
    );

    const cold = new FileSessionStorage({ sessionsDir });
    await cold.load(sessionId);
    await expect(cold.prepareSessionAppend(sessionId)).resolves.toBeNull();
  });

  it('derives prepared activeMessageCount from canonical lineage, not stale meta hints', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { buildSessionConversationHistory } = await import('../session/conversation-history.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = testSessionsDir();
    const gitRoot = tempHome.replace(/\\/g, '/');
    const sessionId = 'session-prepared-active-count';
    const messages = [{ role: 'user' as const, content: 'active count base' }];
    const storage = new FileSessionStorage({ sessionsDir });
    await storage.save(sessionId, {
      messages,
      title: 'Prepared active count',
      gitRoot,
      lineage: createSessionLineage(messages),
    });
    const projectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(gitRoot).key);
    const mainPath = path.join(projectDir, `${sessionId}.jsonl`);
    await fsPromises.appendFile(
      mainPath,
      `${JSON.stringify({ _type: 'meta_update', activeMessageCount: -99 })}\n`,
      'utf8',
    );
    const capture = await storage.readFullSnapshot(sessionId);
    if (capture === null || capture.lineage === null) throw new Error('expected active-count capture');
    await storage.prepareConversationPageCache(
      sessionId,
      buildSessionConversationHistory(capture.lineage, capture.sourceRevision),
      capture.lineage,
      capture.data.runtimeInfo,
      capture.boundaryRevision,
      capture.sourceRevisionState,
    );

    const cold = new FileSessionStorage({ sessionsDir });
    await cold.load(sessionId);
    const baseline = await cold.prepareSessionAppend(sessionId);
    if (baseline === null) throw new Error('expected active-count prepared boundary');
    const tail: KodaXSessionEntry = {
      type: 'message',
      id: 'active-count-tail',
      parentId: baseline.activeEntryId,
      logicalId: 'active-count-tail',
      timestamp: '2026-08-02T00:00:01.000Z',
      message: { role: 'assistant', content: 'active count tail' },
    };
    await cold.appendPreparedSessionTail(sessionId, {
      baseline,
      title: 'Prepared active count',
      activeEntryId: tail.id,
      lineageEntries: [tail],
    });
    const metaUpdates = (await readFile(mainPath, 'utf8')).trimEnd().split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line._type === 'meta_update');
    expect(metaUpdates.at(-1)?.activeMessageCount).toBe(2);
  });

  it('lists presentation-only failure history appended through a prepared tail', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'session-prepared-presentation-only';
    const storage = new FileSessionStorage({ sessionsDir });
    await storage.save(sessionId, {
      messages: [],
      title: 'Prepared failure history',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage([]),
    });
    await storage.load(sessionId);
    const baseline = await storage.prepareSessionAppend(sessionId);
    if (baseline === null) throw new Error('expected presentation-only prepared boundary');
    await storage.appendPreparedSessionTail(sessionId, {
      baseline,
      title: 'Prepared failure history',
      activeEntryId: null,
      lineageEntries: [],
      uiHistory: [
        { type: 'assistant', text: 'summary', presentationOnly: true },
        { type: 'sidecar', text: 'verifier', presentationOnly: true },
        { type: 'error', text: 'terminal failure', presentationOnly: true },
      ],
    });

    const cold = new FileSessionStorage({ sessionsDir });
    await expect(cold.list(KODAX_REPO_ROOT, { limit: 1000 })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: sessionId, msgCount: 3 }),
      ]),
    );
  });

  it('snapshots a mutable public tail before awaiting validation', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'session-prepared-tail-snapshot';
    const messages = [{ role: 'user' as const, content: 'snapshot base' }];
    const lineage = createSessionLineage(messages);
    const storage = new FileSessionStorage({ sessionsDir });
    await storage.save(sessionId, {
      messages,
      title: 'Prepared tail snapshot',
      gitRoot: KODAX_REPO_ROOT,
      lineage,
    });
    await storage.load(sessionId);
    const baseline = await storage.prepareSessionAppend(sessionId);
    if (baseline === null) throw new Error('expected prepared snapshot boundary');
    const entry: KodaXSessionEntry = {
      type: 'message',
      id: 'snapshot-safe-tail',
      parentId: baseline.activeEntryId,
      logicalId: 'snapshot-safe-tail',
      timestamp: '2026-08-02T00:00:01.000Z',
      message: { role: 'assistant', content: 'validated snapshot value' },
    };
    const pending = storage.appendPreparedSessionTail(sessionId, {
      baseline,
      title: 'Prepared tail snapshot',
      activeEntryId: entry.id,
      lineageEntries: [entry],
    });
    entry.id = lineage.entries[0]!.id;
    entry.parentId = null;
    entry.message.content = 'mutated after call';
    await pending;
    const loaded = await storage.load(sessionId);
    expect(loaded?.lineage?.entries.at(-1)?.id).toBe('snapshot-safe-tail');
    expect(loaded?.messages.at(-1)?.content).toBe('validated snapshot value');
  });

  it('keeps the 50th prepared append bounded and returns a usable successor', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'session-prepared-maintenance-successor';
    const messages = [{ role: 'user' as const, content: 'maintenance base' }];
    const storage = new FileSessionStorage({ sessionsDir });
    await storage.save(sessionId, {
      messages,
      title: 'Prepared maintenance successor',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(messages),
    });
    await storage.load(sessionId);
    let baseline = await storage.prepareSessionAppend(sessionId);
    if (baseline === null) throw new Error('expected prepared maintenance boundary');
    const mainPath = path.join(
      sessionsDir,
      deriveProjectKeyFromRoot(KODAX_REPO_ROOT).key,
      `${sessionId}.jsonl`,
    );
    const readFileSpy = vi.spyOn(fsPromises, 'readFile');
    for (let index = 0; index < 50; index += 1) {
      baseline = await storage.appendPreparedSessionTail(sessionId, {
        baseline,
        title: `Prepared maintenance successor ${index}`,
        activeEntryId: baseline.activeEntryId,
        lineageEntries: [],
      });
      if (baseline === null) throw new Error(`missing successor after append ${index}`);
    }
    const chained = await storage.appendPreparedSessionTail(sessionId, {
      baseline,
      title: 'Prepared maintenance successor chained',
      activeEntryId: baseline.activeEntryId,
      lineageEntries: [],
    });
    expect(chained).not.toBeNull();
    expect(readFileSpy.mock.calls.filter(
      ([candidate]) => path.resolve(String(candidate)) === path.resolve(mainPath),
    )).toHaveLength(0);
    readFileSpy.mockRestore();
  });

  it('resolves a committed append with null when post-commit witness refresh fails', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'session-prepared-committed-resync';
    const messages = [{ role: 'user' as const, content: 'committed resync base' }];
    const storage = new FileSessionStorage({ sessionsDir });
    await storage.save(sessionId, {
      messages,
      title: 'Prepared committed resync',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(messages),
    });
    await storage.load(sessionId);
    const baseline = await storage.prepareSessionAppend(sessionId);
    if (baseline === null) throw new Error('expected committed-resync boundary');
    const tail: KodaXSessionEntry = {
      type: 'message',
      id: 'committed-resync-tail',
      parentId: baseline.activeEntryId,
      logicalId: 'committed-resync-tail',
      timestamp: '2026-08-02T00:00:01.000Z',
      message: { role: 'assistant', content: 'committed exactly once' },
    };
    const originalAppendFile = fsPromises.appendFile.bind(fsPromises);
    const originalStat = fsPromises.stat.bind(fsPromises);
    let appended = false;
    const appendFile = vi.spyOn(fsPromises, 'appendFile').mockImplementation(async (...args) => {
      await originalAppendFile(...args);
      appended = true;
    });
    const stat = vi.spyOn(fsPromises, 'stat').mockImplementation(async (...args) => {
      if (appended && String(args[0]).endsWith(`${sessionId}.jsonl`)) {
        throw Object.assign(new Error('post-commit witness unavailable'), { code: 'EIO' });
      }
      return originalStat(...args);
    });
    try {
      await expect(storage.appendPreparedSessionTail(sessionId, {
        baseline,
        title: 'Prepared committed resync',
        activeEntryId: tail.id,
        lineageEntries: [tail],
      })).resolves.toBeNull();
    } finally {
      stat.mockRestore();
      appendFile.mockRestore();
    }
    const loaded = await new FileSessionStorage({ sessionsDir }).load(sessionId);
    expect(loaded?.messages.filter((message) => message.content === 'committed exactly once'))
      .toHaveLength(1);
  });

  it('extends a prepared Conversation cache without reading the persisted history bundle', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const { buildSessionConversationHistory } = await import('../session/conversation-history.js');
    const sessionsDir = testSessionsDir();
    const storage = new FileSessionStorage({ sessionsDir });
    const gitRoot = tempHome.replace(/\\/g, '/');
    const sessionId = 'session-prepared-bounded-append';
    const messages = Array.from({ length: 128 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `prepared history ${index}`,
    }));
    const lineage = createSessionLineage(messages);
    await storage.save(sessionId, {
      messages,
      title: 'Prepared bounded append',
      gitRoot,
      lineage,
    });
    const loaded = await storage.load(sessionId);
    if (loaded?.lineage === undefined) throw new Error('expected loaded Session lineage');
    const capture = await storage.readFullSnapshot(sessionId);
    if (capture?.lineage === null || capture === null) throw new Error('expected Session capture');
    await storage.prepareConversationPageCache(
      sessionId,
      buildSessionConversationHistory(capture.lineage, capture.sourceRevision),
      capture.lineage,
      capture.data.runtimeInfo,
      capture.boundaryRevision,
      capture.sourceRevisionState,
    );
    const previousPage = await storage.readConversationPageCache(sessionId, {
      limit: 4,
      maxPageBytes: 64 * 1024,
      maxInlineEntryBytes: 64 * 1024,
      reservedBytes: 0,
    });
    if (previousPage === null) throw new Error('expected prepared Conversation page');
    const nextMessages = [
      ...messages,
      { role: 'user' as const, content: 'bounded append tail' },
    ];
    const nextLineage = createSessionLineage(nextMessages, loaded.lineage);
    const projectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(gitRoot).key);
    const bundleNames = new Set([
      `${sessionId}.jsonl`,
      `${sessionId}.islands.jsonl`,
      `${sessionId}.archive.jsonl`,
    ]);
    const open = vi.spyOn(fsPromises, 'open');
    const baseline = await storage.prepareSessionAppend(sessionId);
    if (baseline === null) throw new Error('expected prepared append boundary');

    await storage.appendPreparedSessionTail(sessionId, {
      baseline,
      title: loaded.title,
      activeEntryId: nextLineage.activeEntryId,
      lineageEntries: nextLineage.entries.slice(baseline.lineageCount),
    });

    const historyReads = open.mock.calls.filter(([candidate, flags]) =>
      flags === 'r'
      && path.dirname(path.resolve(String(candidate))) === path.resolve(projectDir)
      && bundleNames.has(path.basename(String(candidate))));
    open.mockRestore();
    expect(historyReads).toHaveLength(0);

    const nextPage = await storage.readConversationPageCache(sessionId, {
      limit: 4,
      maxPageBytes: 64 * 1024,
      maxInlineEntryBytes: 64 * 1024,
      reservedBytes: 0,
    });
    const direct = await storage.readFullSnapshot(sessionId);
    expect(nextPage?.sourceRevision).toBe(direct?.sourceRevision);
    expect(nextPage?.entries.at(-1)?.entry?.message.content).toBe('bounded append tail');
    await expect(storage.readConversationPageCache(sessionId, {
      expectedRevision: previousPage.revision,
      limit: 4,
      maxPageBytes: 64 * 1024,
      maxInlineEntryBytes: 64 * 1024,
      reservedBytes: 0,
    })).rejects.toMatchObject({ code: 'data_changed' });
  });

  it('keeps the complete prepared append path off the lineage and artifact history prefixes', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { buildSessionConversationHistory } = await import('../session/conversation-history.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const sessionsDir = testSessionsDir();
    const storage = new FileSessionStorage({ sessionsDir });
    const gitRoot = tempHome.replace(/\\/g, '/');
    const sessionId = 'session-prepared-bounded-compute';
    const messages = Array.from({ length: 640 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `bounded compute history ${index}`,
    }));
    const initialLineage = createSessionLineage(messages);
    const artifacts: KodaXSessionArtifactLedgerEntry[] = Array.from(
      { length: 64 },
      (_, index) => ({
        id: `artifact-${index}`,
        kind: 'file_read',
        target: `history-${index}.ts`,
        timestamp: `2026-08-02T00:00:${String(index).padStart(2, '0')}.000Z`,
      }),
    );
    let rejectHistoryReads = false;
    const guardedPrefix = <T>(values: T[], prefixLength: number, label: string): T[] =>
      new Proxy(values, {
        get(target, property, receiver) {
          if (
            rejectHistoryReads
            && typeof property === 'string'
            && /^(?:0|[1-9]\d*)$/.test(property)
            && Number(property) < prefixLength
          ) {
            throw new Error(`${label} history prefix was traversed at ${property}`);
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
    await storage.save(sessionId, {
      messages,
      title: 'Prepared bounded compute',
      gitRoot,
      lineage: initialLineage,
      artifactLedger: artifacts,
    });
    const capture = await storage.readFullSnapshot(sessionId);
    if (capture === null || capture.lineage === null) throw new Error('expected Session capture');
    await storage.prepareConversationPageCache(
      sessionId,
      buildSessionConversationHistory(capture.lineage, capture.sourceRevision),
      capture.lineage,
      capture.data.runtimeInfo,
      capture.boundaryRevision,
      capture.sourceRevisionState,
    );
    const loaded = await storage.load(sessionId);
    if (loaded?.lineage === undefined || loaded.artifactLedger === undefined) {
      throw new Error('expected loaded append prefixes');
    }
    loaded.lineage.entries = guardedPrefix(
      loaded.lineage.entries,
      loaded.lineage.entries.length,
      'lineage',
    );
    loaded.artifactLedger = guardedPrefix(
      loaded.artifactLedger,
      loaded.artifactLedger.length,
      'artifact',
    );
    const baseline = await storage.prepareSessionAppend(sessionId);
    if (baseline === null) throw new Error('expected prepared append boundary');

    const tailEntry = {
      type: 'message' as const,
      id: 'bounded-compute-tail',
      parentId: baseline.activeEntryId,
      logicalId: 'bounded-compute-tail',
      timestamp: '2026-08-02T00:02:08.000Z',
      message: { role: 'user' as const, content: 'bounded compute tail' },
    };
    const tailArtifact: KodaXSessionArtifactLedgerEntry = {
      id: 'artifact-tail',
      kind: 'file_modified',
      target: 'tail.ts',
      timestamp: '2026-08-02T00:02:09.000Z',
    };
    rejectHistoryReads = true;
    try {
      await storage.appendPreparedSessionTail(sessionId, {
        baseline,
        title: 'Prepared bounded compute',
        activeEntryId: tailEntry.id,
        lineageEntries: [tailEntry],
        artifactEntries: [tailArtifact],
      });
    } finally {
      rejectHistoryReads = false;
    }

    const mainPath = path.join(
      sessionsDir,
      deriveProjectKeyFromRoot(gitRoot).key,
      `${sessionId}.jsonl`,
    );
    const metaUpdates = (await readFile(mainPath, 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line._type === 'meta_update');
    expect(metaUpdates.at(-1)?.activeMessageCount).toBe(messages.length + 1);
    const page = await storage.readConversationPageCache(sessionId, {
      limit: 2,
      maxPageBytes: 64 * 1024,
      maxInlineEntryBytes: 64 * 1024,
      reservedBytes: 0,
    });
    expect(page?.entries.at(-1)?.entry?.message.content).toBe('bounded compute tail');
  });

  it('rejects a stale prepared tail boundary and makes reload-and-retry explicit', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'session-prepared-stale-boundary';
    const first = new FileSessionStorage({ sessionsDir });
    const baseMessages = [{ role: 'user' as const, content: 'prepared base' }];
    await first.save(sessionId, {
      messages: baseMessages,
      title: 'Prepared stale boundary',
      gitRoot: KODAX_REPO_ROOT,
      lineage: createSessionLineage(baseMessages),
    });
    const loaded = await first.load(sessionId);
    const staleBaseline = await first.prepareSessionAppend(sessionId);
    if (loaded?.lineage === undefined || staleBaseline === null) {
      throw new Error('expected prepared Session state');
    }

    const second = new FileSessionStorage({ sessionsDir });
    const concurrent = await second.load(sessionId);
    if (concurrent?.lineage === undefined) throw new Error('expected concurrent Session state');
    const concurrentLineage = createSessionLineage([
      ...concurrent.messages,
      { role: 'assistant' as const, content: 'concurrent tail' },
    ], concurrent.lineage);
    await second.appendSessionDelta(sessionId, {
      ...concurrent,
      messages: getSessionMessagesFromLineage(concurrentLineage),
      lineage: concurrentLineage,
    });

    const staleTail: KodaXSessionEntry = {
      type: 'message',
      id: 'prepared-stale-tail',
      parentId: staleBaseline.activeEntryId,
      logicalId: 'prepared-stale-tail',
      timestamp: '2026-08-02T00:03:00.000Z',
      message: { role: 'assistant', content: 'must be rebuilt' },
    };
    await expect(first.appendPreparedSessionTail(sessionId, {
      baseline: staleBaseline,
      title: loaded.title,
      activeEntryId: staleTail.id,
      lineageEntries: [staleTail],
    })).rejects.toMatchObject({ code: 'data_changed' });

    const refreshed = await first.load(sessionId);
    expect(refreshed?.messages.at(-1)).toMatchObject({ content: 'concurrent tail' });
    expect((await first.prepareSessionAppend(sessionId))?.revision).not.toBe(staleBaseline.revision);
  });

  it('appendSessionDelta makes a newly provided tag visible to list by rewriting the initial meta line', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');

    const lineage1 = createSessionLineage([
      { role: 'user', content: 'hello' },
    ]);
    await storage.save('session-tag-late', {
      messages: [{ role: 'user', content: 'hello' }],
      title: 'Late Tag Session',
      gitRoot,
      scope: 'user',
      lineage: lineage1,
    });

    const loaded1 = await storage.load('session-tag-late');
    const lineage2 = createSessionLineage([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'reply' },
    ], loaded1!.lineage);
    await storage.appendSessionDelta('session-tag-late', {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'reply' },
      ],
      title: 'Late Tag Session Updated',
      gitRoot,
      lineage: lineage2,
      tag: 'partner',
    });

    const sessionPath = path.join(
      tempHome,
      '.kodax',
      'sessions',
      deriveProjectKeyFromRoot(gitRoot).key,
      'session-tag-late.jsonl',
    );
    const firstLine = (await readFile(sessionPath, 'utf-8')).split('\n')[0]!;
    const listed = await storage.list(gitRoot, { limit: 10 });

    expect(JSON.parse(firstLine).tag).toBe('partner');
    expect(listed.find((session) => session.id === 'session-tag-late')?.tag).toBe('partner');
  });

  it('mixed path: append → rewind (cold save) → append → load consistent', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = tempHome.replace(/\\/g, '/');

    // Seed
    await storage.save('session-mixed', {
      messages: [
        { role: 'user', content: 'step 1' },
        { role: 'assistant', content: 'reply 1' },
      ],
      title: 'Mixed Path',
      gitRoot,
    });
    const loaded1 = await storage.load('session-mixed');

    // Append
    const lineage2 = createSessionLineage([
      { role: 'user', content: 'step 1' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'user', content: 'step 2' },
      { role: 'assistant', content: 'reply 2' },
    ], loaded1!.lineage);
    await storage.appendSessionDelta('session-mixed', {
      messages: [
        { role: 'user', content: 'step 1' },
        { role: 'assistant', content: 'reply 1' },
        { role: 'user', content: 'step 2' },
        { role: 'assistant', content: 'reply 2' },
      ],
      title: 'Mixed Path',
      gitRoot,
      lineage: lineage2,
    });

    // Rewind (cold path — triggers full save via writeSessionInternal)
    // rewind goes back one user entry: from step2 back to step1 (the previous user entry)
    const rewound = await storage.rewind?.('session-mixed');
    expect(rewound).toBeTruthy();
    expect(rewound!.messages[0]).toEqual({ role: 'user', content: 'step 1' });

    // Append again after rewind
    const loaded3 = await storage.load('session-mixed');
    const lineage4 = createSessionLineage([
      ...loaded3!.messages,
      { role: 'user', content: 'step 3' },
      { role: 'assistant', content: 'reply 3' },
    ], loaded3!.lineage);
    await storage.appendSessionDelta('session-mixed', {
      messages: [
        ...loaded3!.messages,
        { role: 'user', content: 'step 3' },
        { role: 'assistant', content: 'reply 3' },
      ],
      title: 'Mixed Path Final',
      gitRoot,
      lineage: lineage4,
    });

    // Final load — everything consistent
    const final = await storage.load('session-mixed');
    expect(final?.title).toBe('Mixed Path Final');
    expect(final?.messages[final.messages.length - 1]).toEqual({ role: 'assistant', content: 'reply 3' });
  });

  // ── FEATURE_219: per-project layout + id-only locator ──

  it('FEATURE_219: writes sessions under a per-project directory (not flat) + project.json', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');

    await storage.save('20260601_120000', {
      messages: [{ role: 'user', content: 'hi' }],
      title: 'In Project Dir',
      gitRoot,
      scope: 'user',
    });

    const projectDir = path.join(
      tempHome, '.kodax', 'sessions', deriveProjectKeyFromRoot(gitRoot).key,
    );
    expect(existsSync(path.join(projectDir, '20260601_120000.jsonl'))).toBe(true);
    expect(existsSync(path.join(projectDir, 'project.json'))).toBe(true);
    // The legacy flat path must NOT be used.
    expect(existsSync(path.join(tempHome, '.kodax', 'sessions', '20260601_120000.jsonl'))).toBe(false);
  });

  it('FEATURE_219: id-only locator resolves a project-dir session from a cold storage instance', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');

    await new FileSessionStorage({ sessionsDir: testSessionsDir() }).save('20260601_130000', {
      messages: [{ role: 'user', content: 'persisted' }],
      title: 'Cold Load',
      gitRoot,
      scope: 'user',
    });

    // Fresh instance → empty sessionDirCache → must locate by bounded scan.
    const cold = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const loaded = await cold.load('20260601_130000');
    expect(loaded?.title).toBe('Cold Load');
    expect(loaded?.messages[0]).toEqual({ role: 'user', content: 'persisted' });
  });

  it('checks an exact id without reading the Session transcript', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionId = 'exact-id-probe';
    const sessionsDir = testSessionsDir();
    await new FileSessionStorage({ sessionsDir }).save(sessionId, {
      messages: [{ role: 'user', content: 'persisted' }],
      title: 'Exact id probe',
      gitRoot: path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/'),
    });
    const readFile = vi.spyOn(fsPromises, 'readFile');
    try {
      const cold = new FileSessionStorage({ sessionsDir });
      await expect(cold.has(sessionId)).resolves.toBe(true);
      await expect(cold.has('missing-exact-id')).resolves.toBe(false);
      expect(readFile.mock.calls.some(([candidate]) =>
        String(candidate).endsWith(`${sessionId}.jsonl`))).toBe(false);
    } finally {
      readFile.mockRestore();
    }
  });

  it('does not synchronously stat every project candidate during a cold id lookup', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = testSessionsDir();
    const sessionId = 'cold-candidate-lookup';
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const projectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(gitRoot).key);
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        _type: 'meta',
        id: sessionId,
        title: 'Cold candidate lookup',
        gitRoot,
        scope: 'user',
        activeMessageCount: 1,
      }),
      JSON.stringify({ role: 'user', content: 'persisted' }),
    ].join('\n'), 'utf8');
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      mkdir(path.join(sessionsDir, `unrelated-${index}`), { recursive: true })));
    const stat = vi.spyOn(fsSync, 'statSync');
    try {
      await expect(new FileSessionStorage({ sessionsDir }).load(sessionId))
        .resolves.toMatchObject({ title: 'Cold candidate lookup' });
      const synchronousCandidateStats = stat.mock.calls.filter(([candidate]) => (
        path.basename(String(candidate)) === `${sessionId}.jsonl`
      ));
      expect(synchronousCandidateStats).toEqual([]);
    } finally {
      stat.mockRestore();
    }
  });

  it('FEATURE_219: load(id) still reads a legacy flat-pool session (compat)', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const sessionsDir = path.join(tempHome, '.kodax', 'sessions');
    const { mkdir } = await import('fs/promises');
    await mkdir(sessionsDir, { recursive: true });
    const meta = JSON.stringify({
      _type: 'meta',
      id: '20260101_999999',
      title: 'Legacy Flat',
      gitRoot: '/legacy/repo',
      createdAt: '2026-01-01T00:00:00.000Z',
      activeMessageCount: 1,
    });
    const msg = JSON.stringify({ role: 'user', content: 'old flat session' });
    await writeFile(path.join(sessionsDir, '20260101_999999.jsonl'), `${meta}\n${msg}\n`, 'utf8');

    const loaded = await new FileSessionStorage({ sessionsDir: testSessionsDir() }).load('20260101_999999');
    expect(loaded?.title).toBe('Legacy Flat');
  });

  it('FEATURE_219: saving a legacy flat session migrates it into the project dir + removes the flat copy', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const sessionsDir = path.join(tempHome, '.kodax', 'sessions');
    const { mkdir } = await import('fs/promises');
    await mkdir(sessionsDir, { recursive: true });
    const flatPath = path.join(sessionsDir, '20260101_888888.jsonl');
    const meta = JSON.stringify({
      _type: 'meta', id: '20260101_888888', title: 'Pre-migration', gitRoot, activeMessageCount: 1,
    });
    await writeFile(flatPath, `${meta}\n${JSON.stringify({ role: 'user', content: 'x' })}\n`, 'utf8');

    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const loaded = await storage.load('20260101_888888');
    await storage.save('20260101_888888', { ...loaded!, title: 'Migrated', gitRoot });

    const projectPath = path.join(
      sessionsDir, deriveProjectKeyFromRoot(gitRoot).key, '20260101_888888.jsonl',
    );
    expect(existsSync(projectPath)).toBe(true);
    expect(existsSync(flatPath)).toBe(false); // flat copy superseded
    expect((await storage.load('20260101_888888'))?.title).toBe('Migrated');
  });

  it('FEATURE_219: first list() auto-migrates the flat pool into per-project dirs + stamps marker', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const sessionsDir = path.join(tempHome, '.kodax', 'sessions');
    const { mkdir } = await import('fs/promises');
    await mkdir(sessionsDir, { recursive: true });
    // Seed two legacy flat sessions directly.
    for (const id of ['20260701_000000', '20260701_000001']) {
      const meta = JSON.stringify({ _type: 'meta', id, title: id, gitRoot, activeMessageCount: 1 });
      await writeFile(path.join(sessionsDir, `${id}.jsonl`), `${meta}\n${JSON.stringify({ role: 'user', content: 'x' })}\n`, 'utf8');
    }

    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const listed = await storage.list(gitRoot); // first entry point → triggers migration

    const projectDir = path.join(sessionsDir, deriveProjectKeyFromRoot(gitRoot).key);
    expect(existsSync(path.join(sessionsDir, '.layout.json'))).toBe(true);
    expect(existsSync(path.join(projectDir, '20260701_000000.jsonl'))).toBe(true);
    expect(existsSync(path.join(sessionsDir, '20260701_000000.jsonl'))).toBe(false); // moved out of flat
    expect(listed.map((s) => s.id).sort()).toEqual(['20260701_000000', '20260701_000001']);
  });

  it('retries legacy cache cleanup after a failed migration on the same storage instance', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const sessionsDir = testSessionsDir();
    const sessionId = 'legacy-cache-migration-retry';
    await mkdir(sessionsDir, { recursive: true });
    const flatPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    const cachePath = path.join(sessionsDir, `${sessionId}.conversation-cache.generation.data`);
    await writeFile(flatPath, [
      JSON.stringify({
        _type: 'meta',
        id: sessionId,
        title: 'Legacy cache migration retry',
        gitRoot,
        activeMessageCount: 1,
      }),
      JSON.stringify({ role: 'user', content: 'legacy body' }),
    ].join('\n'), 'utf8');
    await writeFile(cachePath, 'recoverable cached body', 'utf8');
    const storage = new FileSessionStorage({ sessionsDir });
    const originalRm = fsPromises.rm.bind(fsPromises);
    let denied = false;
    const remove = vi.spyOn(fsPromises, 'rm').mockImplementation(async (candidate, options) => {
      if (!denied && path.resolve(String(candidate)) === path.resolve(cachePath)) {
        denied = true;
        throw Object.assign(new Error('migration cache cleanup denied'), { code: 'EACCES' });
      }
      return originalRm(candidate, options);
    });

    try {
      await expect(storage.list(gitRoot)).rejects.toMatchObject({
        name: 'ConversationPageCacheCleanupError',
      });
    } finally {
      remove.mockRestore();
    }

    expect(existsSync(flatPath)).toBe(true);
    await expect(storage.list(gitRoot)).resolves.toEqual([
      expect.objectContaining({ id: sessionId }),
    ]);
    expect(existsSync(flatPath)).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
    expect(existsSync(path.join(
      sessionsDir,
      deriveProjectKeyFromRoot(gitRoot).key,
      `${sessionId}.jsonl`,
    ))).toBe(true);
  });

  it('FEATURE_219: archive() hides a session from the default list; includeArchived + unarchive restore it', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');

    await storage.save('20260801_000000', {
      messages: [
        { role: 'user', content: 'to archive' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_archived', name: 'test', input: {} },
          ],
        },
      ],
      title: 'Archive Me',
      gitRoot,
      scope: 'user',
      errorMetadata: {
        lastError: 'interrupted',
        lastErrorTime: 1,
        consecutiveErrors: 1,
      },
    });

    expect(await storage.archive('20260801_000000')).toBe(true);

    const projectDir = path.join(
      tempHome, '.kodax', 'sessions', deriveProjectKeyFromRoot(gitRoot).key,
    );
    expect(existsSync(path.join(projectDir, 'archived', '20260801_000000.jsonl'))).toBe(true);
    expect(existsSync(path.join(projectDir, '20260801_000000.jsonl'))).toBe(false);

    // Hidden from default list, visible with includeArchived, still loadable by id.
    expect((await storage.list(gitRoot)).map((s) => s.id)).not.toContain('20260801_000000');
    const withArchived = await storage.list(gitRoot, { includeArchived: true });
    const archivedEntry = withArchived.find((s) => s.id === '20260801_000000');
    expect(archivedEntry?.archived).toBe(true);
    const recoveredArchived = await storage.load('20260801_000000');
    expect(recoveredArchived).toMatchObject({
      title: 'Archive Me',
      messages: [{ role: 'user', content: 'to archive' }],
      errorMetadata: { consecutiveErrors: 0 },
    });
    if (!recoveredArchived) throw new Error('Expected archived recovery data.');
    await storage.save('20260801_000000', {
      ...recoveredArchived,
      title: 'Archive Me In Place',
    });
    expect(existsSync(path.join(projectDir, 'archived', '20260801_000000.jsonl'))).toBe(true);
    expect(existsSync(path.join(projectDir, '20260801_000000.jsonl'))).toBe(false);
    const detachedActiveCache = path.join(
      projectDir,
      '20260801_000000.conversation-cache.legacy.data',
    );
    await writeFile(detachedActiveCache, 'detached active cache body', 'utf8');
    await expect(storage.archive('20260801_000000')).resolves.toBe(true);
    expect(existsSync(detachedActiveCache)).toBe(false);
    expect((await storage.load('20260801_000000'))?.title).toBe('Archive Me In Place');

    // Unarchive restores it to the default list.
    expect(await storage.unarchive('20260801_000000')).toBe(true);
    expect(existsSync(path.join(projectDir, '20260801_000000.jsonl'))).toBe(true);
    expect((await storage.list(gitRoot)).map((s) => s.id)).toContain('20260801_000000');
    const detachedArchivedCache = path.join(
      projectDir,
      'archived',
      '20260801_000000.conversation-cache.legacy.data',
    );
    await writeFile(detachedArchivedCache, 'detached archived cache body', 'utf8');
    await expect(storage.unarchive('20260801_000000')).resolves.toBe(true);
    expect(existsSync(detachedArchivedCache)).toBe(false);
  });

  it.each(['archive', 'unarchive'] as const)(
    '%s fails before moving a Session when its recoverable Conversation cache cannot be removed',
    async (operation) => {
      const { FileSessionStorage } = await import('./storage.js');
      const { deriveProjectKeyFromRoot } = await import('./project-key.js');
      const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
      const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
      const sessionId = `${operation}-cache-cleanup-retry`;
      await storage.save(sessionId, {
        messages: [{ role: 'user', content: 'private cached body' }],
        title: 'Cache cleanup retry',
        gitRoot,
        lineage: createSessionLineage([{ role: 'user', content: 'private cached body' }]),
      });
      const projectDir = path.join(
        testSessionsDir(),
        deriveProjectKeyFromRoot(gitRoot).key,
      );
      const archivedDir = path.join(projectDir, 'archived');
      if (operation === 'unarchive') await storage.archive(sessionId);
      const sourceDir = operation === 'archive' ? projectDir : archivedDir;
      const destinationDir = operation === 'archive' ? archivedDir : projectDir;
      const sourceMain = path.join(sourceDir, `${sessionId}.jsonl`);
      const destinationMain = path.join(destinationDir, `${sessionId}.jsonl`);
      const cachePrefix = `${sessionId}.conversation-cache.`;
      expect((await fsPromises.readdir(sourceDir)).some((name) => name.startsWith(cachePrefix)))
        .toBe(true);
      const originalRm = fsPromises.rm.bind(fsPromises);
      let denied = false;
      const remove = vi.spyOn(fsPromises, 'rm').mockImplementation(async (candidate, options) => {
        if (!denied && path.basename(String(candidate)).startsWith(cachePrefix)) {
          denied = true;
          throw Object.assign(new Error('cache cleanup denied'), { code: 'EACCES' });
        }
        return originalRm(candidate, options);
      });

      try {
        await expect(storage[operation](sessionId)).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        remove.mockRestore();
      }

      expect(existsSync(sourceMain)).toBe(true);
      expect(existsSync(destinationMain)).toBe(false);
      await expect(storage[operation](sessionId)).resolves.toBe(true);
      expect(existsSync(sourceMain)).toBe(false);
      expect(existsSync(destinationMain)).toBe(true);
      expect((await fsPromises.readdir(sourceDir)).some((name) => name.startsWith(cachePrefix)))
        .toBe(false);
    },
  );

  it('delete keeps the Session recoverable when cache cleanup fails and succeeds on retry', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const sessionId = 'delete-cache-cleanup-retry';
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'delete cached body' }],
      title: 'Delete cache cleanup retry',
      gitRoot,
      lineage: createSessionLineage([{ role: 'user', content: 'delete cached body' }]),
    });
    const projectDir = path.join(testSessionsDir(), deriveProjectKeyFromRoot(gitRoot).key);
    const mainPath = path.join(projectDir, `${sessionId}.jsonl`);
    const cachePrefix = `${sessionId}.conversation-cache.`;
    const detachedDir = path.join(projectDir, 'archived');
    const detachedCache = path.join(detachedDir, `${cachePrefix}legacy.data`);
    await mkdir(detachedDir, { recursive: true });
    await writeFile(detachedCache, 'detached recoverable cached body', 'utf8');
    const originalRm = fsPromises.rm.bind(fsPromises);
    let denied = false;
    const remove = vi.spyOn(fsPromises, 'rm').mockImplementation(async (candidate, options) => {
      if (!denied && path.basename(String(candidate)).startsWith(cachePrefix)) {
        denied = true;
        throw Object.assign(new Error('cache cleanup denied'), { code: 'EACCES' });
      }
      return originalRm(candidate, options);
    });

    try {
      await expect(storage.delete(sessionId)).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      remove.mockRestore();
    }

    expect(existsSync(mainPath)).toBe(true);
    await expect(storage.delete(sessionId)).resolves.toBeUndefined();
    expect(existsSync(mainPath)).toBe(false);
    expect(existsSync(detachedCache)).toBe(false);
    expect((await fsPromises.readdir(projectDir)).some((name) => name.startsWith(cachePrefix)))
      .toBe(false);
  });

  it('retention reports cache cleanup failure without detaching cached content and retries', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const sessionId = 'retention-cache-cleanup-retry';
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'retention cached body' }],
      title: 'Retention cache cleanup retry',
      gitRoot,
      lineage: createSessionLineage([{ role: 'user', content: 'retention cached body' }]),
    });
    const projectDir = path.join(testSessionsDir(), deriveProjectKeyFromRoot(gitRoot).key);
    const mainPath = path.join(projectDir, `${sessionId}.jsonl`);
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await utimes(mainPath, old, old);
    const cachePrefix = `${sessionId}.conversation-cache.`;
    const originalRm = fsPromises.rm.bind(fsPromises);
    let denied = false;
    const remove = vi.spyOn(fsPromises, 'rm').mockImplementation(async (candidate, options) => {
      if (!denied && path.basename(String(candidate)).startsWith(cachePrefix)) {
        denied = true;
        throw Object.assign(new Error('cache cleanup denied'), { code: 'EACCES' });
      }
      return originalRm(candidate, options);
    });

    try {
      await expect(storage.cleanupOldSessions(30)).rejects.toBeInstanceOf(AggregateError);
    } finally {
      remove.mockRestore();
    }

    expect(existsSync(mainPath)).toBe(true);
    await expect(storage.cleanupOldSessions(30)).resolves.toBe(1);
    expect(existsSync(mainPath)).toBe(false);
    expect((await fsPromises.readdir(projectDir)).some((name) => name.startsWith(cachePrefix)))
      .toBe(false);
  });

  it('keeps raw lineage mutators on the exact archived Session path', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const sessionId = 'archived-lineage-mutators';
    const messages = [
      { role: 'user' as const, content: 'first question' },
      { role: 'assistant' as const, content: 'first answer' },
      { role: 'user' as const, content: 'second question' },
      { role: 'assistant' as const, content: 'second answer' },
    ];
    const lineage = createSessionLineage(messages);
    const messageEntries = lineage.entries.filter((entry) => entry.type === 'message');
    const firstId = messageEntries[0]?.id;
    const lastId = messageEntries.at(-1)?.id;
    if (!firstId || !lastId) throw new Error('expected lineage selectors');
    await storage.save(sessionId, {
      messages,
      title: 'Archived lineage mutators',
      gitRoot,
      lineage,
    });
    await storage.archive(sessionId);
    const projectDir = path.join(
      testSessionsDir(),
      deriveProjectKeyFromRoot(gitRoot).key,
    );
    const activePath = path.join(projectDir, `${sessionId}.jsonl`);
    const archivedPath = path.join(projectDir, 'archived', `${sessionId}.jsonl`);

    await expect(storage.setLabel(sessionId, lastId, 'archived-label'))
      .resolves.not.toBeNull();
    await expect(storage.setActiveEntry(sessionId, firstId)).resolves.not.toBeNull();
    await expect(storage.setActiveEntry(sessionId, lastId)).resolves.not.toBeNull();
    await expect(storage.rewind(sessionId, firstId)).resolves.not.toBeNull();

    expect(existsSync(activePath)).toBe(false);
    expect(existsSync(archivedPath)).toBe(true);
  });

  it('rolls the main Session file back when its sidecar cannot be archived', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const sessionId = 'archive-sidecar-rollback';
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'archive atomically' }],
      title: 'Archive Rollback',
      gitRoot,
      scope: 'user',
    });
    const projectDir = path.join(
      testSessionsDir(),
      deriveProjectKeyFromRoot(gitRoot).key,
    );
    const mainPath = path.join(projectDir, `${sessionId}.jsonl`);
    const sidecarPath = path.join(projectDir, `${sessionId}.islands.jsonl`);
    const archivedDir = path.join(projectDir, 'archived');
    await writeFile(sidecarPath, '{"_type":"archive_meta"}\n', 'utf-8');
    const renameOriginal = fsPromises.rename.bind(fsPromises);
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(
      async (from, to) => {
        if (
          path.resolve(String(from)) === path.resolve(sidecarPath)
          && path.dirname(path.resolve(String(to))) === path.resolve(archivedDir)
        ) {
          throw Object.assign(new Error('sidecar move denied'), { code: 'EACCES' });
        }
        await renameOriginal(from, to);
      },
    );

    try {
      await expect(storage.archive(sessionId)).rejects.toMatchObject({
        code: 'EACCES',
      });
    } finally {
      rename.mockRestore();
    }

    expect(existsSync(mainPath)).toBe(true);
    expect(existsSync(sidecarPath)).toBe(true);
    expect(existsSync(path.join(archivedDir, `${sessionId}.jsonl`))).toBe(false);
    expect(existsSync(path.join(archivedDir, `${sessionId}.islands.jsonl`))).toBe(false);
  });

  it.each([
    ['archive', 'islands'],
    ['archive', 'archive'],
    ['unarchive', 'islands'],
    ['unarchive', 'archive'],
  ] as const)('fails closed for an orphaned %s destination %s sidecar', async (
    operation,
    sidecarKind,
  ) => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const sessionId = `${operation}-${sidecarKind}-destination-collision`;
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'preserve both sides' }],
      title: 'Archive destination collision',
      gitRoot,
      lineage: createSessionLineage([{ role: 'user', content: 'preserve both sides' }]),
    });
    const projectDir = path.join(
      testSessionsDir(),
      deriveProjectKeyFromRoot(gitRoot).key,
    );
    const archivedDir = path.join(projectDir, 'archived');
    if (operation === 'unarchive') {
      expect(await storage.archive(sessionId)).toBe(true);
    }
    const sourceDir = operation === 'archive' ? projectDir : archivedDir;
    const destinationDir = operation === 'archive' ? archivedDir : projectDir;
    const destinationSidecar = path.join(
      destinationDir,
      `${sessionId}.${sidecarKind}.jsonl`,
    );
    const destinationBytes = 'orphaned destination history\n';
    await mkdir(destinationDir, { recursive: true });
    await writeFile(destinationSidecar, destinationBytes, 'utf8');
    const fileSet = [sourceDir, destinationDir].flatMap((dir) => [
      path.join(dir, `${sessionId}.jsonl`),
      path.join(dir, `${sessionId}.islands.jsonl`),
      path.join(dir, `${sessionId}.archive.jsonl`),
    ]);
    const snapshot = async (): Promise<Record<string, string | null>> =>
      Object.fromEntries(await Promise.all(fileSet.map(async (filePath) => [
        filePath,
        existsSync(filePath) ? await readFile(filePath, 'utf8') : null,
      ] as const)));
    const before = await snapshot();

    await expect(storage[operation](sessionId)).rejects.toThrow(
      'Refusing to overwrite existing Session archive file',
    );

    expect(await snapshot()).toEqual(before);
    expect(before[path.join(sourceDir, `${sessionId}.jsonl`)]).not.toBeNull();
    expect(before[path.join(sourceDir, `${sessionId}.${sidecarKind}.jsonl`)]).toBeNull();
    expect(before[destinationSidecar]).toBe(destinationBytes);
  });

  it('surfaces both the move and rollback errors when paired archive recovery fails', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const sessionId = 'archive-incomplete-rollback';
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'report incomplete rollback' }],
      title: 'Archive Incomplete Rollback',
      gitRoot,
      scope: 'user',
    });
    const projectDir = path.join(
      testSessionsDir(),
      deriveProjectKeyFromRoot(gitRoot).key,
    );
    const mainPath = path.join(projectDir, `${sessionId}.jsonl`);
    const sidecarPath = path.join(projectDir, `${sessionId}.islands.jsonl`);
    const archivedDir = path.join(projectDir, 'archived');
    const archivedMainPath = path.join(archivedDir, `${sessionId}.jsonl`);
    await writeFile(sidecarPath, '{"_type":"archive_meta"}\n', 'utf-8');
    const renameOriginal = fsPromises.rename.bind(fsPromises);
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(
      async (from, to) => {
        const resolvedFrom = path.resolve(String(from));
        const resolvedTo = path.resolve(String(to));
        if (
          resolvedFrom === path.resolve(sidecarPath)
          && path.dirname(resolvedTo) === path.resolve(archivedDir)
        ) {
          throw Object.assign(new Error('sidecar move denied'), { code: 'EACCES' });
        }
        if (
          resolvedFrom === path.resolve(archivedMainPath)
          && resolvedTo === path.resolve(mainPath)
        ) {
          throw Object.assign(new Error('main rollback denied'), { code: 'EPERM' });
        }
        await renameOriginal(from, to);
      },
    );

    let failure: unknown;
    try {
      await storage.archive(sessionId);
    } catch (error: unknown) {
      failure = error;
    } finally {
      rename.mockRestore();
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(existsSync(archivedMainPath)).toBe(true);
    expect(existsSync(sidecarPath)).toBe(true);
  });

  it('keeps the authoritative Session snapshot when strict deletion fails', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const { deriveProjectKeyFromRoot } = await import('./project-key.js');
    const storage = new FileSessionStorage({ sessionsDir: testSessionsDir() });
    const gitRoot = path.resolve(KODAX_REPO_ROOT).replace(/\\/g, '/');
    const sessionId = 'delete-failure-owner-retry';
    await storage.save(sessionId, {
      messages: [{ role: 'user', content: 'retain on failure' }],
      title: 'Delete Failure',
      gitRoot,
      scope: 'user',
    });
    const projectDir = path.join(
      testSessionsDir(),
      deriveProjectKeyFromRoot(gitRoot).key,
    );
    const mainPath = path.join(projectDir, `${sessionId}.jsonl`);
    const sidecarPath = path.join(projectDir, `${sessionId}.islands.jsonl`);
    await writeFile(sidecarPath, '{"_type":"archive_meta"}\n', 'utf-8');
    const renameOriginal = fsPromises.rename;
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(
      async (source, target) => {
        if (path.resolve(String(source)) === path.resolve(mainPath)) {
          throw Object.assign(new Error('delete denied'), { code: 'EACCES' });
        }
        return renameOriginal(source, target);
      },
    );

    try {
      await expect(storage.delete(sessionId)).rejects.toMatchObject({
        code: 'EACCES',
      });
    } finally {
      rename.mockRestore();
    }

    expect(existsSync(mainPath)).toBe(true);
    expect(existsSync(sidecarPath)).toBe(true);
    await expect(storage.load(sessionId)).resolves.toMatchObject({
      title: 'Delete Failure',
    });
  });
});
