import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import fs from 'fs/promises';
import path from 'path';
import { emitKodaXDiagnostic, getAgentConfigPath } from '@kodax-ai/agent';
import { withFileMutation } from '../tools/_internal/file-mutation-queue.js';

const repoIntelligenceStorageDirContext = new AsyncLocalStorage<string | undefined>();

export async function safeReadJson<T>(
  filePath: string,
  validator?: (value: unknown) => value is T,
): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(content);
    if (validator && !validator(parsed)) {
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

export function debugLogRepoIntelligence(message: string, error?: unknown): void {
  if (!process.env.KODAX_DEBUG_REPO_INTELLIGENCE) {
    return;
  }
  emitKodaXDiagnostic({
    source: 'coding:repo-intelligence',
    level: 'debug',
    message,
    ...(error !== undefined ? { detail: error } : {}),
  });
}

export function withRepoIntelligenceStorageDir<T>(
  storageDir: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return repoIntelligenceStorageDirContext.run(storageDir?.trim() || undefined, work);
}

export function resolveRepoIntelligenceStorageDir(
  defaultStorageDir: string,
): string {
  return repoIntelligenceStorageDirContext.getStore()?.trim()
    || process.env[REPO_INTELLIGENCE_STORAGE_ENV]?.trim()
    || defaultStorageDir;
}

export const REPO_INTELLIGENCE_STORAGE_ENV = 'KODAX_REPO_INTELLIGENCE_STORAGE_DIR';

/**
 * The semantic index could not answer: it is still building (`warming`) or the
 * worker failed (`unavailable`). Callers must not read this as "nothing found".
 */
export class RepoIntelligenceUnavailableError extends Error {
  constructor(readonly status: 'warming' | 'unavailable', message: string) {
    super(message);
    this.name = 'RepoIntelligenceUnavailableError';
  }
}

/**
 * The worker ran the query and the query itself failed, for example because
 * nothing matched. Unlike a worker crash or timeout, this is a real answer.
 */
export class RepoIntelligenceQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoIntelligenceQueryError';
  }
}

/** The configured storage base, defaulting to the config home so the user's repository stays untouched. */
export function resolveRepoIntelligenceStorageBase(): string {
  return resolveRepoIntelligenceStorageDir(getAgentConfigPath('repo-intelligence'));
}

/**
 * Cache directory for one workspace. An absolute base holds one subdirectory per
 * workspace so different repositories never share files; a relative override is
 * the caller's explicit choice to keep the cache inside the workspace.
 */
export function resolveRepoIntelligenceStorageRoot(workspaceRoot: string): string {
  const base = resolveRepoIntelligenceStorageBase();
  if (!path.isAbsolute(base)) {
    return path.join(workspaceRoot, base);
  }
  return path.join(base, workspaceStorageKey(workspaceRoot));
}

function workspaceStorageKey(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  const identity = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const name = path.basename(resolved).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || 'workspace';
  return `${name}-${createHash('sha256').update(identity).digest('hex').slice(0, 12)}`;
}

// Orphan temp files older than this are from writes that never completed
// (the process was hard-killed between writeFile and rename, so the catch
// below never ran). A generous window keeps the sweep from ever touching a
// concurrent writer's in-flight temp, whose mtime is always near-now.
const STALE_TEMP_FILE_MS = 60 * 60 * 1000;

// Matches only the temp suffixes this module produces, so the sweep never
// deletes an unrelated sibling that merely shares the base name and a `.tmp`
// extension (e.g. a hypothetical `<base>.backup.tmp`). The two-part form keeps
// compatibility with stale temps produced before the per-process sequence was
// added.
const OWN_TEMP_SUFFIX = /^\d+\.\d+(?:\.\d+)?\.tmp$/;

let atomicWriteSequence = 0;

function nextAtomicTempPath(filePath: string): string {
  atomicWriteSequence = (atomicWriteSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${filePath}.${process.pid}.${Date.now()}.${atomicWriteSequence}.tmp`;
}

// Windows transiently fails `rename` with these codes when the target (or the
// temp source) is momentarily locked by AV / the search indexer / a concurrent
// reader — the exact "locked by a concurrent reader" case noted below, and the
// source of rare full-suite flakes (EPERM on the rename of a cache file). These
// clear within milliseconds, so a few short retries recover; a genuinely
// permanent failure (e.g. target is a directory → EISDIR/ENOTEMPTY, or EPERM
// that never clears) still surfaces after the retry budget is spent.
const RENAME_TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameWithRetry(from: string, to: string): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (attempt >= maxAttempts || !code || !RENAME_TRANSIENT_CODES.has(code)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 20));
    }
  }
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await withFileMutation(filePath, async () => {
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true });
    const tempPath = nextAtomicTempPath(filePath);
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await renameWithRetry(tempPath, filePath);
    } catch (error) {
      // The write or rename failed (e.g. Windows EPERM when the target is
      // locked by a concurrent reader). Remove our own temp so failed writes
      // don't accumulate one orphan `.tmp` each, then surface the error.
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
    // Best-effort mop-up of stale orphans left by writes that were hard-killed
    // before the catch above could run. Never lets a sweep failure break the
    // write that just succeeded.
    await sweepStaleTempFiles(directory, path.basename(filePath)).catch(() => {});
  });
}

/** Create a computed cache root through the same hard boundary as file tools. */
export async function ensureRepoIntelligenceStorageDir(storageRoot: string): Promise<void> {
  await withFileMutation(storageRoot, async () => {
    await fs.mkdir(storageRoot, { recursive: true });
  });
}

/** Verify a computed cache root without bypassing the host mutation fence. */
export async function probeRepoIntelligenceStorage(
  storageRoot: string,
  probePath: string,
): Promise<void> {
  await withFileMutation(probePath, async () => {
    await fs.mkdir(storageRoot, { recursive: true });
    try {
      await fs.writeFile(probePath, 'ok', 'utf8');
    } finally {
      await fs.rm(probePath, { force: true });
    }
  });
}

async function sweepStaleTempFiles(
  directory: string,
  baseName: string,
): Promise<void> {
  const prefix = `${baseName}.`;
  const now = Date.now();
  // Normally a no-op cost: after the backlog clears, readdir finds zero
  // matching temps, so this is one readdir per successful write and no stats.
  const entries = await fs.readdir(directory);
  await Promise.all(
    entries
      .filter(
        (name) =>
          name.startsWith(prefix) && OWN_TEMP_SUFFIX.test(name.slice(prefix.length)),
      )
      .map(async (name) => {
        const fullPath = path.join(directory, name);
        try {
          const info = await fs.stat(fullPath);
          if (now - info.mtimeMs >= STALE_TEMP_FILE_MS) {
            await fs.rm(fullPath, { force: true });
          }
        } catch {
          // Raced another sweeper or the owning writer — ignore.
        }
      }),
  );
}
