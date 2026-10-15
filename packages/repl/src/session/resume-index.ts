import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const RESUME_INDEX_VERSION = 8;
const RESUME_INDEX_DIR = '.resume-index';
const RESUME_INDEX_MANIFEST = 'complete.json';
const RESUME_INDEX_PUBLISH_LOCK = 'publish.lock';
const RESUME_MARKER_SUFFIX = '.resume';
const INDEX_IO_CONCURRENCY = 32;
const INDEX_PUBLISH_LOCK_TIMEOUT_MS = 2_000;
const INDEX_PUBLISH_LOCK_RETRY_MS = 10;
const INDEX_PUBLISH_LOCK_MALFORMED_STALE_MS = 30_000;
const INDEX_PUBLISH_LOCK_REMOVE_RETRIES = 40;
const localIndexPublishQueues = new Map<string, Promise<void>>();
const abandonedLocalIndexPublishLocks = new Map<string, string>();

export interface ResumeIndexEntry {
  readonly id: string;
  readonly title: string;
  readonly msgCount: number;
  readonly createdAt?: string;
  readonly lastMessageAt?: string;
  readonly surface?: string;
}

export interface ResumeIndexSourceIdentity {
  readonly sourceSize: number;
  readonly sourceMtimeMs: number;
  readonly sourceCtimeMs: number;
  readonly sourceDev: number;
  readonly sourceIno: number;
}

export interface ResumeIndexScanEntry extends ResumeIndexEntry, ResumeIndexSourceIdentity {}

export interface ResumeIndexScannedFile extends ResumeIndexSourceIdentity {
  readonly name: string;
}

interface ResumeIndexManifest {
  readonly version: 8;
  readonly markerNames: readonly string[];
  readonly markerCount: number;
  readonly markerDigest: string;
  readonly sessionNames: readonly string[];
  readonly sessionFileCount: number;
  readonly sessionFileDigest: string;
  readonly excludedSources: readonly ResumeIndexScannedFile[];
  readonly excludedSourceCount: number;
  readonly excludedSourceDigest: string;
}

interface ResumeMarker {
  readonly version: 8;
  readonly state: 'pending' | 'ready';
  readonly entry: ResumeIndexEntry;
  readonly source?: {
    readonly size: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
    readonly dev: number;
    readonly ino: number;
  };
}

async function mapBatches<T, R>(
  values: readonly T[],
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < values.length; start += INDEX_IO_CONCURRENCY) {
    const batch = values.slice(start, start + INDEX_IO_CONCURRENCY);
    results.push(...await Promise.all(batch.map((value, offset) => operation(value, start + offset))));
  }
  return results;
}

function indexDir(projectDir: string): string {
  return path.join(projectDir, RESUME_INDEX_DIR);
}

function manifestPath(projectDir: string): string {
  return path.join(indexDir(projectDir), RESUME_INDEX_MANIFEST);
}

function markerName(id: string): string {
  return `${createHash('sha256').update(id, 'utf8').digest('hex')}${RESUME_MARKER_SUFFIX}`;
}

function markerPath(projectDir: string, id: string): string {
  return path.join(indexDir(projectDir), markerName(id));
}

interface IndexPublishLockOwner {
  readonly pid: number;
  readonly token: string;
}

function parseIndexPublishLockOwner(content: string): IndexPublishLockOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      !isRecord(parsed)
      || typeof parsed.pid !== 'number'
      || !Number.isInteger(parsed.pid)
      || parsed.pid <= 0
      || typeof parsed.token !== 'string'
      || parsed.token.length === 0
    ) return undefined;
    return { pid: parsed.pid, token: parsed.token };
  } catch {
    return undefined;
  }
}

async function removeEmptyIndexLockDirectory(directory: string): Promise<boolean> {
  for (let attempt = 0; attempt < INDEX_PUBLISH_LOCK_REMOVE_RETRIES; attempt += 1) {
    try {
      await fs.rmdir(directory);
      return true;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return true;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) return false;
      if (attempt + 1 < INDEX_PUBLISH_LOCK_REMOVE_RETRIES) {
        await new Promise<void>((resolve) => setTimeout(resolve, INDEX_PUBLISH_LOCK_RETRY_MS));
      }
    }
  }
  return false;
}

async function acquireIndexLockReclaimGuard(lockPath: string): Promise<(() => Promise<void>) | undefined> {
  const guardPath = `${lockPath}.reclaim`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(guardPath);
      return async () => {
        if (!await removeEmptyIndexLockDirectory(guardPath)) {
          process.emitWarning(`Unable to release resume-index reclaim guard ${guardPath}`, {
            code: 'KODAX_RESUME_INDEX',
          });
        }
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt > 0) return undefined;
      try {
        const guard = await fs.stat(guardPath);
        if (Date.now() - guard.mtimeMs < INDEX_PUBLISH_LOCK_MALFORMED_STALE_MS) return undefined;
      } catch (statError: unknown) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw statError;
      }
      if (!await removeEmptyIndexLockDirectory(guardPath)) return undefined;
    }
  }
  return undefined;
}

function processIsDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function readIndexPublishLock(lockPath: string): Promise<{
  readonly content: string;
  readonly mtimeMs: number;
} | undefined> {
  try {
    const [content, stat] = await Promise.all([
      fs.readFile(lockPath, 'utf8'),
      fs.stat(lockPath),
    ]);
    return { content, mtimeMs: stat.mtimeMs };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function removeObservedIndexPublishLock(
  lockPath: string,
  observedContent: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < INDEX_PUBLISH_LOCK_REMOVE_RETRIES; attempt += 1) {
    const current = await readIndexPublishLock(lockPath);
    if (current === undefined) return true;
    if (current.content !== observedContent) return false;
    try {
      await fs.rm(lockPath);
      return true;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return true;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) return false;
      if (attempt + 1 < INDEX_PUBLISH_LOCK_REMOVE_RETRIES) {
        await new Promise<void>((resolve) => setTimeout(resolve, INDEX_PUBLISH_LOCK_RETRY_MS));
      }
    }
  }
  return false;
}

async function reclaimAbandonedIndexPublishLock(lockPath: string): Promise<boolean> {
  const observed = await readIndexPublishLock(lockPath);
  if (observed === undefined) return true;
  if (abandonedLocalIndexPublishLocks.get(lockPath) === observed.content) {
    const removed = await removeObservedIndexPublishLock(lockPath, observed.content);
    if (removed) abandonedLocalIndexPublishLocks.delete(lockPath);
    return removed;
  }
  const owner = parseIndexPublishLockOwner(observed.content);
  if (owner !== undefined) {
    if (!processIsDefinitelyDead(owner.pid)) return false;
  } else if (Date.now() - observed.mtimeMs < INDEX_PUBLISH_LOCK_MALFORMED_STALE_MS) {
    return false;
  }
  const releaseGuard = await acquireIndexLockReclaimGuard(lockPath);
  if (releaseGuard === undefined) return false;
  try {
    const guarded = await readIndexPublishLock(lockPath);
    if (guarded === undefined) return true;
    const guardedOwner = parseIndexPublishLockOwner(guarded.content);
    const locallyAbandoned = abandonedLocalIndexPublishLocks.get(lockPath) === guarded.content;
    const reclaimable = locallyAbandoned
      || (guardedOwner !== undefined
        ? processIsDefinitelyDead(guardedOwner.pid)
        : Date.now() - guarded.mtimeMs >= INDEX_PUBLISH_LOCK_MALFORMED_STALE_MS);
    return reclaimable
      ? removeObservedIndexPublishLock(lockPath, guarded.content)
      : false;
  } finally {
    await releaseGuard();
  }
}

async function removeIndexPublishLockTemp(tempPath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < INDEX_PUBLISH_LOCK_REMOVE_RETRIES; attempt += 1) {
    try {
      await fs.rm(tempPath, { force: true });
      return;
    } catch (error: unknown) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) break;
      if (attempt + 1 < INDEX_PUBLISH_LOCK_REMOVE_RETRIES) {
        await new Promise<void>((resolve) => setTimeout(resolve, INDEX_PUBLISH_LOCK_RETRY_MS));
      }
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  process.emitWarning(`Unable to remove resume-index lock temp file ${tempPath}: ${reason}`, {
    code: 'KODAX_RESUME_INDEX',
  });
}

async function acquireIndexPublishLock(lockPath: string, ownerContent: string): Promise<void> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const tempPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, ownerContent, { encoding: 'utf8', flag: 'wx' });
  const deadline = Date.now() + INDEX_PUBLISH_LOCK_TIMEOUT_MS;
  try {
    while (true) {
      try {
        // A hard link publishes the already-complete owner record atomically.
        await fs.link(tempPath, lockPath);
        return;
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error;
        const existing = await readIndexPublishLock(lockPath);
        if (existing !== undefined && await reclaimAbandonedIndexPublishLock(lockPath)) continue;
        if (Date.now() >= deadline) {
          throw new Error(`Resume index publish lock timed out: ${lockPath}`, { cause: error });
        }
        await new Promise<void>((resolve) => setTimeout(resolve, INDEX_PUBLISH_LOCK_RETRY_MS));
      }
    }
  } finally {
    await removeIndexPublishLockTemp(tempPath);
  }
}

async function releaseIndexPublishLock(lockPath: string, ownerContent: string): Promise<void> {
  if (!await removeObservedIndexPublishLock(lockPath, ownerContent)) {
    abandonedLocalIndexPublishLocks.set(lockPath, ownerContent);
    throw new Error(`Resume index publish lock ownership changed: ${lockPath}`);
  }
  if (abandonedLocalIndexPublishLocks.get(lockPath) === ownerContent) {
    abandonedLocalIndexPublishLocks.delete(lockPath);
  }
}

async function withIndexPublishLock<T>(
  projectDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(indexDir(projectDir), RESUME_INDEX_PUBLISH_LOCK);
  const previous = localIndexPublishQueues.get(lockPath) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const queueTail = new Promise<void>((resolve) => { releaseQueue = resolve; });
  localIndexPublishQueues.set(lockPath, queueTail);
  await previous.catch(() => undefined);
  const ownerContent = JSON.stringify({ pid: process.pid, token: randomUUID() });
  try {
    await acquireIndexPublishLock(lockPath, ownerContent);
    try {
      return await operation();
    } finally {
      await releaseIndexPublishLock(lockPath, ownerContent);
    }
  } finally {
    releaseQueue();
    if (localIndexPublishQueues.get(lockPath) === queueTail) {
      localIndexPublishQueues.delete(lockPath);
    }
  }
}

export function resumeIndexProjectDir(mainPath: string): string {
  const directory = path.dirname(mainPath);
  return path.basename(directory) === 'archived' ? path.dirname(directory) : directory;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseEntry(value: unknown): ResumeIndexEntry | undefined {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || value.id.length === 0
    || path.basename(value.id) !== value.id
    || typeof value.title !== 'string'
    || typeof value.msgCount !== 'number'
    || !Number.isInteger(value.msgCount)
    || value.msgCount <= 0
    || (value.createdAt !== undefined && typeof value.createdAt !== 'string')
    || (value.lastMessageAt !== undefined && typeof value.lastMessageAt !== 'string')
    || (value.surface !== undefined && typeof value.surface !== 'string')
  ) return undefined;
  return {
    id: value.id,
    title: value.title,
    msgCount: value.msgCount,
    ...(value.createdAt !== undefined ? { createdAt: value.createdAt } : {}),
    ...(value.lastMessageAt !== undefined ? { lastMessageAt: value.lastMessageAt } : {}),
    ...(value.surface !== undefined ? { surface: value.surface } : {}),
  };
}

function parseManifest(value: unknown): ResumeIndexManifest | undefined {
  if (!isRecord(value)) return undefined;
  const markerNames = Array.isArray(value.markerNames)
    && value.markerNames.every((name) => typeof name === 'string')
    ? [...value.markerNames].sort()
    : undefined;
  const sessionNames = Array.isArray(value.sessionNames)
    && value.sessionNames.every((name) => typeof name === 'string')
    ? [...value.sessionNames].sort()
    : undefined;
  const excludedSources = Array.isArray(value.excludedSources)
    ? value.excludedSources.flatMap((source) => {
        if (
          !isRecord(source)
          || typeof source.name !== 'string'
          || typeof source.sourceSize !== 'number'
          || !Number.isInteger(source.sourceSize)
          || source.sourceSize < 0
          || typeof source.sourceMtimeMs !== 'number'
          || !Number.isFinite(source.sourceMtimeMs)
          || typeof source.sourceCtimeMs !== 'number'
          || !Number.isFinite(source.sourceCtimeMs)
          || typeof source.sourceDev !== 'number'
          || !Number.isInteger(source.sourceDev)
          || typeof source.sourceIno !== 'number'
          || !Number.isInteger(source.sourceIno)
        ) return [];
        return [{
          name: source.name,
          sourceSize: source.sourceSize,
          sourceMtimeMs: source.sourceMtimeMs,
          sourceCtimeMs: source.sourceCtimeMs,
          sourceDev: source.sourceDev,
          sourceIno: source.sourceIno,
        }];
      })
    : undefined;
  if (
    value.version !== RESUME_INDEX_VERSION
    || markerNames === undefined
    || typeof value.markerCount !== 'number'
    || !Number.isInteger(value.markerCount)
    || value.markerCount < 0
    || typeof value.markerDigest !== 'string'
    || sessionNames === undefined
    || typeof value.sessionFileCount !== 'number'
    || !Number.isInteger(value.sessionFileCount)
    || value.sessionFileCount < 0
    || typeof value.sessionFileDigest !== 'string'
    || excludedSources === undefined
    || typeof value.excludedSourceCount !== 'number'
    || !Number.isInteger(value.excludedSourceCount)
    || value.excludedSourceCount < 0
    || typeof value.excludedSourceDigest !== 'string'
    || markerNames.length !== value.markerCount
    || digestMarkerNames(markerNames) !== value.markerDigest
    || sessionNames.length !== value.sessionFileCount
    || digestMarkerNames(sessionNames) !== value.sessionFileDigest
    || excludedSources.length !== value.excludedSourceCount
    || digestScannedFiles(excludedSources) !== value.excludedSourceDigest
  ) return undefined;
  return {
    version: RESUME_INDEX_VERSION,
    markerNames,
    markerCount: value.markerCount,
    markerDigest: value.markerDigest,
    sessionNames,
    sessionFileCount: value.sessionFileCount,
    sessionFileDigest: value.sessionFileDigest,
    excludedSources,
    excludedSourceCount: value.excludedSourceCount,
    excludedSourceDigest: value.excludedSourceDigest,
  };
}

function parseMarker(value: unknown, expectedName: string): ResumeMarker | undefined {
  if (
    !isRecord(value)
    || value.version !== RESUME_INDEX_VERSION
    || (value.state !== 'pending' && value.state !== 'ready')
  ) return undefined;
  const entry = parseEntry(value.entry);
  if (!entry || markerName(entry.id) !== expectedName) return undefined;
  const source = isRecord(value.source)
    && typeof value.source.size === 'number'
    && Number.isInteger(value.source.size)
    && value.source.size >= 0
    && typeof value.source.mtimeMs === 'number'
    && Number.isFinite(value.source.mtimeMs)
    && typeof value.source.ctimeMs === 'number'
    && Number.isFinite(value.source.ctimeMs)
    && typeof value.source.dev === 'number'
    && Number.isInteger(value.source.dev)
    && typeof value.source.ino === 'number'
    && Number.isInteger(value.source.ino)
    ? {
        size: value.source.size,
        mtimeMs: value.source.mtimeMs,
        ctimeMs: value.source.ctimeMs,
        dev: value.source.dev,
        ino: value.source.ino,
      }
    : undefined;
  if (value.state === 'ready' && source === undefined) return undefined;
  return {
    version: RESUME_INDEX_VERSION,
    state: value.state,
    entry,
    ...(source !== undefined ? { source } : {}),
  };
}

function digestMarkerNames(names: readonly string[]): string {
  const digest = createHash('sha256');
  for (const name of [...names].sort()) {
    digest.update(name);
    digest.update('\n');
  }
  return digest.digest('hex');
}

function digestScannedFiles(files: readonly ResumeIndexScannedFile[]): string {
  const digest = createHash('sha256');
  for (const file of [...files].sort((left, right) => left.name.localeCompare(right.name))) {
    digest.update(JSON.stringify([
      file.name,
      file.sourceSize,
      file.sourceMtimeMs,
      file.sourceCtimeMs,
      file.sourceDev,
      file.sourceIno,
    ]));
    digest.update('\n');
  }
  return digest.digest('hex');
}

async function readMarkerNames(projectDir: string): Promise<string[]> {
  try {
    return (await fs.readdir(indexDir(projectDir), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(RESUME_MARKER_SUFFIX))
      .map((entry) => entry.name)
      .sort();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function readCanonicalSessionNames(projectDir: string): Promise<string[]> {
  try {
    return (await fs.readdir(projectDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile()
        && entry.name.endsWith('.jsonl')
        && !entry.name.endsWith('.archive.jsonl')
        && !entry.name.endsWith('.islands.jsonl')
        && !entry.name.startsWith('archived-')
        && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function readMarker(projectDir: string, name: string): Promise<ResumeMarker | undefined> {
  let content: string;
  try {
    content = await fs.readFile(path.join(indexDir(projectDir), name), 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
  try {
    return parseMarker(JSON.parse(content) as unknown, name);
  } catch {
    return undefined; // malformed derived data is rebuilt from canonical JSONL
  }
}

async function replaceDerivedFile(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, content, 'utf8');
  try {
    await fs.rename(tempPath, filePath);
  } catch (error: unknown) {
    if (!['EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    await fs.rm(filePath, { force: true });
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

async function invalidateManifest(projectDir: string): Promise<void> {
  await fs.rm(manifestPath(projectDir), { force: true });
}

async function writeMarker(
  projectDir: string,
  entry: ResumeIndexEntry,
  state: ResumeMarker['state'],
  replace: boolean,
  source?: ResumeMarker['source'],
): Promise<boolean> {
  const directory = indexDir(projectDir);
  const target = markerPath(projectDir, entry.id);
  await fs.mkdir(directory, { recursive: true });
  if (!replace) {
    try {
      await fs.access(target);
      return false;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const existing = replace
    ? await readMarker(projectDir, markerName(entry.id))
    : undefined;
  const marker: ResumeMarker = {
    version: RESUME_INDEX_VERSION,
    state,
    entry: { ...existing?.entry, ...entry },
    ...(source !== undefined ? { source } : {}),
  };
  await replaceDerivedFile(target, JSON.stringify(marker));
  return true;
}

async function canonicalSource(
  projectDir: string,
  id: string,
): Promise<ResumeMarker['source'] | undefined> {
  try {
    const stat = await fs.stat(path.join(projectDir, `${id}.jsonl`));
    return stat.isFile()
      ? {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          dev: stat.dev,
          ino: stat.ino,
        }
      : undefined;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function currentScannedFile(
  projectDir: string,
  name: string,
): Promise<ResumeIndexScannedFile | undefined> {
  const id = path.basename(name, '.jsonl');
  if (`${id}.jsonl` !== name) return undefined;
  const source = await canonicalSource(projectDir, id);
  return source === undefined
    ? undefined
    : {
        name,
        sourceSize: source.size,
        sourceMtimeMs: source.mtimeMs,
        sourceCtimeMs: source.ctimeMs,
        sourceDev: source.dev,
        sourceIno: source.ino,
      };
}

function sourceMatchesIdentity(
  source: ResumeMarker['source'] | undefined,
  identity: ResumeIndexSourceIdentity,
): boolean {
  return source !== undefined
    && source.size === identity.sourceSize
    && source.mtimeMs === identity.sourceMtimeMs
    && source.ctimeMs === identity.sourceCtimeMs
    && source.dev === identity.sourceDev
    && source.ino === identity.sourceIno;
}

async function scannedFilesStillMatch(
  projectDir: string,
  files: readonly ResumeIndexScannedFile[],
): Promise<boolean> {
  const matches = await mapBatches(files, async (file) => {
    const id = path.basename(file.name, '.jsonl');
    if (`${id}.jsonl` !== file.name) return false;
    return sourceMatchesIdentity(await canonicalSource(projectDir, id), file);
  });
  return matches.every(Boolean);
}

async function markerMatchesCanonical(projectDir: string, marker: ResumeMarker): Promise<boolean> {
  if (marker.state !== 'ready' || marker.source === undefined) return false;
  const source = await canonicalSource(projectDir, marker.entry.id);
  return source !== undefined
    && source.size === marker.source.size
    && source.mtimeMs === marker.source.mtimeMs
    && source.ctimeMs === marker.source.ctimeMs
    && source.dev === marker.source.dev
    && source.ino === marker.source.ino;
}

async function writeManifest(
  projectDir: string,
  markerNames: readonly string[],
  sessionNames: readonly string[],
  excludedFiles: readonly ResumeIndexScannedFile[],
): Promise<void> {
  await fs.mkdir(indexDir(projectDir), { recursive: true });
  const sortedMarkerNames = [...markerNames].sort();
  const sortedSessionNames = [...sessionNames].sort();
  const sortedExcludedFiles = [...excludedFiles].sort((left, right) => left.name.localeCompare(right.name));
  const manifest: ResumeIndexManifest = {
    version: RESUME_INDEX_VERSION,
    markerNames: sortedMarkerNames,
    markerCount: sortedMarkerNames.length,
    markerDigest: digestMarkerNames(sortedMarkerNames),
    sessionNames: sortedSessionNames,
    sessionFileCount: sortedSessionNames.length,
    sessionFileDigest: digestMarkerNames(sortedSessionNames),
    excludedSources: sortedExcludedFiles,
    excludedSourceCount: sortedExcludedFiles.length,
    excludedSourceDigest: digestScannedFiles(sortedExcludedFiles),
  };
  await replaceDerivedFile(manifestPath(projectDir), JSON.stringify(manifest));
}

export async function readResumeIndex(
  projectDir: string,
): Promise<readonly ResumeIndexEntry[] | undefined> {
  let content: string;
  try {
    content = await fs.readFile(manifestPath(projectDir), 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
  let manifest: ResumeIndexManifest | undefined;
  try {
    manifest = parseManifest(JSON.parse(content) as unknown);
  } catch {
    return undefined; // malformed derived data is rebuilt from canonical JSONL
  }
  if (!manifest) return undefined;
  const names = await readMarkerNames(projectDir);
  const sessionNames = await readCanonicalSessionNames(projectDir);
  if (
    names.length !== manifest.markerCount
    || digestMarkerNames(names) !== manifest.markerDigest
    || sessionNames.length !== manifest.sessionFileCount
    || digestMarkerNames(sessionNames) !== manifest.sessionFileDigest
  ) return undefined;
  const markers = await mapBatches(names, (name) => readMarker(projectDir, name));
  if (markers.some((marker) => marker === undefined || marker.state !== 'ready')) return undefined;
  const sourceMatches = await mapBatches(markers, async (marker) =>
    marker === undefined ? false : markerMatchesCanonical(projectDir, marker));
  if (sourceMatches.some((matches) => !matches)) return undefined;
  const indexedSessionNames = new Set(markers.flatMap((marker) =>
    marker?.state === 'ready' ? [`${marker.entry.id}.jsonl`] : []));
  const excludedNames = sessionNames.filter((name) => !indexedSessionNames.has(name));
  if (excludedNames.length !== manifest.excludedSourceCount) return undefined;
  const excludedFiles = await mapBatches(
    excludedNames,
    (name) => currentScannedFile(projectDir, name),
  );
  if (
    excludedFiles.some((file) => file === undefined)
    || digestScannedFiles(excludedFiles.flatMap((file) => file === undefined ? [] : [file]))
      !== manifest.excludedSourceDigest
  ) return undefined;
  return markers.flatMap((marker) => marker?.state === 'ready' ? [marker.entry] : []);
}

/** Add a pending marker before a new resumable canonical commit. */
export async function prepareResumeIndexEntry(
  projectDir: string,
  entry: ResumeIndexEntry,
): Promise<void> {
  try {
    await writeMarker(projectDir, entry, 'pending', false);
  } catch (error: unknown) {
    try {
      await invalidateManifest(projectDir);
    } catch (invalidateError: unknown) {
      throw new AggregateError(
        [error, invalidateError],
        `Unable to prepare or invalidate the resume index for ${entry.id}`,
      );
    }
    throw error;
  }
}

/** Remove membership only after a canonical session becomes non-resumable. */
export async function removeResumeIndexEntry(projectDir: string, id: string): Promise<boolean> {
  try {
    await fs.rm(markerPath(projectDir, id));
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function commitResumeIndexEntry(
  projectDir: string,
  entry: ResumeIndexEntry,
  resumable: boolean,
): Promise<void> {
  await withIndexPublishLock(projectDir, async () => {
    const source = await canonicalSource(projectDir, entry.id);
    if (resumable) {
      if (source === undefined) return;
      await writeMarker(projectDir, entry, 'ready', true, source);
    } else {
      await removeResumeIndexEntry(projectDir, entry.id);
    }
    await refreshCompleteManifestAfterCommit(projectDir, entry.id, resumable, source);
  });
}

async function refreshCompleteManifestAfterCommit(
  projectDir: string,
  id: string,
  resumable: boolean,
  source: ResumeMarker['source'] | undefined,
): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(manifestPath(projectDir), 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  let manifest: ResumeIndexManifest | undefined;
  try {
    manifest = parseManifest(JSON.parse(content) as unknown);
  } catch {
    return;
  }
  if (!manifest) return;

  const targetMarkerName = markerName(id);
  const targetSessionName = `${id}.jsonl`;
  if (resumable && manifest.markerNames.includes(targetMarkerName)) {
    return; // Only the positive marker source changed; the manifest topology is still complete.
  }
  const markerNames = new Set(manifest.markerNames);
  const sessionNames = new Set(manifest.sessionNames);
  const excludedSources = manifest.excludedSources.filter((file) => file.name !== targetSessionName);
  if (source === undefined) {
    sessionNames.delete(targetSessionName);
  } else {
    sessionNames.add(targetSessionName);
  }
  if (resumable) {
    markerNames.add(targetMarkerName);
  } else {
    markerNames.delete(targetMarkerName);
    if (source !== undefined) {
      excludedSources.push({
        name: targetSessionName,
        sourceSize: source.size,
        sourceMtimeMs: source.mtimeMs,
        sourceCtimeMs: source.ctimeMs,
        sourceDev: source.dev,
        sourceIno: source.ino,
      });
    }
  }
  await writeManifest(
    projectDir,
    [...markerNames],
    [...sessionNames],
    excludedSources,
  );
}

/** Complete a full scan without certifying a concurrent pending writer. */
export async function completeResumeIndex(
  projectDir: string,
  resumableEntries: readonly ResumeIndexScanEntry[],
  scannedFiles: readonly ResumeIndexScannedFile[],
): Promise<void> {
  await withIndexPublishLock(projectDir, () => completeResumeIndexWithLock(
    projectDir,
    resumableEntries,
    scannedFiles,
  ));
}

async function completeResumeIndexWithLock(
  projectDir: string,
  resumableEntries: readonly ResumeIndexScanEntry[],
  scannedFiles: readonly ResumeIndexScannedFile[],
): Promise<void> {
  const expectedSessionNames = scannedFiles.map((file) => file.name).sort();
  const expectedSessionDigest = digestMarkerNames(expectedSessionNames);
  const currentSessionNames = await readCanonicalSessionNames(projectDir);
  if (
    currentSessionNames.length !== expectedSessionNames.length
    || digestMarkerNames(currentSessionNames) !== expectedSessionDigest
    || !await scannedFilesStillMatch(projectDir, scannedFiles)
  ) return;
  // Only invalidate after proving this scan is still current. A queued stale
  // rebuild must not destroy a newer manifest published by a canonical writer.
  await invalidateManifest(projectDir);
  await fs.mkdir(indexDir(projectDir), { recursive: true });
  const scannedIds = new Set(resumableEntries.map((entry) => entry.id));
  const excludedFiles = scannedFiles.filter((file) =>
    !scannedIds.has(path.basename(file.name, '.jsonl')));
  for (const entry of resumableEntries) {
    await writeMarker(projectDir, entry, 'ready', true, {
      size: entry.sourceSize,
      mtimeMs: entry.sourceMtimeMs,
      ctimeMs: entry.sourceCtimeMs,
      dev: entry.sourceDev,
      ino: entry.sourceIno,
    });
  }
  const names = await readMarkerNames(projectDir);
  const markers = await mapBatches(names, (name) => readMarker(projectDir, name));
  await mapBatches(names, async (name, index) => {
    const marker = markers[index];
    if (marker === undefined || !scannedIds.has(marker.entry.id)) {
      await fs.rm(path.join(indexDir(projectDir), name), { force: true });
    }
  });
  const finalSessionNames = await readCanonicalSessionNames(projectDir);
  if (
    finalSessionNames.length !== expectedSessionNames.length
    || digestMarkerNames(finalSessionNames) !== expectedSessionDigest
    || !await scannedFilesStillMatch(projectDir, scannedFiles)
  ) return;
  const finalNames = await readMarkerNames(projectDir);
  const finalMarkers = await mapBatches(finalNames, (name) => readMarker(projectDir, name));
  if (
    finalMarkers.some((marker) => marker?.state !== 'ready')
    || finalMarkers.length !== scannedIds.size
    || finalMarkers.some((marker) => marker === undefined || !scannedIds.has(marker.entry.id))
  ) return;
  const finalSourcesMatch = await mapBatches(finalMarkers, async (marker) =>
    marker === undefined ? false : markerMatchesCanonical(projectDir, marker));
  if (finalSourcesMatch.some((matches) => !matches)) return;
  await writeManifest(projectDir, finalNames, expectedSessionNames, excludedFiles);
}
