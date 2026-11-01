/**
 * FEATURE_219 (v0.7.46) — Upgrade-transparent auto-migration from the flat
 * session pool to the per-project directory layout. See ADR-038 §6/§8.
 *
 * Safety posture (locked + journaled + resumable + non-destructive):
 *   - runs once per process at the first storage entry point
 *     (`ensureLayoutMigrated`, gated by a one-time Promise in storage.ts)
 *   - dual-layout read (the id-only locator) ships FIRST, so an interrupted
 *     migration never makes a session unreadable
 *   - `.layout.json` marker (written last, temp+rename) makes it idempotent
 *   - `.migration-lock` complete file publication (legacy directory + owner.json readable) with
 *     confirmed-dead pid reclamation; unknown owners remain retained for offline repair
 *   - `.migration-journal.jsonl` records every move → resume forward on the
 *     next start; never auto-rollback, never auto-delete session data
 *   - orphan island sidecars (no surviving main file) are RELOCATED to
 *     `_unknown/orphan-islands/`, never deleted
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { claimConfigLockReclamation, publishConfigLock } from '../common/core-config-lock.js';

import { deriveProjectKeyFromData, UNKNOWN_PROJECT_KEY, type ProjectIdentity } from './project-key.js';
import { publishProjectManifest } from './project-manifest.js';
import { resolveCanonicalWorkspaceRoot } from './workspace-runtime.js';
import {
  ConversationPageCacheCleanupError,
  removeConversationPageCache,
  removeConversationPageCachesInDirectory,
} from '../session/conversation-page-cache-files.js';

export const LAYOUT_VERSION = 3;

const HEAD_READ_BYTES = 65536;

class SessionMigrationCleanupError extends Error {}

async function removeMigrationPath(file: string, directory = false): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rm(file, { force: true, recursive: directory }); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 3 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(code ?? '')) {
        throw new SessionMigrationCleanupError('Session migration cleanup must be retried before a stable read.', { cause: error });
      }
      await delay(20 * (attempt + 1));
    }
  }
}

const layoutMarkerPath = (dir: string): string => path.join(dir, '.layout.json');
const lockDirPath = (dir: string): string => path.join(dir, '.migration-lock');
const ownerPath = (dir: string): string => path.join(lockDirPath(dir), 'owner.json');
const journalPath = (dir: string): string => path.join(dir, '.migration-journal.jsonl');
const sessionsArchiveDir = (dir: string): string => path.join(path.dirname(dir), 'sessions-archive');
const inactiveLocks = new Map<string, string>();

async function readMigrationOwner(dir: string): Promise<string> {
  const lock = lockDirPath(dir), entry = await fs.lstat(lock);
  if (entry.isSymbolicLink()) throw new Error('Migration lock ownership is an alias.');
  return fs.readFile(entry.isDirectory() ? ownerPath(dir) : lock, 'utf8');
}

interface MovePlan {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

function isSessionFile(name: string): boolean {
  return name.endsWith('.jsonl')
    && !name.endsWith('.archive.jsonl')
    && !name.endsWith('.islands.jsonl')
    && !name.startsWith('.');
}

/** The session id of an island sidecar, or null if `name` is not a sidecar. */
function sidecarId(name: string): string | null {
  if (name.endsWith('.archive.jsonl')) {
    return name.slice(0, -'.archive.jsonl'.length);
  }
  if (name.endsWith('.islands.jsonl')) {
    return name.slice(0, -'.islands.jsonl'.length);
  }
  return null;
}

/** Read just the meta head line of a flat session file. */
async function readMeta(filePath: string): Promise<{ gitRoot?: string; runtimeInfo?: unknown } | null> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(filePath, 'r');
    const chunks: Buffer[] = [];
    let lineBytes = 0;
    let position = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(HEAD_READ_BYTES);
      const { bytesRead } = await fh.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      const lineChunk = newline >= 0 ? chunk.subarray(0, newline) : chunk;
      chunks.push(lineChunk);
      lineBytes += lineChunk.length;
      if (newline >= 0) break;
      position += bytesRead;
    }
    const firstLine = Buffer.concat(chunks, lineBytes).toString('utf8').trim();
    if (!firstLine) {
      return null;
    }
    const parsed: unknown = JSON.parse(firstLine);
    if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>)._type === 'meta') {
      const rec = parsed as Record<string, unknown>;
      return {
        gitRoot: typeof rec.gitRoot === 'string' ? rec.gitRoot : undefined,
        runtimeInfo: rec.runtimeInfo,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/**
 * Destination project key for a flat session file. Uses the SAME resolver as
 * live writes (`deriveProjectKeyFromData`) so a migrated session and a future
 * re-save converge on one directory. A meta-less / unreadable file → `_unknown`.
 */
async function destIdentityFor(
  filePath: string,
  canonicalRoots: Map<string, Promise<string>>,
): Promise<ProjectIdentity> {
  const meta = await readMeta(filePath);
  if (!meta) {
    return deriveProjectKeyFromData({});
  }
  const runtime = meta.runtimeInfo !== null && typeof meta.runtimeInfo === 'object'
    ? meta.runtimeInfo as Record<string, unknown>
    : undefined;
  let runtimeInfo = meta.runtimeInfo;
  const persistedWorkspace = typeof runtime?.workspaceRoot === 'string'
    ? runtime.workspaceRoot
    : meta.gitRoot;
  const canonicalCandidate = persistedWorkspace
    ?? (typeof runtime?.canonicalRepoRoot === 'string' ? runtime.canonicalRepoRoot : undefined);
  if (canonicalCandidate && fsSync.existsSync(canonicalCandidate)) {
    const lookupKey = path.resolve(canonicalCandidate);
    let canonicalRoot = canonicalRoots.get(lookupKey);
    if (canonicalRoot === undefined) {
      canonicalRoot = resolveCanonicalWorkspaceRoot({ cwd: canonicalCandidate, timeoutMs: 750 });
      canonicalRoots.set(lookupKey, canonicalRoot);
    }
    runtimeInfo = {
      ...runtime,
      canonicalRepoRoot: await canonicalRoot,
      ...(persistedWorkspace !== undefined ? { workspaceRoot: persistedWorkspace } : {}),
    };
  }
  return deriveProjectKeyFromData({
    gitRoot: meta.gitRoot,
    // runtimeInfo shape is validated downstream by resolveSessionRuntimeInfo;
    // pass through as-is (deriveProjectKeyFromData tolerates partial shapes).
    runtimeInfo: runtimeInfo as never,
  });
}

/** Collect the flat `*.jsonl` (+ sidecars) and `sessions-archive/` contents. */
async function collectMigrationSources(sessionsDir: string): Promise<string[]> {
  const sources: string[] = [];
  const pushDir = async (dir: string, allowSidecars: boolean): Promise<void> => {
    let entries: import('fs').Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) {
        continue;
      }
      if (isSessionFile(e.name) || (allowSidecars && sidecarId(e.name) !== null)) {
        sources.push(path.join(dir, e.name));
      }
    }
  };
  await pushDir(sessionsDir, true);
  await pushDir(sessionsArchiveDir(sessionsDir), true);
  return sources;
}

function targetDirectory(sessionsDir: string, key: string): string {
  return path.join(sessionsDir, key);
}

/**
 * Build the move plan WITHOUT touching disk (pure planner — testable / dry-run).
 * Sidecars travel with their main file and are renamed `.archive.jsonl` →
 * `.islands.jsonl`. An orphan sidecar (no surviving main) is relocated to
 * `_unknown/orphan-islands/` rather than deleted.
 */
export async function planMigration(sessionsDir: string): Promise<MovePlan[]> {
  const sources = await collectMigrationSources(sessionsDir);
  const mains = sources.filter((s) => isSessionFile(path.basename(s)));
  const mainLocations = new Set(mains.map((main) =>
    `${path.dirname(main)}\0${path.basename(main, '.jsonl')}`));
  const plans: MovePlan[] = [];
  const canonicalRoots = new Map<string, Promise<string>>();

  for (const main of mains) {
    const id = path.basename(main, '.jsonl');
    const key = (await destIdentityFor(main, canonicalRoots)).key;
    const destinationDir = targetDirectory(sessionsDir, key);
    plans.push({ from: main, to: path.join(destinationDir, `${id}.jsonl`), reason: `session→${key}` });
    // Paired island sidecar (same dir as the main source) — either the old
    // `.archive.jsonl` or an already-renamed `.islands.jsonl`.
    for (const suffix of ['.archive.jsonl', '.islands.jsonl']) {
      const sidecar = path.join(path.dirname(main), `${id}${suffix}`);
      if (fsSync.existsSync(sidecar)) {
        plans.push({ from: sidecar, to: path.join(destinationDir, `${id}.islands.jsonl`), reason: 'sidecar→islands' });
      }
    }
  }

  // Orphan sidecars (either suffix) whose main is gone → preserve, not delete.
  for (const src of sources) {
    const id = sidecarId(path.basename(src));
    if (id === null || mainLocations.has(`${path.dirname(src)}\0${id}`)) {
      continue; // a session file, or handled as a paired sidecar above
    }
    plans.push({
      from: src,
      to: path.join(sessionsDir, UNKNOWN_PROJECT_KEY, 'orphan-islands', `${id}.islands.jsonl`),
      reason: 'orphan-sidecar→_unknown',
    });
  }
  return plans;
}

export async function isMigrated(sessionsDir: string): Promise<boolean> {
  try {
    const marker: unknown = JSON.parse(await fs.readFile(layoutMarkerPath(sessionsDir), 'utf8'));
    return marker !== null
      && typeof marker === 'object'
      && (marker as { version?: unknown }).version === LAYOUT_VERSION;
  } catch {
    return false;
  }
}

async function removeLegacyConversationCaches(sessionsDir: string): Promise<void> {
  await removeConversationPageCachesInDirectory(sessionsDir);
  await removeConversationPageCachesInDirectory(sessionsArchiveDir(sessionsDir));
}

export async function needsMigration(sessionsDir: string): Promise<boolean> {
  if (await isMigrated(sessionsDir)) {
    return false;
  }
  const sources = await collectMigrationSources(sessionsDir);
  return sources.length > 0;
}

async function lockIsStale(dir: string): Promise<boolean> {
  try {
    const raw = await readMigrationOwner(dir);
    const data = JSON.parse(raw) as {
      pid?: number;
      heartbeatAt?: number;
      version?: unknown;
      nonce?: unknown;
    };
    if (!(await fs.lstat(lockDirPath(dir))).isDirectory()
      && (data.version !== 1 || typeof data.nonce !== 'string' || !data.nonce)) return false;
    if (typeof data.pid === 'number' && Number.isSafeInteger(data.pid) && data.pid > 0 && data.pid !== process.pid) {
      try {
        process.kill(data.pid, 0); // throws ESRCH if the holder is gone
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          return claimConfigLockReclamation(lockDirPath(dir), raw)
            && await readMigrationOwner(dir) === raw;
        }
      }
    }
    return false;
  } catch {
    return false; // Unknown ownership never grants permission to remove a lock.
  }
}

async function acquireLock(dir: string): Promise<string | undefined> {
  const lock = lockDirPath(dir);
  const inactive = inactiveLocks.get(dir);
  if (inactive !== undefined) {
    // Claim this local retry before yielding; a parallel caller cannot delete
    // the replacement lock that this acquisition is about to publish.
    inactiveLocks.delete(dir);
    await releaseLock(dir, inactive);
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const nonce = randomUUID();
    try {
      if (publishConfigLock(lock, JSON.stringify({ version: 1, pid: process.pid, nonce, startTime: Date.now() }))) return nonce;
    } catch (error) {
      if (error instanceof AggregateError) throw new SessionMigrationCleanupError('Migration owner publication cleanup failed.', { cause: error });
      throw error;
    }
    if (attempt === 0 && await lockIsStale(dir)) { await removeMigrationPath(lock, true); continue; }
    return undefined; // A live or unverifiable writer retains ownership.
  }
  return undefined;
}

async function releaseLock(dir: string, nonce: string): Promise<void> {
  inactiveLocks.set(dir, nonce);
  try {
    const owner: unknown = JSON.parse(await readMigrationOwner(dir));
    if (!owner || typeof owner !== 'object' || !('nonce' in owner) || owner.nonce !== nonce) {
      inactiveLocks.delete(dir);
      throw new SessionMigrationCleanupError('Session migration ownership changed before cleanup.');
    }
    await removeMigrationPath(lockDirPath(dir), true);
    inactiveLocks.delete(dir);
  } catch (error) {
    if (error instanceof SessionMigrationCleanupError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try { await fs.lstat(lockDirPath(dir)); }
      catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ENOENT') { inactiveLocks.delete(dir); return; }
        throw new SessionMigrationCleanupError('Session migration cleanup cannot inspect the retained lock.', { cause: probe });
      }
    }
    throw new SessionMigrationCleanupError('Session migration cleanup ownership is unreadable; original lock retained for retry.', { cause: error });
  }
}

async function assertNoActiveSessionWriters(sessionsDir: string): Promise<void> {
  try {
    const entries = await fs.readdir(path.join(sessionsDir, '.write-locks'), {
      withFileTypes: true,
    });
    if (entries.some((entry) => entry.isFile() && /^[0-9a-f]{64}\.lock$/.test(entry.name))) {
      throw new Error('Session layout migration deferred while a Session writer is active');
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

async function readJournalDone(dir: string): Promise<Set<string>> {
  const done = new Set<string>();
  try {
    const content = await fs.readFile(journalPath(dir), 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        const rec = JSON.parse(line) as { from?: string; done?: boolean };
        if (rec.done && typeof rec.from === 'string') {
          done.add(rec.from);
        }
      } catch {
        // skip malformed journal line
      }
    }
  } catch {
    // no journal yet
  }
  return done;
}

/** Move one file; race-safe (a pre-existing dest is a newer write — keep it). */
async function executeMove(plan: MovePlan, sessionsDir: string): Promise<boolean> {
  if (path.resolve(plan.from) === path.resolve(plan.to)) return false;
  await fs.mkdir(path.dirname(plan.to), { recursive: true });
  if (fsSync.existsSync(plan.to)) {
    // Destination already written (concurrent live write or a prior run) — the
    // flat source is superseded. A v3 project source may instead be a distinct
    // same-id session, so preserve it for explicit recovery.
    const sourceDir = path.dirname(plan.from);
    if (sourceDir === sessionsDir || sourceDir === sessionsArchiveDir(sessionsDir)) {
      await fs.unlink(plan.from).catch(() => undefined);
      return true;
    }
    return false;
  }
  try {
    await fs.rename(plan.from, plan.to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EXDEV') {
      await fs.copyFile(plan.from, plan.to);
      await fs.unlink(plan.from).catch(() => undefined);
    } else if (code !== 'ENOENT') {
      throw err;
    }
    // ENOENT → source already moved by a racing process; nothing to do.
  }
  return true;
}

async function readBucketMainFiles(projectDir: string): Promise<string[]> {
  const files: string[] = [];
  const append = async (directory: string): Promise<void> => {
    try {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isFile() && isSessionFile(entry.name)) files.push(path.join(directory, entry.name));
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  await append(projectDir);
  await append(path.join(projectDir, 'archived'));
  return files;
}

async function publishBucketManifests(
  sessionsDir: string,
  plans: readonly MovePlan[],
): Promise<void> {
  const canonicalRoots = new Map<string, Promise<string>>();
  const projectDirs = new Set(plans.flatMap((plan) =>
    plan.reason.startsWith('session→') ? [path.dirname(plan.to)] : []));
  for (const projectDir of projectDirs) {
    const key = path.basename(projectDir);
    if (key === UNKNOWN_PROJECT_KEY) continue;
    const files = await readBucketMainFiles(projectDir);
    let bucketIdentity: ProjectIdentity | undefined;
    for (const filePath of files) {
      const identity = await destIdentityFor(filePath, canonicalRoots);
      if (
        identity.canonicalRoot === null
        || identity.key !== key
        || (bucketIdentity !== undefined && bucketIdentity.canonicalRoot !== identity.canonicalRoot)
      ) {
        throw new Error(`Cannot certify mixed project identities in ${projectDir}`);
      }
      bucketIdentity ??= identity;
    }
    if (bucketIdentity !== undefined) await publishProjectManifest(projectDir, bucketIdentity);
  }
}

async function writeMarker(sessionsDir: string): Promise<void> {
  await fs.mkdir(sessionsDir, { recursive: true });
  const tmp = `${layoutMarkerPath(sessionsDir)}.${process.pid}.tmp`;
  const payload = JSON.stringify({
    version: LAYOUT_VERSION,
    migratedAt: new Date().toISOString(),
    from: 'flat-v1',
  });
  await fs.writeFile(tmp, payload + '\n', 'utf8');
  await fs.rename(tmp, layoutMarkerPath(sessionsDir));
}

async function retireSessionsArchive(sessionsDir: string): Promise<void> {
  const dir = sessionsArchiveDir(sessionsDir);
  try {
    const remaining = await fs.readdir(dir);
    if (remaining.length === 0) {
      await fs.rmdir(dir).catch(() => undefined);
    }
  } catch {
    // never existed — fine
  }
}

export interface MigrationResult {
  readonly moved: number;
  readonly planned: number;
}

/**
 * Execute the migration under lock + journal. Idempotent: a prior-run journal
 * skips completed moves; the marker is written ONLY after every move lands and
 * `sessions-archive/` is retired. Returns counts (0 moved if another process
 * holds the lock — the caller still operates fine via dual-layout reads).
 */
export async function runMigration(sessionsDir: string): Promise<MigrationResult> {
  const nonce = await acquireLock(sessionsDir);
  if (!nonce) {
    return { moved: 0, planned: 0 };
  }
  try {
    await assertNoActiveSessionWriters(sessionsDir);
    // Cache files contain full message bodies and are not part of the move
    // plan. Remove them before moving a main file, then sweep again before the
    // durable marker to close a race with a writer that started before the
    // migration lock was acquired.
    await removeLegacyConversationCaches(sessionsDir);
    const plans = await planMigration(sessionsDir);
    const done = await readJournalDone(sessionsDir);
    const handle = await fs.open(journalPath(sessionsDir), 'a');
    let moved = 0;
    try {
      for (const plan of plans) {
        if (isSessionFile(path.basename(plan.from))) {
          try {
            await removeConversationPageCache(plan.to);
          } catch (error: unknown) {
            throw new ConversationPageCacheCleanupError(path.dirname(plan.to), error);
          }
        }
        if (done.has(plan.from)) {
          continue;
        }
        const changed = await executeMove(plan, sessionsDir);
        await handle.write(JSON.stringify({ from: plan.from, to: plan.to, done: true }) + '\n');
        if (changed) moved += 1;
      }
    } finally {
      await handle.close();
    }
    await retireSessionsArchive(sessionsDir);
    await removeLegacyConversationCaches(sessionsDir);
    await publishBucketManifests(sessionsDir, plans);
    await writeMarker(sessionsDir);
    // Journal has served its purpose; the marker is the durable idempotency
    // guard. Removing it is safe (it never held session data).
    await removeMigrationPath(journalPath(sessionsDir));
    return { moved, planned: plans.length };
  } finally {
    await releaseLock(sessionsDir, nonce);
  }
}

/**
 * One-shot entry gate. Cache cleanup failures are surfaced for an immediate
 * retry; other migration failures leave the flat pool readable through the
 * dual-layout locator and are retried on the next start.
 */
export async function ensureLayoutMigrated(sessionsDir: string): Promise<void> {
  try {
    if (await isMigrated(sessionsDir)) {
      if (fsSync.existsSync(journalPath(sessionsDir)) || fsSync.existsSync(lockDirPath(sessionsDir))) {
        const nonce = await acquireLock(sessionsDir);
        if (nonce) {
          try { await removeMigrationPath(journalPath(sessionsDir)); }
          finally { await releaseLock(sessionsDir, nonce); }
        }
      }
      return;
    }
    await runMigration(sessionsDir);
  } catch (error: unknown) {
    if (error instanceof ConversationPageCacheCleanupError || error instanceof SessionMigrationCleanupError) throw error;
    // best-effort — dual-layout reads keep everything working
  }
}
