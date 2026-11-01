import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export interface StorageFileLock { readonly path: string; assertOwned(): void; release(): void; }
const inactive = new Map<string, string>();
function missing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
function read(file: string): string | undefined {
  try {
    const entry = fs.lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 16 * 1024) return undefined;
    return fs.readFileSync(file, 'utf8');
  } catch (error) { if (missing(error)) return undefined; throw error; }
}
function publish(file: string, raw: string): boolean {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle: number | undefined, published = false;
  let failure: unknown;
  try {
    handle = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(handle, raw); fs.fsyncSync(handle);
    const closing = handle; handle = undefined; fs.closeSync(closing);
    try { fs.linkSync(temporary, file); published = true; }
    catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error; }
    return published;
  } catch (error) { failure = error; throw error; }
  finally {
    try {
      try { if (handle !== undefined) fs.closeSync(handle); }
      finally { fs.rmSync(temporary, { force: true }); }
    } catch (error) {
      // No caller has entered its critical section yet.
      const errors: unknown[] = failure === undefined ? [error] : [failure, error];
      if (published) {
        inactive.set(file, raw);
        try { release(file, raw); } catch (rollback) { errors.push(rollback); }
      }
      throw new AggregateError(errors, `Storage lock publication cleanup failed: ${file}`);
    }
  }
}
function release(file: string, raw: string): void {
  inactive.set(file, raw);
  try {
    const current = read(file);
    if (current !== raw) {
      inactive.delete(file);
      if (!fs.existsSync(file)) return;
      throw new Error(`Storage lock ownership changed; retained: ${file}`);
    }
    fs.unlinkSync(file); inactive.delete(file);
  } catch (error) { if (missing(error)) { inactive.delete(file); return; } throw error; }
}
function deadOwner(raw: string, legacyPidRecord: boolean): boolean {
  let owner: unknown;
  try { owner = JSON.parse(raw); } catch { return false; }
  const pid = legacyPidRecord && Number.isSafeInteger(owner) ? owner
    : owner && typeof owner === 'object' && 'version' in owner && owner.version === 1
      && 'token' in owner && typeof owner.token === 'string' && owner.token.length > 0 && 'pid' in owner ? owner.pid : undefined;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'; }
}

/** Complete owner publication; unknown locks and reclamation claims are never transferred by age. */
export function tryAcquireStorageFileLock(file: string, options: { legacyPidRecord?: boolean } = {}): StorageFileLock | undefined {
  file = path.resolve(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const previousRelease = inactive.get(file);
  if (previousRelease !== undefined) release(file, previousRelease);
  const raw = JSON.stringify({ version: 1, pid: process.pid, token: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!fs.existsSync(file) && publish(file, raw)) {
      let released = false;
      return { path: file,
        assertOwned() { if (released || read(file) !== raw) throw new Error(`Storage lock ownership changed: ${file}`); },
        release() { if (released) return; release(file, raw); released = true; } };
    }
    const previous = read(file);
    if (attempt !== 0 || previous === undefined || !deadOwner(previous, options.legacyPidRecord === true)) return undefined;
    const claim = `${file}.reclaim.${createHash('sha256').update(previous).digest('hex')}`;
    if (!publish(claim, raw) || read(file) !== previous) return undefined;
    fs.unlinkSync(file); // The unique generation claim remains as a tombstone.
  }
  return undefined;
}

export async function withStorageFileLock<T>(file: string, operation: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lock: StorageFileLock | undefined;
  while (!(lock = tryAcquireStorageFileLock(file))) {
    if (Date.now() >= deadline) throw new Error(`Storage is busy or lock ownership is unknown; retain and inspect: ${file}`);
    await delay(10);
  }
  let failure: unknown;
  try { return await operation(); }
  catch (error) { failure = error; throw error; }
  finally {
    try { lock.release(); }
    catch (error) { throw new AggregateError(failure === undefined ? [error] : [failure, error], `Storage lock release failed: ${file}`); }
  }
}
