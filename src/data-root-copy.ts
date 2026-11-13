import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, rename, rm, rmdir, utimes } from 'node:fs/promises';
import path from 'node:path';
import { isPathInsideDirectory } from '@kodax-ai/agent';
import {
  listRuntimeDaemonSlots,
  readRuntimeDaemonLockOwner,
  resolveRuntimeDaemonPathsFromConfigHome,
  runtimeOwnerProcessState,
} from './runtime-daemon/state.js';

/**
 * Entries under a data root that belong to one running Host or process, or to
 * this machine's sandbox, rather than to the user's data. Everything else is
 * portable, so new kinds of user data move without touching this list.
 * Paths are relative to the root and cover the whole subtree.
 */
const NON_PORTABLE_ENTRIES: readonly { readonly path: readonly string[]; readonly why: string }[] = [
  { path: ['runtime', 'daemon'], why: 'Host descriptor, token, lock, log, owner policy and client exit receipts of this root' },
  { path: ['runtime', 'processes'], why: 'live child-process records' },
  { path: ['sessions', '.product-host'], why: 'Session storage owner lock of the Host' },
  { path: ['instances'], why: 'per-process heartbeat directories' },
  { path: ['sandbox-runtime'], why: 'sandbox gate and ACL state bound to this machine and boot' },
  { path: ['native-text-state-v1'], why: 'trusted native state validated against its own directory ancestry' },
];
/** Coordination files and queues; a copied lock would block the new root. */
const LOCK_NAME = /\.lock(?:\.queue)?$/i;

export type KodaXDataRootCopyErrorCode =
  | 'source_missing'
  | 'target_invalid'
  | 'target_not_empty'
  | 'nested_roots'
  | 'host_running'
  | 'aborted';

export class KodaXDataRootCopyError extends Error {
  constructor(readonly code: KodaXDataRootCopyErrorCode, message: string) {
    super(message);
    this.name = 'KodaXDataRootCopyError';
  }
}

export interface CopyKodaXDataRootProgress {
  readonly files: number;
  readonly totalFiles: number;
  readonly bytes: number;
  readonly totalBytes: number;
}

export interface CopyKodaXDataRootSkipped {
  /** POSIX-style path relative to the root; only the topmost skipped entry is listed. */
  readonly path: string;
  readonly reason: 'non-portable' | 'excluded' | 'symlink' | 'unsupported';
}

export interface CopyKodaXDataRootOptions {
  /** The data root to copy (the `.kodax` directory itself). It is never modified. */
  readonly from: string;
  /** The new data root. It must not exist or must be an empty directory. */
  readonly to: string;
  /** Embedder-owned per-root state, as paths relative to the root, that must not be copied. */
  readonly exclude?: readonly string[];
  readonly onProgress?: (progress: CopyKodaXDataRootProgress) => void;
  readonly signal?: AbortSignal;
}

export interface CopyKodaXDataRootResult {
  readonly files: number;
  readonly bytes: number;
  readonly skipped: readonly CopyKodaXDataRootSkipped[];
}

interface PlannedEntry {
  readonly segments: readonly string[];
  readonly directory: boolean;
  readonly size: number;
  readonly mtime: Date;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

const comparable = (segments: readonly string[]): string =>
  (process.platform === 'win32' ? segments.map((segment) => segment.toLowerCase()) : segments).join('\0');

function liveOwner(lockFile: string): boolean {
  const owner = readRuntimeDaemonLockOwner(lockFile);
  // An owner whose liveness cannot be proven is treated as running.
  return owner !== undefined && runtimeOwnerProcessState(owner) !== 'gone';
}

/** Any Host slot or the Session storage owner still running means the files are in use. */
function assertNoLiveHost(root: string): void {
  const lockFiles = [
    ...listRuntimeDaemonSlots(root).map((slot) => resolveRuntimeDaemonPathsFromConfigHome(root, slot).lockFile),
    path.join(root, 'sessions', '.product-host', 'owner.lock'),
  ];
  if (lockFiles.some(liveOwner)) {
    throw new KodaXDataRootCopyError('host_running', `A Host is running on ${root}. Stop every client of this data root before copying it.`);
  }
}

/** Resolves links through the nearest existing ancestor so a not-yet-created target can be compared. */
async function resolveThroughExisting(target: string): Promise<string> {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch (error: unknown) {
      const parent = path.dirname(current);
      if (!['ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? '') || parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

async function assertTarget(to: string): Promise<boolean> {
  const stat = await lstat(to).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  });
  if (stat === undefined) return false;
  if (!stat.isDirectory()) throw new KodaXDataRootCopyError('target_invalid', `The target ${to} exists and is not a directory.`);
  if ((await readdir(to)).length > 0) throw new KodaXDataRootCopyError('target_not_empty', `The target ${to} is not empty.`);
  return true;
}

async function plan(
  source: string,
  excluded: readonly (readonly string[])[],
): Promise<{ readonly entries: PlannedEntry[]; readonly skipped: CopyKodaXDataRootSkipped[] }> {
  const rules = new Map<string, CopyKodaXDataRootSkipped['reason']>([
    ...NON_PORTABLE_ENTRIES.map((rule) => [comparable(rule.path), 'non-portable'] as const),
    ...excluded.map((segments) => [comparable(segments), 'excluded'] as const),
  ]);
  const entries: PlannedEntry[] = [];
  const skipped: CopyKodaXDataRootSkipped[] = [];
  const walk = async (directory: string, parent: readonly string[]): Promise<void> => {
    for (const dirent of await readdir(directory, { withFileTypes: true })) {
      const segments = [...parent, dirent.name];
      const skip = (reason: CopyKodaXDataRootSkipped['reason']): void => { skipped.push({ path: segments.join('/'), reason }); };
      const rule = rules.get(comparable(segments)) ?? (LOCK_NAME.test(dirent.name) ? 'non-portable' : undefined);
      if (rule !== undefined) skip(rule);
      else if (dirent.isSymbolicLink()) skip('symlink');
      else if (dirent.isDirectory()) {
        entries.push({ segments, directory: true, size: 0, mtime: new Date(0) });
        await walk(path.join(directory, dirent.name), segments);
      } else if (dirent.isFile()) {
        const stat = await lstat(path.join(directory, dirent.name));
        entries.push({ segments, directory: false, size: stat.size, mtime: stat.mtime });
      } else skip('unsupported');
    }
  };
  await walk(source, []);
  return { entries, skipped };
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new KodaXDataRootCopyError('aborted', 'The data root copy was aborted.');
}

/**
 * Copies a KodaX data root to a new location for relocation. The source is
 * only read. The copy is built in a sibling `<to>.copying` directory, which a
 * failed or aborted run removes and a later run replaces, and is renamed into
 * place only after the source is re-checked for a Host that started meanwhile.
 * Per-Host and per-process state is not copied (see NON_PORTABLE_ENTRIES), and
 * links are skipped so nothing outside the root is read.
 */
export async function copyKodaXDataRoot(options: CopyKodaXDataRootOptions): Promise<CopyKodaXDataRootResult> {
  const to = path.resolve(options.to);
  const source = await realpath(path.resolve(options.from)).catch((error: unknown) => {
    if (['ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? '')) {
      throw new KodaXDataRootCopyError('source_missing', `The data root ${options.from} does not exist.`);
    }
    throw error;
  });
  if (!(await lstat(source)).isDirectory()) {
    throw new KodaXDataRootCopyError('source_missing', `The data root ${options.from} is not a directory.`);
  }
  const target = await resolveThroughExisting(to);
  if (isPathInsideDirectory(target, source) || isPathInsideDirectory(source, target)) {
    throw new KodaXDataRootCopyError('nested_roots', 'The source and target data roots must not contain each other.');
  }
  assertNoLiveHost(source);
  const targetExists = await assertTarget(to);

  const { entries, skipped } = await plan(source, (options.exclude ?? []).map((entry) => entry.split(/[\\/]+/).filter(Boolean)));
  const totalFiles = entries.filter((entry) => !entry.directory).length;
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  const temporary = `${to}.copying`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  let files = 0;
  let bytes = 0;
  try {
    for (const entry of entries) {
      assertNotAborted(options.signal);
      const destination = path.join(temporary, ...entry.segments);
      if (entry.directory) {
        await mkdir(destination);
        continue;
      }
      await copyFile(path.join(source, ...entry.segments), destination, constants.COPYFILE_EXCL);
      await utimes(destination, entry.mtime, entry.mtime);
      files += 1;
      bytes += entry.size;
      options.onProgress?.({ files, totalFiles, bytes, totalBytes });
    }
    assertNotAborted(options.signal);
    assertNoLiveHost(source);
    if (targetExists) await rmdir(to);
    await rename(temporary, to);
  } catch (error: unknown) {
    await rm(temporary, { recursive: true, force: true }).catch((cleanup: unknown) => {
      throw new AggregateError([error, cleanup], `The data root copy failed and ${temporary} could not be removed.`);
    });
    throw error;
  }
  return { files, bytes, skipped };
}
