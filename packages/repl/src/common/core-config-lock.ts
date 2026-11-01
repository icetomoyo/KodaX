import {
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  linkSync,
  renameSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export class CoreConfigWriteConflictError extends Error {
  constructor(configPath: string, lockPath = coreConfigWriteLockPath(configPath)) {
    super(`Core configuration lock is busy or its ownership cannot be safely recovered: ${configPath}. Retained lock: ${lockPath}. Use kodax doctor for offline recovery guidance; never remove a lock while shared writers may be active.`);
    this.name = 'CoreConfigWriteConflictError';
  }
}

// Only releases whose action has finished in this module may be retried while
// their PID is still alive. Never adopt an arbitrary same-PID or unknown lock.
const inactiveReleases = new Map<string, string>();

function retryInactiveRelease(lockPath: string): void {
  const raw = inactiveReleases.get(lockPath);
  if (raw === undefined) return;
  try {
    if (readFileSync(lockPath, 'utf8') === raw) rmSync(lockPath);
  } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  inactiveReleases.delete(lockPath);
}

export function coreConfigWriteLockPath(configPath: string): string {
  return `${configPath}.write.lock`;
}

/** Caller owns the config write lock; publish the whole replacement or retain the old bytes. */
export function writeCoreConfigAtomically(file: string, raw: string): void {
  // Previous direct writes followed an explicitly configured file symlink.
  // Keep that entry point while publishing atomically beside the real target.
  let symbolic = false;
  try { symbolic = lstatSync(file).isSymbolicLink(); }
  catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  if (symbolic) file = realpathSync(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, raw); fsyncSync(fd);
    const closing = fd; fd = undefined; closeSync(closing);
    renameSync(temporary, file);
  } finally {
    try { if (fd !== undefined) closeSync(fd); }
    finally { rmSync(temporary, { force: true }); }
  }
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function publish(lockPath: string, raw: string): boolean {
  const temporary = `${lockPath}.${randomUUID()}.tmp`;
  let fd: number | undefined, published = false;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, raw); fsyncSync(fd);
    const closing = fd; fd = undefined; closeSync(closing);
    try { linkSync(temporary, lockPath); published = true; }
    catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
    return published;
  } finally {
    try {
      try { if (fd !== undefined) closeSync(fd); }
      finally { rmSync(temporary, { force: true }); }
    }
    catch (error) {
      // No action has started: abandon only the exact record we published.
      if (published && readFileSync(lockPath, 'utf8') === raw) {
        try { rmSync(lockPath); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Configuration lock cleanup failed.'); }
      }
      throw error;
    }
  }
}

function reclaim(lockPath: string): boolean {
  let raw: string, owner: { version?: unknown; pid?: unknown; nonce?: unknown };
  try { raw = readFileSync(lockPath, 'utf8'); owner = JSON.parse(raw) as typeof owner; }
  catch (error) { if (errorCode(error) === 'ENOENT') return true; return false; }
  if (!owner || owner.version !== 1 || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0
    || typeof owner.nonce !== 'string' || !owner.nonce) return false;
  try { process.kill(owner.pid as number, 0); return false; }
  catch (error) { if (errorCode(error) !== 'ESRCH') return false; }
  // A generation has one non-transferable deletion claim. Keep its tombstone:
  // a delayed second reclaimer must never unlink a replacement writer's lock.
  if (!claimConfigLockReclamation(lockPath, owner.nonce)) return false;
  if (readFileSync(lockPath, 'utf8') !== raw) return false;
  rmSync(lockPath);
  return true;
}

/** One deletion claimant per retired generation; never remove these tombstones online. */
export function claimConfigLockReclamation(lockPath: string, generation: string): boolean {
  const claim = `${lockPath}.reclaim.${createHash('sha256').update(generation).digest('hex')}`;
  return publish(claim, JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
}

/** Internal shared boundary for core and integration config writers; old lock paths stay honored. */
export function withConfigWriteLock<T>(configPath: string, lockPath: string, action: () => T): T {
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  retryInactiveRelease(lockPath);
  const raw = JSON.stringify({ version: 1, pid: process.pid, nonce: randomUUID() });
  if (!publish(lockPath, raw) && (!reclaim(lockPath) || !publish(lockPath, raw))) {
    throw new CoreConfigWriteConflictError(configPath, lockPath);
  }
  let actionError: unknown;
  try { return action(); }
  catch (error) { actionError = error; throw error; }
  finally {
    try {
      inactiveReleases.set(lockPath, raw);
      if (readFileSync(lockPath, 'utf8') !== raw) throw new CoreConfigWriteConflictError(configPath, lockPath);
      rmSync(lockPath);
      inactiveReleases.delete(lockPath);
    } catch (error) {
      if (actionError !== undefined) throw new AggregateError([actionError, error], 'Configuration write and lock release failed.');
      throw error;
    }
  }
}

export function withCoreConfigWriteLock<T>(
  configPath: string,
  action: () => T,
): T {
  return withConfigWriteLock(configPath, coreConfigWriteLockPath(configPath), action);
}
