import { constants, type Dir, type BigIntStats } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { lstat, open, opendir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runtimeOwnerProcessState, tryAcquireRuntimeLockMaintenance,
  type RuntimeDaemonLockOwner, type RuntimeDaemonPaths } from './state.js';

export interface RuntimeDaemonMaintenanceResult {
  readonly scanned: number;
  readonly removed: number;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const OWNER_TEMPORARY = new RegExp(`^daemon\\.lock\\.${UUID}\\.tmp$`, 'i');
const STATE_TEMPORARY = new RegExp(`^daemon\\.json\\.([1-9][0-9]{0,9})\\.${UUID}\\.tmp$`, 'i');

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function readSnapshot(file: string): Promise<{ raw: Buffer; stat: BigIntStats } | undefined> {
  try {
    const before = await lstat(file, { bigint: true });
    if (!before.isFile() || before.size > 65_536n) return undefined;
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameFile(before, opened)) return undefined;
      const buffer = Buffer.alloc(Number(opened.size) + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (BigInt(bytesRead) !== opened.size) return undefined;
      const raw = buffer.subarray(0, bytesRead);
      if (!isUtf8(raw)) return undefined;
      const after = await handle.stat({ bigint: true });
      return sameFile(opened, after) ? { raw, stat: after } : undefined;
    } finally { await handle.close(); }
  } catch (error: unknown) {
    // Concurrent removal or a symlink swap cannot authorize deletion.
    if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}

function parseRecord(raw: Buffer): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function publicationPid(name: string, raw: Buffer, profile: string): number | undefined {
  const record = parseRecord(raw);
  if (!record || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0
    || typeof record.runtimeId !== 'string' || record.runtimeId.length === 0 || record.runtimeId.length > 256) return undefined;
  const state = STATE_TEMPORARY.exec(name);
  if (state) {
    return record.pid === Number(state[1]) && record.profile === profile
      && typeof record.startedAt === 'string' && Number.isFinite(Date.parse(record.startedAt))
      && typeof record.endpoint === 'string' && record.endpoint.length > 0
      && typeof record.version === 'string' && record.version.length > 0
      && ['starting', 'ready', 'draining', 'stopping', 'unhealthy', 'crashed'].includes(String(record.status))
      ? Number(record.pid) : undefined;
  }
  if (!OWNER_TEMPORARY.test(name) || typeof record.processStartIdentity !== 'string'
    || record.processStartIdentity.length === 0 || record.processStartIdentity.length > 512
    || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) return undefined;
  return Number(record.pid);
}

async function stillOwnsProfile(paths: RuntimeDaemonPaths, owner: RuntimeDaemonLockOwner): Promise<boolean> {
  const snapshot = await readSnapshot(paths.lockFile);
  return snapshot !== undefined && isDeepStrictEqual(parseRecord(snapshot.raw), owner);
}

async function removeAbandonedPublication(
  paths: RuntimeDaemonPaths, owner: RuntimeDaemonLockOwner, name: string, signal?: AbortSignal,
): Promise<boolean> {
  const file = path.join(paths.rootDir, name);
  const observed = await readSnapshot(file);
  const pid = observed && publicationPid(name, observed.raw, paths.profile);
  // Background housekeeping uses the cheap PID probe only. Reused or unverified
  // PIDs retain their temporary files without synchronous OS identity queries.
  if (pid === undefined || runtimeOwnerProcessState({ pid }) !== 'gone' || signal?.aborted) return false;
  const release = tryAcquireRuntimeLockMaintenance(paths.lockFile);
  if (!release) return false;
  try {
    const current = await readSnapshot(file);
    if (!current || !current.raw.equals(observed!.raw) || !sameFile(current.stat, observed!.stat)
      || signal?.aborted || !await stillOwnsProfile(paths, owner)
      || runtimeOwnerProcessState({ pid }) !== 'gone') return false;
    const final = await lstat(file, { bigint: true });
    if (!final.isFile() || !sameFile(final, current.stat) || signal?.aborted) return false;
    await unlink(file);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  } finally { release(); }
}

export function createRuntimeDaemonMaintenance(paths: RuntimeDaemonPaths, owner: RuntimeDaemonLockOwner): {
  runOnce(signal?: AbortSignal): Promise<RuntimeDaemonMaintenanceResult>;
  close(): Promise<void>;
} {
  let directory: Dir | undefined;
  let closed = false;
  let pending: Promise<RuntimeDaemonMaintenanceResult> | undefined;
  const closeDirectory = async (): Promise<void> => {
    const current = directory;
    directory = undefined;
    await current?.close();
  };
  const sweep = async (signal?: AbortSignal): Promise<RuntimeDaemonMaintenanceResult> => {
    const result = { scanned: 0, removed: 0 };
    if (closed || signal?.aborted) return result;
    if (!await stillOwnsProfile(paths, owner)) { closed = true; await closeDirectory(); return result; }
    directory ??= await opendir(paths.rootDir, { bufferSize: 32 });
    while (result.scanned < 32 && !closed && !signal?.aborted) {
      const entry = await directory.read().catch(async (error: unknown) => {
        try { await closeDirectory(); }
        catch (closeError: unknown) {
          throw new AggregateError([error, closeError], 'Runtime maintenance and directory close failed.');
        }
        throw error;
      });
      if (!entry) { await closeDirectory(); break; }
      result.scanned += 1;
      if (entry.isFile() && (OWNER_TEMPORARY.test(entry.name) || STATE_TEMPORARY.test(entry.name))
        && await removeAbandonedPublication(paths, owner, entry.name, signal)) result.removed += 1;
    }
    return result;
  };
  return {
    runOnce(signal) {
      if (!pending) pending = sweep(signal).finally(() => { pending = undefined; });
      return pending;
    },
    async close() { closed = true; try { await pending; } finally { await closeDirectory(); } },
  };
}
