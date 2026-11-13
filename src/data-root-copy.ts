import { constants, createReadStream, existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, realpath, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises';
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
  { path: ['processes'], why: 'legacy location of live child-process records' },
  { path: ['sessions', '.product-host'], why: 'Session storage owner lock of the Host' },
  { path: ['instances'], why: 'per-process heartbeat directories' },
  { path: ['sandbox-runtime'], why: 'sandbox gate and ACL state bound to this machine and boot' },
  { path: ['native-text-state-v1'], why: 'trusted native state validated against its own directory ancestry' },
];
/** Coordination files and queues; a copied lock would block the new root. */
const LOCK_NAME = /\.lock(?:\.queue)?$/i;

/**
 * Present in the target from the first copied file until the copy is published.
 * A target holding it was left by an interrupted copy. Nothing proves which files
 * in it that copy wrote, so the target is refused rather than cleared.
 */
export const KODAX_DATA_ROOT_COPY_MARKER = '.kodax-copy-incomplete';
/** Files the OS or file manager puts in a fresh folder or at the top of a drive; never user data. */
const HOUSEKEEPING_ENTRIES = new Set([
  '.ds_store', 'desktop.ini', 'thumbs.db', 'lost+found', '$recycle.bin', 'system volume information',
  '.spotlight-v100', '.fseventsd', '.trashes', '.temporaryitems',
]);
const isHousekeeping = (name: string): boolean => HOUSEKEEPING_ENTRIES.has(name.toLowerCase());

export type KodaXDataRootCopyErrorCode =
  | 'source_missing'
  | 'target_invalid'
  | 'target_not_empty'
  | 'target_incomplete'
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
  /** JSON / JSONL files in which paths into the old root were rewritten to the new root. */
  readonly rebasedFiles: number;
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

/**
 * A lock that cannot be read (another KodaX version, a write in progress) or whose
 * owner is not provably gone counts as running, as it does for the Host itself.
 */
function liveOwner(lockFile: string): boolean {
  if (!existsSync(lockFile)) return false;
  const owner = readRuntimeDaemonLockOwner(lockFile);
  return owner === undefined || runtimeOwnerProcessState(owner) !== 'gone';
}

/** Any Host slot or the Session storage owner still running means the files are in use. */
function assertNoLiveHost(root: string): void {
  const lockFiles = [
    ...listRuntimeDaemonSlots(root).map((slot) => resolveRuntimeDaemonPathsFromConfigHome(root, slot).lockFile),
    path.join(root, 'sessions', '.product-host', 'owner.lock'),
  ];
  const live = lockFiles.find(liveOwner);
  if (live !== undefined) {
    throw new KodaXDataRootCopyError('host_running', `A Host is running on ${root} (${live}). Stop every client of this data root before copying it.`);
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

/**
 * Removes the top-level entries this copy created, then the marker; anything else
 * that appeared in the target meanwhile stays. A target the copy created goes too
 * once it is empty.
 */
async function removeCopy(to: string, names: readonly string[], created: boolean): Promise<void> {
  for (const name of names) await rm(path.join(to, name), { recursive: true, force: true });
  // The marker goes last so a cleanup that fails halfway still shows an interrupted copy.
  await rm(path.join(to, KODAX_DATA_ROOT_COPY_MARKER), { force: true });
  if (!created) return;
  await rmdir(to).catch((error: unknown) => {
    if (errorCode(error) !== 'ENOTEMPTY') throw error;
  });
}

/**
 * Accepts a missing target or an empty one (OS housekeeping files aside).
 * Returns whether the directory existed.
 */
async function prepareTarget(to: string): Promise<boolean> {
  const info = await stat(to).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  });
  if (info === undefined) return false;
  if (!info.isDirectory()) throw new KodaXDataRootCopyError('target_invalid', `The target ${to} exists and is not a directory.`);
  const names = (await readdir(to)).filter((name) => !isHousekeeping(name));
  if (names.includes(KODAX_DATA_ROOT_COPY_MARKER)) {
    throw new KodaXDataRootCopyError('target_incomplete', `The target ${to} holds an interrupted copy. Delete it or choose another folder.`);
  }
  if (names.length > 0) throw new KodaXDataRootCopyError('target_not_empty', `The target ${to} is not empty.`);
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

/** Stores whose text may hold absolute paths into their own root (KodaX and embedder state is JSON). */
const REBASED_EXTENSIONS = new Set(['.json', '.jsonl']);
/** A match followed by one of these is part of a longer name (`.kodax2`), not the root. */
const NAME_CHAR = String.raw`[\p{L}\p{N}._~$@#%+=-]`;
/**
 * A match preceded by a name character is the tail of a longer path. Argument
 * syntax such as `--root=` or `@` may come right before a root, and a POSIX root
 * after another directory (`/mirror/home/…`) is not the root either.
 */
const leadingBoundary = (form: string): string =>
  String.raw`(?<![\p{L}\p{N}._~${form.startsWith('/') ? '/' : ''}-])`;

interface RootRebase {
  readonly pattern: RegExp;
  /** Replacement for a Windows path written in JSON, where every backslash is doubled. */
  readonly backslashed: string;
  readonly slashed: string;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Stored data keeps absolute paths into its own root: MCPB install folders and launch
 * arguments, session image and tool-output paths, workflow snapshots and more. The copy
 * rewrites them in the JSON text itself, which keeps formatting and every other byte.
 * A Windows path appears there with doubled backslashes, and any path may also be
 * written with forward slashes. A drive root is not rebased: it would match every path
 * on the drive, including project folders that are not data.
 */
function rootRebase(sourceForms: readonly string[], to: string): RootRebase | null {
  if (sourceForms.some((form) => path.dirname(form) === form)) return null;
  const windows = process.platform === 'win32';
  const forms = new Set<string>();
  for (const form of sourceForms) {
    forms.add(form.replaceAll('\\', '/'));
    if (windows) forms.add(form.replaceAll('\\', '\\\\'));
  }
  const alternatives = [...forms]
    .sort((a, b) => b.length - a.length)
    .map((form) => leadingBoundary(form) + escapeRegExp(form))
    .join('|');
  const flags = windows || process.platform === 'darwin' ? 'giu' : 'gu';
  return {
    pattern: new RegExp(`(?:${alternatives})(?!${NAME_CHAR})`, flags),
    backslashed: to.replaceAll('\\', '\\\\'),
    slashed: to.replaceAll('\\', '/'),
  };
}

/**
 * Copies one JSON / JSONL store with paths into the old root rewritten, and reports
 * whether anything changed. A file that is not valid UTF-8 is copied byte for byte.
 */
async function copyRebased(from: string, to: string, rebase: RootRebase): Promise<boolean> {
  const replace = (match: string): string => (match.includes('\\') ? rebase.backslashed : rebase.slashed);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const output = await open(to, 'wx');
  let changed = false;
  let invalidText = false;
  const write = async (text: string): Promise<void> => {
    const rebased = text.replace(rebase.pattern, replace);
    changed ||= rebased !== text;
    await output.write(rebased);
  };
  try {
    let carry = '';
    for await (const chunk of createReadStream(from)) {
      const text = carry + decoder.decode(chunk as Buffer, { stream: true });
      // JSON escapes newlines inside strings, so a path never spans a line break.
      const end = text.lastIndexOf('\n') + 1;
      carry = text.slice(end);
      await write(text.slice(0, end));
    }
    await write(carry + decoder.decode());
  } catch (error: unknown) {
    if (errorCode(error) !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw error;
    invalidText = true;
  } finally {
    await output.close();
  }
  if (!invalidText) return changed;
  await copyFile(from, to);
  return false;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new KodaXDataRootCopyError('aborted', 'The data root copy was aborted.');
}

/** Creates one planned entry exclusively; returns whether paths in it were rebased. */
async function copyEntry(source: string, to: string, entry: PlannedEntry, rebase: RootRebase | null): Promise<boolean> {
  const destination = path.join(to, ...entry.segments);
  if (entry.directory) {
    await mkdir(destination);
    return false;
  }
  const from = path.join(source, ...entry.segments);
  let rebased = false;
  if (rebase !== null && REBASED_EXTENSIONS.has(path.extname(destination).toLowerCase())) {
    rebased = await copyRebased(from, destination, rebase);
  } else {
    await copyFile(from, destination, constants.COPYFILE_EXCL);
  }
  await utimes(destination, entry.mtime, entry.mtime);
  return rebased;
}

/**
 * Copies the planned entries in order and records in `written` every top-level
 * name this run created, so a failure removes exactly that. Creation is exclusive:
 * a name that already existed (EEXIST) belongs to someone else and is not recorded.
 */
async function copyEntries(
  source: string,
  to: string,
  entries: readonly PlannedEntry[],
  rebase: RootRebase | null,
  written: string[],
  options: CopyKodaXDataRootOptions,
): Promise<Omit<CopyKodaXDataRootResult, 'skipped'>> {
  const totalFiles = entries.filter((entry) => !entry.directory).length;
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  let files = 0;
  let bytes = 0;
  let rebasedFiles = 0;
  for (const entry of entries) {
    assertNotAborted(options.signal);
    const topLevel = entry.segments.length === 1 ? entry.segments[0] : undefined;
    const rebased = await copyEntry(source, to, entry, rebase).catch((error: unknown) => {
      if (topLevel !== undefined && errorCode(error) !== 'EEXIST') written.push(topLevel);
      throw error;
    });
    if (topLevel !== undefined) written.push(topLevel);
    if (entry.directory) continue;
    if (rebased) rebasedFiles += 1;
    files += 1;
    bytes += entry.size;
    options.onProgress?.({ files, totalFiles, bytes, totalBytes });
  }
  return { files, bytes, rebasedFiles };
}

/**
 * Copies a KodaX data root to a new location for relocation. The source is
 * only read. The copy is assembled inside the target, which therefore works for
 * a drive root or a mount point. KODAX_DATA_ROOT_COPY_MARKER stays in the target
 * until the source has been re-checked for a Host that started meanwhile; a
 * failed or aborted run removes what it wrote, and the target of a crashed run
 * is refused until the user deletes it. OS housekeeping files in the target are
 * left alone.
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
  const targetExisted = await prepareTarget(to);

  const { entries, skipped } = await plan(source, (options.exclude ?? []).map((entry) => entry.split(/[\\/]+/).filter(Boolean)));
  await mkdir(to, { recursive: true });
  await writeFile(path.join(to, KODAX_DATA_ROOT_COPY_MARKER), '', { flag: 'wx' });
  const rebase = rootRebase([path.resolve(options.from), source], to);
  const written: string[] = [];
  try {
    const copied = await copyEntries(source, to, entries, rebase, written, options);
    assertNotAborted(options.signal);
    assertNoLiveHost(source);
    await rm(path.join(to, KODAX_DATA_ROOT_COPY_MARKER));
    return { ...copied, skipped };
  } catch (error: unknown) {
    await removeCopy(to, written, !targetExisted).catch((cleanup: unknown) => {
      throw new AggregateError([error, cleanup], `The data root copy failed and the partial copy in ${to} could not be removed.`);
    });
    throw error;
  }
}
