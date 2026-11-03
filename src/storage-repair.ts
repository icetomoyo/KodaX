import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { tryAcquireStorageFileLock, validateExtensionStoreSnapshot, type StorageFileLock } from '@kodax-ai/agent';
import { parseRuntimeAgentEventLedger, parseRuntimeAgentTaskSnapshot } from './runtime-agent-store.js';
import { parseA2ATaskStoreSnapshot } from './a2a/task-store.js';
import { inspectDoctorLocks } from './doctor-storage.js';
import { readRuntimeDaemonLockOwner, tryAcquireRuntimeLockMaintenance } from './runtime-daemon/state.js';

export type StorageRepairTarget =
  | { readonly kind: 'runtime-agent-ledger' | 'runtime-agent-snapshot'; readonly root: string; readonly taskId: string }
  | { readonly kind: 'extension' | 'a2a'; readonly root: string }
  | { readonly kind: 'lock'; readonly root: string; readonly path: string };
interface Snapshot { type: 'file' | 'directory'; sha256: string; bytes: number; dev: number; ino: number; mtimeMs: number; }
export interface StorageRepairPlan {
  readonly version: 1; readonly id: string; readonly target: StorageRepairTarget;
  readonly file: string; readonly source: Snapshot;
  readonly diagnosis: { state: string; validPrefixBytes?: number };
}
export interface StorageRepairReceipt {
  readonly version: 1; readonly plan: StorageRepairPlan; readonly backup: string;
  readonly candidateSha256?: string; readonly fence?: string; readonly completed: boolean;
  readonly reclamationClaim?: string;
  readonly verified?: true;
}
const ownedRepairClaims = new Map<string, { planId: string; raw: Buffer; active: boolean }>();
const MAX_BYTES = 64 * 1024 * 1024;
const hash = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
function missing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
function assertPath(root: string, file: string): void {
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Storage repair path escapes its declared root.');
  const absolute = path.resolve(file), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Storage repair refuses filesystem aliases.'); }
    catch (error) { if (!missing(error)) throw error; }
  }
}
function readSnapshot(root: string, file: string, directory = false): { snapshot: Snapshot; bytes: Buffer } {
  assertPath(root, file);
  const entry = fs.lstatSync(file);
  if (entry.isDirectory()) {
    if (!directory || fs.readdirSync(file).some(name => name !== 'owner.json')) throw new Error('Storage repair refuses directories with unexpected contents.');
    let bytes: Buffer = Buffer.alloc(0);
    try { bytes = readSnapshot(root, path.join(file, 'owner.json')).bytes; }
    catch (error) { if (!missing(error)) throw error; }
    return { snapshot: { type: 'directory', sha256: hash(Buffer.concat([Buffer.from('directory\0'), bytes])),
      bytes: bytes.length, dev: entry.dev, ino: entry.ino, mtimeMs: entry.mtimeMs }, bytes };
  }
  if (!entry.isFile() || entry.size > MAX_BYTES) throw new Error('Storage repair requires a regular file within the inspection limit.');
  const handle = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(handle);
    if (before.dev !== entry.dev || before.ino !== entry.ino || before.size > MAX_BYTES) throw new Error('Storage changed during inspection.');
    const bytes = Buffer.alloc(before.size + 1);
    const count = fs.readSync(handle, bytes, 0, bytes.length, 0), after = fs.fstatSync(handle);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Storage changed during inspection.');
    const raw = bytes.subarray(0, count);
    return { snapshot: { type: 'file', sha256: hash(raw), bytes: count, dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs }, bytes: raw };
  } finally { fs.closeSync(handle); }
}
function normalizeTarget(target: StorageRepairTarget): StorageRepairTarget {
  if (!target || !['runtime-agent-ledger', 'runtime-agent-snapshot', 'extension', 'a2a', 'lock'].includes(target.kind)
    || typeof target.root !== 'string' || !path.isAbsolute(target.root)) throw new Error('Invalid storage repair target.');
  const root = path.resolve(target.root);
  if (target.kind === 'runtime-agent-ledger' || target.kind === 'runtime-agent-snapshot') {
    if (typeof target.taskId !== 'string' || !target.taskId) throw new Error('Runtime ledger repair requires a task ID.');
    return { kind: target.kind, root, taskId: target.taskId };
  }
  if (target.kind === 'lock') {
    if (typeof target.path !== 'string' || !path.isAbsolute(target.path)) throw new Error('Lock repair requires an exact absolute path.');
    return { kind: target.kind, root, path: path.resolve(target.path) };
  }
  return { kind: target.kind, root };
}
function targetFiles(input: StorageRepairTarget, retainedLock = false): { file: string; lock: string; fence?: string } {
  const target = normalizeTarget(input), root = target.root;
  if (target.kind === 'runtime-agent-ledger' || target.kind === 'runtime-agent-snapshot') {
    const directory = path.join(root, 'tasks', hash(target.taskId));
    return { file: path.join(directory, target.kind === 'runtime-agent-ledger' ? 'events.jsonl' : 'snapshot.json'),
      lock: path.join(root, '.store.lock'), fence: path.join(directory, '.repair-fence') };
  }
  if (target.kind === 'lock') {
    if (typeof target.path !== 'string' || !path.isAbsolute(target.path)) throw new Error('Lock repair requires an exact absolute path.');
    assertPath(root, target.path);
    if (!retainedLock && !inspectDoctorLocks(root).items.some(item => item.path === target.path && item.state === 'present')) throw new Error('Lock is outside the diagnosed repair inventory.');
    return { file: target.path, lock: `${target.path}.offline-repair.lock` };
  }
  const file = path.join(root, target.kind === 'a2a' ? 'tasks.json' : 'store.jsonl');
  return { file, lock: target.kind === 'a2a' ? path.join(root, '.server.lock') : `${file}.lock`, fence: `${file}.repair-fence` };
}
function decode(bytes: Uint8Array): string { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
function validate(target: StorageRepairTarget, bytes: Buffer): void {
  try {
    const raw = decode(bytes);
    if (target.kind === 'runtime-agent-ledger') parseRuntimeAgentEventLedger(raw, target.taskId);
    else if (target.kind === 'runtime-agent-snapshot') parseRuntimeAgentTaskSnapshot(raw, target.taskId);
    else if (target.kind === 'extension') validateExtensionStoreSnapshot(raw);
    else if (target.kind === 'a2a') parseA2ATaskStoreSnapshot(raw);
  } catch { throw new Error(`Invalid recovery candidate for ${target.kind}; original bytes retained.`); }
}
function parseMetadata<T>(bytes: Buffer): T {
  try {
    const value: unknown = JSON.parse(decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid metadata shape.');
    return value as T;
  }
  catch { throw new Error('Invalid storage repair metadata; retain the receipt and original files.'); }
}
function assertRepairFence(root: string, file: string, plan: StorageRepairPlan, receipt: string): void {
  const fence = parseMetadata<Record<string, unknown>>(readSnapshot(root, file).bytes);
  if (fence.version !== 1 || fence.state !== 'unverified-recovery' || fence.repairId !== plan.id || fence.receipt !== receipt) {
    throw new Error('Storage recovery fence changed after repair.');
  }
}
function diagnosis(target: StorageRepairTarget, bytes: Buffer): StorageRepairPlan['diagnosis'] {
  if (target.kind === 'lock') return { state: 'unverified-ownership' };
  try { validate(target, bytes); return { state: 'valid' }; } catch { /* Classify without exposing parser excerpts or stored values. */ }
  if (target.kind === 'a2a' || target.kind === 'runtime-agent-snapshot') return { state: 'invalid-snapshot' };
  let invalidStart: number | undefined;
  for (let start = 0; start < bytes.length;) {
    const newline = bytes.indexOf(10, start), end = newline < 0 ? bytes.length : newline;
    const line = bytes.subarray(start, end);
    if (line.some(value => ![9, 13, 32].includes(value))) {
      if (invalidStart !== undefined) return { state: 'invalid-json-middle' };
      try { JSON.parse(decode(line)); } catch { invalidStart = start; }
    }
    start = end + 1;
  }
  if (invalidStart !== undefined) {
    const prefix = bytes.subarray(0, invalidStart);
    try { validate(target, prefix); return { state: 'invalid-json-tail', validPrefixBytes: prefix.length }; }
    catch { return { state: 'invalid-record' }; }
  }
  return { state: 'invalid-record' };
}

/** Read-only local Main/SDK maintenance. Plans contain metadata, never stored values or credentials. */
export function inspectStorageRepair(target: StorageRepairTarget): StorageRepairPlan {
  const normalized = normalizeTarget(target), files = targetFiles(normalized);
  const source = readSnapshot(normalized.root, files.file, target.kind === 'lock');
  return { version: 1, id: randomUUID(), target: normalized, file: files.file, source: source.snapshot,
    diagnosis: diagnosis(normalized, source.bytes) };
}
export function inspectStorageRepairCandidate(file: string): { path: string; sha256: string; bytes: number } {
  if (!path.isAbsolute(file)) throw new Error('Recovery candidate requires an absolute path.');
  const read = readSnapshot(path.dirname(file), file);
  return { path: file, sha256: read.snapshot.sha256, bytes: read.snapshot.bytes };
}
function atomic(file: string, bytes: Buffer, exclusive = false): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let failure: unknown;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor);
    const closing = descriptor; descriptor = undefined; fs.closeSync(closing);
    if (exclusive) fs.linkSync(temporary, file); else fs.renameSync(temporary, file);
  } catch (error) { failure = error; throw error; }
  finally {
    try { try { if (descriptor !== undefined) fs.closeSync(descriptor); } finally { fs.rmSync(temporary, { force: true }); } }
    catch (error) { throw new AggregateError(failure === undefined ? [error] : [failure, error], 'Storage repair publication cleanup failed.'); }
  }
}
function assertSameContent(expected: Snapshot, actual: Snapshot): void {
  if (expected.type !== actual.type || expected.sha256 !== actual.sha256 || expected.bytes !== actual.bytes) throw new Error('Storage repair conflict: retained bytes changed.');
}
function assertOfflineOwner(bytes: Buffer, requireKnown = false): void {
  let owner: unknown;
  try { owner = JSON.parse(bytes.toString('utf8')); }
  catch { if (requireKnown) throw new Error('Reclamation claim ownership is unverified; retain it for separate offline inspection.'); return; }
  const pid = typeof owner === 'number' ? owner : owner && typeof owner === 'object' && 'pid' in owner ? owner.pid : undefined;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    if (requireKnown) throw new Error('Reclamation claim ownership is unverified.'); return;
  }
  try { process.kill(pid, 0); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return; throw new Error('Lock owner cannot be verified offline.'); }
  throw new Error('Lock still has a live owner; offline quarantine is refused.');
}

function lockFamily(file: string): 'config' | 'coordination' | 'migration' | 'sealed' | 'storage' | 'host-owner' {
  const base = path.basename(file).split('.reclaim.')[0]!;
  if (path.basename(path.dirname(file)) === '.write-locks') throw new Error('Session writer locks use a different protocol; offline automatic quarantine is unsupported.');
  if (base.endsWith('.write.lock') || (path.basename(path.dirname(file)) === 'integrations' && base.endsWith('.json.lock'))) return 'config';
  if (['owner-policy.lock', 'startup.lock'].includes(base)) return 'coordination';
  if (base === '.migration-lock') return 'migration';
  if (/^[a-f0-9]{64}\.sealed\.lock$/.test(base)) return 'sealed';
  if (['.store.lock', '.server.lock', 'store.jsonl.lock'].includes(base)) return 'storage';
  if (['daemon.lock', 'owner.lock'].includes(base) && !path.basename(file).includes('.reclaim.')) return 'host-owner';
  throw new Error('Unsupported lock protocol; retain the lock for qualified offline repair.');
}
function reserveGeneration(plan: StorageRepairPlan, source: { snapshot: Snapshot; bytes: Buffer }, lease: StorageFileLock,
  reservations: string[]): { claim?: string; release?: () => void } {
  const family = lockFamily(plan.file);
  lease.assertOwned();
  if (family === 'host-owner') {
    const release = tryAcquireRuntimeLockMaintenance(plan.file);
    if (!release) throw new Error('Host ownership coordination is busy or unverified; repair refused.');
    return { release };
  }
  if (path.basename(plan.file).includes('.reclaim.')) return {};
  let parsed: unknown;
  const rawOwner = source.bytes.toString('utf8'); // Match the existing producers' replacement-decoding and claim keys exactly.
  try { parsed = JSON.parse(rawOwner) as unknown; } catch { return {}; }
  const owner = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  const validPid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  let generation: string | undefined;
  if (family === 'config' && owner?.version === 1 && validPid(owner.pid) && typeof owner.nonce === 'string' && owner.nonce) generation = hash(owner.nonce);
  if (family === 'coordination' && owner && typeof owner.nonce === 'string'
    && typeof owner.runtimeId === 'string' && owner.runtimeId.startsWith('owner-transition-') && readRuntimeDaemonLockOwner(plan.file)) generation = hash(owner.nonce);
  if (family === 'migration' && owner && validPid(owner.pid) && (source.snapshot.type === 'directory'
    || (owner.version === 1 && typeof owner.nonce === 'string' && owner.nonce))) generation = hash(rawOwner);
  if (family === 'storage' && ((owner?.version === 1 && validPid(owner.pid) && typeof owner.token === 'string' && owner.token)
    || (path.basename(plan.file) === '.server.lock' && validPid(parsed)))) generation = hash(rawOwner);
  if (family === 'sealed') {
    const record = readRuntimeDaemonLockOwner(source.snapshot.type === 'directory' ? path.join(plan.file, 'owner.json') : plan.file);
    if (record) generation = hash(JSON.stringify(record));
  }
  if (!generation) return {}; // This protocol's current writers retain an unverifiable original lock.
  const claim = `${plan.file}.reclaim.${generation}`;
  assertPath(plan.target.root, claim);
  let existing: Buffer | undefined;
  try { existing = readSnapshot(plan.target.root, claim).bytes; } catch (error) { if (!missing(error)) throw error; }
  if (existing) {
    const own = ownedRepairClaims.get(claim);
    if (own && !own.active && own.planId === plan.id && own.raw.equals(existing)) {
      lease.assertOwned(); own.active = true; reservations.push(claim);
    } else assertOfflineOwner(existing, true);
  } else {
    const raw = Buffer.from(JSON.stringify({ version: 1, pid: process.pid, nonce: randomUUID(), offlineRepairId: plan.id }));
    ownedRepairClaims.set(claim, { planId: plan.id, raw, active: true }); reservations.push(claim);
    try { atomic(claim, raw, true); }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
      assertOfflineOwner(readSnapshot(plan.target.root, claim).bytes, true);
    }
  }
  return { claim }; // Keep the same generation barrier as a permanent tombstone.
}

/**
 * Explicit offline repair, never a model tool. The acknowledgement is an operator
 * prerequisite for every shared writer, especially unverifiable/unfenced owners;
 * it is not a programmatic proof they stopped.
 * Cooperating current writers are excluded by their actual storage lock.
 */
export async function applyStorageRepair(plan: StorageRepairPlan, options: {
  readonly allWritersStopped: boolean;
  readonly candidate?: { readonly path: string; readonly sha256: string };
}): Promise<StorageRepairReceipt> {
  if (options.allWritersStopped !== true) throw new Error('Offline storage repair requires every shared writer to be stopped.');
  if (!plan || plan.version !== 1 || typeof plan.id !== 'string' || !/^[a-f0-9-]{36}$/.test(plan.id)
    || typeof plan.file !== 'string' || !path.isAbsolute(plan.file) || !plan.source
    || !/^[a-f0-9]{64}$/.test(plan.source.sha256)) throw new Error('Invalid storage repair plan.');
  if (Object.keys(plan).some(key => !['version', 'id', 'target', 'file', 'source', 'diagnosis'].includes(key))
    || Object.keys(plan.source).some(key => !['type', 'sha256', 'bytes', 'dev', 'ino', 'mtimeMs'].includes(key))
    || !plan.diagnosis || Object.keys(plan.diagnosis).some(key => !['state', 'validPrefixBytes'].includes(key))
    || JSON.stringify(normalizeTarget(plan.target)) !== JSON.stringify(plan.target)) throw new Error('Storage repair plan contains unsupported metadata.');
  // A completed lock quarantine may already have removed the inventory entry.
  const root = path.resolve(plan.target.root);
  assertPath(root, plan.file);
  const receiptFile = `${plan.file}.repair.${plan.id}.json`, backup = `${plan.file}.quarantined.${plan.id}`;
  let previous: StorageRepairReceipt | undefined;
  try { previous = parseMetadata<StorageRepairReceipt>(readSnapshot(root, receiptFile).bytes); }
  catch (error) { if (!missing(error)) throw error; }
  if (previous && (JSON.stringify(previous.plan) !== JSON.stringify(plan) || previous.backup !== backup)) throw new Error('Storage repair receipt conflicts with this plan.');
  if (previous && (previous.version !== 1 || typeof previous.completed !== 'boolean'
    || (previous.verified !== undefined && previous.verified !== true)
    || (previous.candidateSha256 !== undefined && !/^[a-f0-9]{64}$/.test(previous.candidateSha256))
    || Object.keys(previous).some(key => !['version', 'plan', 'backup', 'candidateSha256', 'fence', 'completed', 'reclamationClaim', 'verified'].includes(key)))) throw new Error('Invalid storage repair receipt metadata.');
  if (previous?.completed && plan.target.kind === 'lock') {
    assertSameContent(plan.source, readSnapshot(root, backup, true).snapshot); return previous;
  }
  const files = targetFiles(plan.target, previous !== undefined && plan.target.kind === 'lock');
  if (files.file !== plan.file) throw new Error('Storage repair plan target changed.');
  if (plan.target.kind === 'lock') lockFamily(files.file);
  assertPath(root, files.lock);
  const lease = tryAcquireStorageFileLock(files.lock, { legacyPidRecord: plan.target.kind === 'a2a' });
  if (!lease) throw new Error('Storage is busy, owned, or its lock is unverified; repair refused.');
  let failure: unknown;
  let releaseCanonical: (() => void) | undefined;
  const reservations: string[] = [];
  try {
    if (previous?.completed) {
      assertSameContent(plan.source, readSnapshot(root, backup).snapshot);
      if (readSnapshot(root, files.file).snapshot.sha256 !== previous.candidateSha256) throw new Error('Restored storage changed after repair.');
      if (options.candidate && options.candidate.sha256 !== previous.candidateSha256) throw new Error('Recovery candidate conflicts with the completed repair.');
      if (!previous.verified) {
        assertRepairFence(root, files.fence!, plan, receiptFile);
      }
      return previous;
    }
    if (plan.target.kind === 'lock') {
      if (previous) {
        let retained: Snapshot | undefined;
        try { retained = readSnapshot(root, backup, true).snapshot; }
        catch (error) { if (!missing(error)) throw error; }
        if (retained) {
          assertSameContent(plan.source, retained);
          const complete = { ...previous, completed: true };
          atomic(receiptFile, Buffer.from(JSON.stringify(complete))); return complete;
        }
      }
      const current = readSnapshot(root, files.file, true);
      assertSameContent(plan.source, current.snapshot);
      if (JSON.stringify(current.snapshot) !== JSON.stringify(plan.source)) throw new Error('Lock generation changed after inspection.');
      assertOfflineOwner(current.bytes);
      const barrier = reserveGeneration(plan, current, lease, reservations); releaseCanonical = barrier.release;
      const unchanged = readSnapshot(root, files.file, true);
      if (JSON.stringify(unchanged.snapshot) !== JSON.stringify(current.snapshot)) throw new Error('Lock generation changed before quarantine.');
      lease.assertOwned();
      const receipt: StorageRepairReceipt = { version: 1, plan, backup, reclamationClaim: barrier.claim, completed: false };
      atomic(receiptFile, Buffer.from(JSON.stringify(receipt)));
      fs.renameSync(files.file, backup); // Exact diagnosed path, retained beside its original root.
      const complete = { ...receipt, completed: true };
      atomic(receiptFile, Buffer.from(JSON.stringify(complete))); return complete;
    }
    const current = readSnapshot(root, files.file);
    const alreadyPublished = previous !== undefined && current.snapshot.sha256 === previous.candidateSha256;
    if (!alreadyPublished) {
      assertSameContent(plan.source, current.snapshot);
      if (JSON.stringify(plan.source) !== JSON.stringify(current.snapshot)) throw new Error('Storage file generation changed after inspection.');
      if (JSON.stringify(diagnosis(plan.target, current.bytes)) !== JSON.stringify(plan.diagnosis)) throw new Error('Storage repair diagnosis conflicts with this plan.');
      if (plan.diagnosis.state === 'valid') throw new Error('Storage is valid; corrupt-storage repair is not required.');
    }
    let candidate: Buffer;
    if (alreadyPublished) {
      if (options.candidate && options.candidate.sha256 !== previous!.candidateSha256) throw new Error('Recovery candidate conflicts with the interrupted repair.');
      candidate = current.bytes;
    } else if (options.candidate) {
      if (!path.isAbsolute(options.candidate.path) || !/^[a-f0-9]{64}$/.test(options.candidate.sha256)) throw new Error('Invalid recovery candidate.');
      const supplied = readSnapshot(path.dirname(options.candidate.path), options.candidate.path);
      if (supplied.snapshot.sha256 !== options.candidate.sha256) throw new Error('Recovery candidate changed.');
      candidate = supplied.bytes;
    } else {
      if (plan.target.kind !== 'runtime-agent-ledger' || plan.diagnosis.state !== 'invalid-json-tail'
        || plan.diagnosis.validPrefixBytes === undefined) throw new Error('A complete validated recovery candidate is required.');
      candidate = current.bytes.subarray(0, plan.diagnosis.validPrefixBytes);
    }
    validate(plan.target, candidate);
    const candidateSha256 = hash(candidate);
    if (previous && previous.candidateSha256 !== candidateSha256) throw new Error('Recovery candidate conflicts with the interrupted repair.');
    try { assertSameContent(plan.source, readSnapshot(root, backup).snapshot); }
    catch (error) { if (!missing(error) || alreadyPublished) throw error; atomic(backup, current.bytes, true); }
    const receipt: StorageRepairReceipt = { version: 1, plan, backup, candidateSha256, fence: files.fence!, completed: false };
    atomic(receiptFile, Buffer.from(JSON.stringify(receipt)));
    assertPath(root, files.fence!);
    const fence = Buffer.from(JSON.stringify({ version: 1, repairId: plan.id, receipt: receiptFile, state: 'unverified-recovery' }));
    try { atomic(files.fence!, fence, true); }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST'
        || !readSnapshot(root, files.fence!).bytes.equals(fence)) throw error;
    }
    if (!alreadyPublished) atomic(files.file, candidate);
    const complete = { ...receipt, completed: true };
    atomic(receiptFile, Buffer.from(JSON.stringify(complete))); return complete;
  } catch (error) { failure = error; throw error; }
  finally {
    for (const claim of reservations) { const own = ownedRepairClaims.get(claim); if (own?.planId === plan.id) own.active = false; }
    const errors: unknown[] = failure === undefined ? [] : [failure];
    try { releaseCanonical?.(); } catch (error) { errors.push(error); }
    try { lease.release(); } catch (error) { errors.push(error); }
    if (errors.length > (failure === undefined ? 0 : 1)) throw new AggregateError(errors, 'Storage repair ownership cleanup failed.');
  }
}

/** Trusted operator/Main confirmation of the exact restored state; never inferred by an LLM or from a TTL. */
export async function confirmStorageRepair(receipt: StorageRepairReceipt, options: {
  readonly allWritersStopped: boolean; readonly verifiedCurrentState: boolean;
}): Promise<StorageRepairReceipt> {
  if (options.verifiedCurrentState !== true) throw new Error('Explicit verification of restored state is required before resuming access.');
  const checked = await applyStorageRepair(receipt.plan, { allWritersStopped: options.allWritersStopped });
  if (checked.plan.target.kind === 'lock') throw new Error('Lock quarantine has no recovery fence to confirm.');
  const files = targetFiles(checked.plan.target), root = checked.plan.target.root;
  const receiptFile = `${files.file}.repair.${checked.plan.id}.json`;
  const lease = tryAcquireStorageFileLock(files.lock, { legacyPidRecord: checked.plan.target.kind === 'a2a' });
  if (!lease) throw new Error('Storage is busy or owned; verification refused.');
  let failure: unknown;
  try {
    const persisted = parseMetadata<StorageRepairReceipt>(readSnapshot(root, receiptFile).bytes);
    if (JSON.stringify(persisted) !== JSON.stringify(checked)) throw new Error('Storage repair receipt changed during verification.');
    if (readSnapshot(root, files.file).snapshot.sha256 !== checked.candidateSha256) throw new Error('Restored storage changed before verification.');
    assertSameContent(checked.plan.source, readSnapshot(root, checked.backup).snapshot);
    lease.assertOwned();
    let fencePresent = true;
    try { assertRepairFence(root, files.fence!, checked.plan, receiptFile); }
    catch (error) { if (!missing(error) || !checked.verified) throw error; fencePresent = false; }
    const verified: StorageRepairReceipt = { ...checked, verified: true };
    // Persist the explicit decision before removing its barrier, allowing retry after a crash.
    if (!checked.verified) atomic(receiptFile, Buffer.from(JSON.stringify(verified)));
    if (fencePresent) { assertPath(root, files.fence!); fs.unlinkSync(files.fence!); }
    return verified;
  } catch (error) { failure = error; throw error; }
  finally {
    try { lease.release(); }
    catch (error) { throw new AggregateError(failure === undefined ? [error] : [failure, error], 'Storage verification ownership cleanup failed.'); }
  }
}
