import os from 'os';
import path from 'path';
import fsSync, { existsSync } from 'fs';
import fsPromises from 'fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureLayoutMigrated,
  isMigrated,
  needsMigration,
  planMigration,
  runMigration,
} from './session-migration.js';
import { deriveProjectKeyFromRoot } from './project-key.js';

describe('FEATURE_219 session-migration', () => {
  let root: string;
  let sessionsDir: string;
  const gitRoot = path.resolve('C:/Works/GitWorks/KodaX').replace(/\\/g, '/');
  const key = deriveProjectKeyFromRoot(gitRoot).key;

  const metaLine = (id: string): string =>
    JSON.stringify({ _type: 'meta', id, title: id, gitRoot, activeMessageCount: 1 });

  async function seedFlat(id: string): Promise<string> {
    const p = path.join(sessionsDir, `${id}.jsonl`);
    await writeFile(p, `${metaLine(id)}\n${JSON.stringify({ role: 'user', content: 'x' })}\n`, 'utf8');
    return p;
  }

  it('publishes a complete file owner before moving any session', async () => {
    const source = await seedFlat('atomic-publication');
    const lock = path.join(sessionsDir, '.migration-lock');
    const rename = fsPromises.rename;
    let observed = false;
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (from === source) {
        observed = true;
        const owner = JSON.parse(await readFile(lock, 'utf8')) as { pid: number; nonce: string };
        expect(owner.pid).toBe(process.pid);
        expect(owner.nonce).toBeTruthy();
      }
      return rename(from, to);
    });
    await runMigration(sessionsDir);
    expect(observed).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'kodax-mig-'));
    sessionsDir = path.join(root, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });

  it('plans flat sessions into per-project dirs, sidecars → islands, orphans → _unknown', async () => {
    await seedFlat('20260101_000000');
    await writeFile(path.join(sessionsDir, '20260101_000000.archive.jsonl'), 'island\n', 'utf8');
    await writeFile(path.join(sessionsDir, '20260102_000000.archive.jsonl'), 'orphan\n', 'utf8'); // no main

    const plans = await planMigration(sessionsDir);
    const byReason = Object.fromEntries(plans.map((p) => [p.reason, p.to]));

    expect(byReason[`session→${key}`]).toBe(path.join(sessionsDir, key, '20260101_000000.jsonl'));
    expect(byReason['sidecar→islands']).toBe(path.join(sessionsDir, key, '20260101_000000.islands.jsonl'));
    expect(byReason['orphan-sidecar→_unknown']).toBe(
      path.join(sessionsDir, '_unknown', 'orphan-islands', '20260102_000000.islands.jsonl'),
    );
  });

  it('retries its own finished lock cleanup in the same Host without adopting live foreign locks', async () => {
    await seedFlat('cleanup-retry');
    const lock = path.join(sessionsDir, '.migration-lock');
    const remove = fsPromises.rm;
    const fault = vi.spyOn(fsPromises, 'rm').mockImplementation(async (file, options) => {
      if (file === lock) throw Object.assign(new Error('fixture busy'), { code: 'EBUSY' });
      return remove(file, options);
    });
    await expect(ensureLayoutMigrated(sessionsDir)).rejects.toThrow(/cleanup/i);
    expect(existsSync(lock)).toBe(true);
    fault.mockRestore();
    await ensureLayoutMigrated(sessionsDir);
    expect(existsSync(lock)).toBe(false);
    await mkdir(lock);
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, nonce: 'foreign' }));
    await ensureLayoutMigrated(sessionsDir);
    expect(existsSync(lock)).toBe(true);
  });

  it('retains session bytes and removes its inert temporary record when owner publication fails', async () => {
    await seedFlat('owner-failure');
    const lock = path.join(sessionsDir, '.migration-lock');
    const link = fsSync.linkSync;
    const fault = vi.spyOn(fsSync, 'linkSync').mockImplementation((from, to) => {
      if (to === lock) throw new Error('fixture owner write failure');
      return link(from, to);
    });
    syncBuiltinESMExports();
    await expect(runMigration(sessionsDir)).rejects.toThrow('fixture owner write failure');
    expect(existsSync(lock)).toBe(false);
    fault.mockRestore(); syncBuiltinESMExports();
    await runMigration(sessionsDir);
    expect(await isMigrated(sessionsDir)).toBe(true);
  });

  it('surfaces both atomic publication and temporary cleanup failures without publishing an unknown owner', async () => {
    const source = await seedFlat('double-failure');
    const original = await readFile(source, 'utf8');
    const lock = path.join(sessionsDir, '.migration-lock');
    const link = fsSync.linkSync, remove = fsSync.rmSync;
    const ownerFailure = Object.assign(new Error('fixture owner failure'), { code: 'EIO' });
    const cleanupFailure = Object.assign(new Error('fixture cleanup busy'), { code: 'EBUSY' });
    vi.spyOn(fsSync, 'linkSync').mockImplementation((from, to) => {
      if (to === lock) throw ownerFailure;
      return link(from, to);
    });
    vi.spyOn(fsSync, 'rmSync').mockImplementation((file, options) => {
      if (String(file).startsWith(`${lock}.`) && String(file).endsWith('.tmp')) throw cleanupFailure;
      return remove(file, options);
    });
    syncBuiltinESMExports();
    await expect(ensureLayoutMigrated(sessionsDir)).rejects.toMatchObject({
      message: expect.stringMatching(/cleanup/i),
      cause: expect.objectContaining({ errors: [ownerFailure, cleanupFailure] }),
    });
    expect(existsSync(lock)).toBe(false);
    expect(await readFile(source, 'utf8')).toBe(original);
  });

  it('surfaces unreadable release ownership and retries it after repair without deleting unknown data', async () => {
    await seedFlat('owner-read-failure');
    const owner = path.join(sessionsDir, '.migration-lock');
    const read = fsPromises.readFile;
    const fault = vi.spyOn(fsPromises, 'readFile').mockImplementation(async (file, ...args) => {
      if (file === owner && existsSync(path.join(sessionsDir, '.layout.json'))) {
        throw Object.assign(new Error('fixture owner read denied'), { code: 'EACCES' });
      }
      return read(file, ...args);
    });
    await expect(ensureLayoutMigrated(sessionsDir)).rejects.toThrow(/cleanup/i);
    expect(existsSync(owner)).toBe(true);
    fault.mockRestore();
    await ensureLayoutMigrated(sessionsDir);
    expect(existsSync(owner)).toBe(false);
  });

  it.each([-1, 0, 1.25, '42'])('retains an unverifiable migration PID %s instead of reclaiming it', async pid => {
    await seedFlat('unknown-owner');
    const lock = path.join(sessionsDir, '.migration-lock');
    await mkdir(lock);
    const raw = JSON.stringify({ pid, heartbeatAt: 0 });
    await writeFile(path.join(lock, 'owner.json'), raw);
    expect(await runMigration(sessionsDir)).toEqual({ moved: 0, planned: 0 });
    expect(await readFile(path.join(lock, 'owner.json'), 'utf8')).toBe(raw);
    expect(await isMigrated(sessionsDir)).toBe(false);
  });

  it.each([{ pid: 2_146_999_999 }, { version: 2, pid: 2_146_999_999, nonce: 'unknown-format' },
    { version: 1, pid: 2_146_999_999, nonce: '' }])('retains an incomplete or unknown file-lock owner: %j', async owner => {
    await seedFlat('unknown-file-owner');
    const lock = path.join(sessionsDir, '.migration-lock'), raw = JSON.stringify(owner);
    await writeFile(lock, raw);
    expect(await runMigration(sessionsDir)).toEqual({ moved: 0, planned: 0 });
    expect(await readFile(lock, 'utf8')).toBe(raw);
    expect(await isMigrated(sessionsDir)).toBe(false);
  });

  it('reads a large metadata record without misrouting the session to _unknown', async () => {
    const id = 'large-meta';
    await writeFile(
      path.join(sessionsDir, `${id}.jsonl`),
      `${JSON.stringify({
        _type: 'meta', id, title: id, gitRoot, activeMessageCount: 1,
        uiHistory: ['x'.repeat(70_000)],
      })}\n`,
      'utf8',
    );

    await expect(planMigration(sessionsDir)).resolves.toContainEqual(
      expect.objectContaining({ to: path.join(sessionsDir, key, `${id}.jsonl`) }),
    );
  });

  it('runMigration moves files, writes the layout marker, and is idempotent', async () => {
    const flat = await seedFlat('20260201_000000');
    expect(await needsMigration(sessionsDir)).toBe(true);

    const result = await runMigration(sessionsDir);
    expect(result.moved).toBeGreaterThanOrEqual(1);

    const moved = path.join(sessionsDir, key, '20260201_000000.jsonl');
    expect(existsSync(moved)).toBe(true);
    expect(existsSync(flat)).toBe(false);
    await expect(readFile(path.join(sessionsDir, key, 'project.json'), 'utf8'))
      .resolves.toContain('canonicalRoot');
    expect(await isMigrated(sessionsDir)).toBe(true);
    expect(existsSync(path.join(sessionsDir, '.layout.json'))).toBe(true);
    // journal cleaned up after the marker lands
    expect(existsSync(path.join(sessionsDir, '.migration-journal.jsonl'))).toBe(false);

    // Second run is a no-op (marker present).
    const again = await runMigration(sessionsDir);
    expect(again.moved).toBe(0);
  });

  it('finishes committed journal cleanup before a new storage instance reads saved history', async () => {
    const { FileSessionStorage } = await import('./storage.js');
    const id = '20261101_000001';
    const options = { sessionsDir, configHome: path.join(root, '.kodax') };
    await new FileSessionStorage(options).save(id, { title: 'Retain history', gitRoot: root, messages: [{ role: 'user', content: 'keep every byte' }] });
    await writeFile(path.join(sessionsDir, '.migration-journal.jsonl'), '');
    await ensureLayoutMigrated(sessionsDir);
    const snapshot = await new FileSessionStorage(options).readFullSnapshot(id);
    expect(snapshot).toBeDefined();
    expect(existsSync(path.join(sessionsDir, '.migration-journal.jsonl'))).toBe(false);
  });

  it('never steals a live migration lock merely because its heartbeat is old', async () => {
    const flat = await seedFlat('20261101_000002');
    const lock = path.join(sessionsDir, '.migration-lock');
    await mkdir(lock);
    const bytes = JSON.stringify({ pid: process.pid, startTime: 0, heartbeatAt: 0 });
    await writeFile(path.join(lock, 'owner.json'), bytes);
    expect((await runMigration(sessionsDir)).moved).toBe(0);
    expect(await readFile(path.join(lock, 'owner.json'), 'utf8')).toBe(bytes);
    expect(existsSync(flat)).toBe(true);
  });

  it('relocates an orphan island sidecar instead of deleting it (non-destructive)', async () => {
    await writeFile(path.join(sessionsDir, '20260301_000000.archive.jsonl'), 'orphan-data\n', 'utf8');
    await runMigration(sessionsDir);
    const relocated = path.join(sessionsDir, '_unknown', 'orphan-islands', '20260301_000000.islands.jsonl');
    expect(existsSync(relocated)).toBe(true);
    expect(await readFile(relocated, 'utf8')).toBe('orphan-data\n');
  });

  it('keeps a newer dest on a destination-exists race (never clobbers a live write)', async () => {
    await seedFlat('20260401_000000');
    // Simulate a concurrent live write already at the destination.
    const destDir = path.join(sessionsDir, key);
    await mkdir(destDir, { recursive: true });
    const newer = `${metaLine('20260401_000000')}\n${JSON.stringify({ role: 'user', content: 'NEWER' })}\n`;
    await writeFile(path.join(destDir, '20260401_000000.jsonl'), newer, 'utf8');

    await runMigration(sessionsDir);

    expect(await readFile(path.join(destDir, '20260401_000000.jsonl'), 'utf8')).toBe(newer);
    expect(existsSync(path.join(sessionsDir, '20260401_000000.jsonl'))).toBe(false); // flat superseded
  });

  it('reclaims a stale lock left by a dead process', async () => {
    await seedFlat('20260501_000000');
    // Pre-create a lock owned by a definitely-dead pid with an old heartbeat.
    const lockDir = path.join(sessionsDir, '.migration-lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: 2147483646, startTime: 0, heartbeatAt: 0 }),
    );

    const result = await runMigration(sessionsDir);
    expect(result.moved).toBeGreaterThanOrEqual(1);
    expect(existsSync(path.join(sessionsDir, key, '20260501_000000.jsonl'))).toBe(true);
  });

  it('ensureLayoutMigrated stamps a marker on a fresh (empty) install without scanning forever', async () => {
    expect(await needsMigration(sessionsDir)).toBe(false);
    await ensureLayoutMigrated(sessionsDir);
    expect(await isMigrated(sessionsDir)).toBe(true);
  });

  it('retires an empty sessions-archive/ sibling dir after migrating its contents', async () => {
    const archiveDir = path.join(root, 'sessions-archive');
    await mkdir(archiveDir, { recursive: true });
    await writeFile(
      path.join(archiveDir, '20260601_000000.jsonl'),
      `${metaLine('20260601_000000')}\n`,
      'utf8',
    );
    await writeFile(
      path.join(archiveDir, '20260601_000000.conversation-cache.legacy.data'),
      'recoverable archived cache body',
      'utf8',
    );

    await runMigration(sessionsDir);

    expect(existsSync(path.join(sessionsDir, key, '20260601_000000.jsonl'))).toBe(true);
    expect(existsSync(archiveDir)).toBe(false); // retired
  });

  it('does not move a legacy Session until its recoverable page cache is removed, and retries', async () => {
    const id = '20260701_000000';
    const flat = await seedFlat(id);
    const cacheFiles = [
      path.join(sessionsDir, `${id}.conversation-cache.json`),
      path.join(sessionsDir, `${id}.conversation-cache.generation.data`),
      path.join(sessionsDir, `${id}.conversation-cache.generation.index`),
    ];
    await Promise.all(cacheFiles.map((filePath) => writeFile(filePath, 'recoverable body')));
    const originalRm = fsPromises.rm.bind(fsPromises);
    let denied = false;
    const remove = vi.spyOn(fsPromises, 'rm').mockImplementation(async (candidate, options) => {
      if (!denied && cacheFiles.includes(path.resolve(String(candidate)))) {
        denied = true;
        throw Object.assign(new Error('legacy cache cleanup denied'), { code: 'EACCES' });
      }
      return originalRm(candidate, options);
    });

    try {
      await expect(ensureLayoutMigrated(sessionsDir)).rejects.toMatchObject({
        name: 'ConversationPageCacheCleanupError',
      });
    } finally {
      remove.mockRestore();
    }

    expect(existsSync(flat)).toBe(true);
    expect(await isMigrated(sessionsDir)).toBe(false);
    await expect(ensureLayoutMigrated(sessionsDir)).resolves.toBeUndefined();
    expect(existsSync(flat)).toBe(false);
    expect(existsSync(path.join(sessionsDir, key, `${id}.jsonl`))).toBe(true);
    expect(cacheFiles.some(existsSync)).toBe(false);
  });

  it('re-canonicalizes a flat session with a stale persisted root and publishes its identity', async () => {
    const repository = path.join(root, 'repository');
    const staleRoot = path.join(root, 'stale-worktree-root');
    await Promise.all([
      mkdir(path.join(repository, '.git'), { recursive: true }),
      mkdir(staleRoot, { recursive: true }),
    ]);
    const canonicalKey = deriveProjectKeyFromRoot(repository).key;
    const id = 'v3-worktree-session';
    await writeFile(
      path.join(sessionsDir, `${id}.jsonl`),
      JSON.stringify({
        _type: 'meta', id, title: id, gitRoot: repository, activeMessageCount: 1,
        runtimeInfo: { canonicalRepoRoot: staleRoot, workspaceRoot: repository },
      }) + '\n',
      'utf8',
    );

    await ensureLayoutMigrated(sessionsDir);

    const canonicalDir = path.join(sessionsDir, canonicalKey);
    expect(existsSync(path.join(canonicalDir, `${id}.jsonl`))).toBe(true);
    const manifest: unknown = JSON.parse(await readFile(path.join(canonicalDir, 'project.json'), 'utf8'));
    expect(manifest).toMatchObject({
      canonicalRoot: deriveProjectKeyFromRoot(repository).canonicalRoot,
    });
    expect(await isMigrated(sessionsDir)).toBe(true);
  });
});
