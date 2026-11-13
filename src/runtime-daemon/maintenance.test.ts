import * as fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRuntimeDaemonMaintenance } from './maintenance.js';
import * as state from './state.js';

const roots: string[] = [];
const maintainers: ReturnType<typeof createRuntimeDaemonMaintenance>[] = [];
const deadPid = 2_147_483_647;

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await Promise.all(maintainers.splice(0).map((maintenance) => maintenance.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-maintenance-'));
  roots.push(root);
  const paths = state.resolveRuntimeDaemonPathsFromConfigHome(root, 'coder');
  const owner = { runtimeId: 'rt_0123456789ab', pid: process.pid,
    createdAt: new Date().toISOString(), kind: 'daemon' as const, processStartIdentity: 'current-generation' };
  fs.mkdirSync(paths.rootDir, { recursive: true });
  fs.writeFileSync(paths.lockFile, JSON.stringify(owner));
  const maintenance = createRuntimeDaemonMaintenance(paths, owner);
  maintainers.push(maintenance);
  const put = (name: string, value: unknown) => {
    const file = path.join(paths.rootDir, name);
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  const abandoned = { ...owner, pid: deadPid, processStartIdentity: 'retired-generation' };
  return { paths, owner, maintenance, put, abandoned };
}

it('removes only complete temporary publications owned by a process that no longer exists', async () => {
  const { maintenance, put, abandoned, paths } = fixture();
  const temporaryOwner = put(`daemon.lock.${randomUUID()}.tmp`, abandoned);
  const temporaryState = put(`daemon.json.${deadPid}.${randomUUID()}.tmp`, {
    runtimeId: abandoned.runtimeId, pid: deadPid, profile: paths.profile,
    startedAt: abandoned.createdAt, version: '0.7.97-beta.2', status: 'ready', endpoint: 'old-endpoint',
  });
  const preserved = [
    put('daemon.json', { pid: deadPid }), put('daemon.token', 'secret-fixture'),
    put(`daemon.lock.${randomUUID()}.tmp`, '{incomplete'),
    put(`daemon.lock.${randomUUID()}.tmp`, { ...abandoned, processStartIdentity: undefined }),
    put(`daemon.json.${process.pid}.${randomUUID()}.tmp`, { pid: deadPid, runtimeId: abandoned.runtimeId }),
    put(`daemon.lock.reclaim.${randomUUID()}`, abandoned),
    put(`unknown.${randomUUID()}.tmp`, abandoned),
    put(`daemon.lock.${randomUUID()}.tmp`, 'x'.repeat(65_537)),
  ];
  const nonce = randomUUID();
  preserved.push(put(`owner-policy.lock.${randomUUID()}.tmp`, {
    ...abandoned, runtimeId: `owner-transition-${nonce}`, nonce,
  }));
  const unreadable = put(`daemon.lock.${randomUUID()}.tmp`, abandoned);
  const invalidUtf8 = Buffer.from(JSON.stringify(abandoned));
  invalidUtf8[invalidUtf8.indexOf(abandoned.runtimeId)] = 0xff;
  fs.writeFileSync(unreadable, invalidUtf8);
  preserved.push(unreadable);
  fs.mkdirSync(path.join(paths.rootDir, 'runs'));
  const durable = path.join(paths.rootDir, 'runs', 'old-status.json');
  fs.writeFileSync(durable, JSON.stringify(abandoned));
  expect((await maintenance.runOnce()).removed).toBe(2);
  expect(fs.existsSync(temporaryOwner)).toBe(false);
  expect(fs.existsSync(temporaryState)).toBe(false);
  expect(preserved.every((file) => fs.existsSync(file))).toBe(true);
  expect(fs.existsSync(durable)).toBe(true);
  expect(fs.existsSync(paths.lockFile)).toBe(true);
});

it('preserves live and unverified owners without requesting expensive process-start identity probes', async () => {
  const { maintenance, put, abandoned, owner } = fixture();
  const live = put(`daemon.lock.${randomUUID()}.tmp`, owner);
  const unverifiedPid = deadPid - 1;
  const unverified = put(`daemon.lock.${randomUUID()}.tmp`, { ...abandoned, pid: unverifiedPid });
  const kill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === unverifiedPid) throw Object.assign(new Error('Process probe denied'), { code: 'EPERM' });
    return kill(pid, signal);
  });
  const observations = vi.spyOn(state, 'runtimeOwnerProcessState');
  expect((await maintenance.runOnce()).removed).toBe(0);
  expect(fs.existsSync(live)).toBe(true);
  expect(fs.existsSync(unverified)).toBe(true);
  expect(observations.mock.calls.every(([observed]) => observed.processStartIdentity === undefined)).toBe(true);
});

it('retains a publication replaced between observation and the locked removal check', async () => {
  const { maintenance, put, abandoned, owner } = fixture();
  const target = put(`daemon.lock.${randomUUID()}.tmp`, abandoned);
  const acquire = state.tryAcquireRuntimeLockMaintenance;
  vi.spyOn(state, 'tryAcquireRuntimeLockMaintenance').mockImplementation((file) => {
    const release = acquire(file);
    fs.unlinkSync(target);
    fs.writeFileSync(target, JSON.stringify(owner));
    return release;
  });
  expect((await maintenance.runOnce()).removed).toBe(0);
  expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(owner);
});

it('does not delete a new inode even when its contents match the abandoned publication', async () => {
  const { maintenance, put, abandoned } = fixture();
  const target = put(`daemon.lock.${randomUUID()}.tmp`, abandoned);
  const replacement = put('replacement-publication', abandoned);
  const acquire = state.tryAcquireRuntimeLockMaintenance;
  vi.spyOn(state, 'tryAcquireRuntimeLockMaintenance').mockImplementation((file) => {
    const release = acquire(file);
    fs.unlinkSync(target);
    fs.renameSync(replacement, target);
    return release;
  });
  expect((await maintenance.runOnce()).removed).toBe(0);
  expect(fs.existsSync(target)).toBe(true);
});

it('preserves a new Host owner and the temporary publication when ownership changes before removal', async () => {
  const { paths, maintenance, put, abandoned, owner } = fixture();
  const target = put(`daemon.lock.${randomUUID()}.tmp`, abandoned);
  const replacement = { ...owner, runtimeId: 'rt_9876543210ab' };
  const acquire = state.tryAcquireRuntimeLockMaintenance;
  vi.spyOn(state, 'tryAcquireRuntimeLockMaintenance').mockImplementation((file) => {
    const release = acquire(file);
    fs.writeFileSync(paths.lockFile, JSON.stringify(replacement));
    return release;
  });
  expect((await maintenance.runOnce()).removed).toBe(0);
  expect(fs.existsSync(target)).toBe(true);
  expect(JSON.parse(fs.readFileSync(paths.lockFile, 'utf8'))).toEqual(replacement);
});

it('retains abandoned publications while another owner maintenance transaction holds the profile gate', async () => {
  const { paths, maintenance, put, abandoned } = fixture();
  const target = put(`daemon.lock.${randomUUID()}.tmp`, abandoned);
  const release = state.tryAcquireRuntimeLockMaintenance(paths.lockFile);
  expect(release).toBeTypeOf('function');
  try {
    expect((await maintenance.runOnce()).removed).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
  } finally { release?.(); }
});

it('does not touch symlinks, or temporary publications after the profile owner changes', async () => {
  const { paths, maintenance, put, abandoned, owner } = fixture();
  const target = path.join(paths.rootDir, 'external-target');
  fs.mkdirSync(target);
  const link = path.join(paths.rootDir, `daemon.lock.${randomUUID()}.tmp`);
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  expect((await maintenance.runOnce()).removed).toBe(0);
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  const temporary = put(`daemon.lock.${randomUUID()}.tmp`, abandoned);
  fs.writeFileSync(paths.lockFile, JSON.stringify({ ...owner, runtimeId: 'rt_9876543210ab' }));
  expect((await maintenance.runOnce()).removed).toBe(0);
  expect(fs.existsSync(temporary)).toBe(true);
});

it('bounds each round and advances its directory cursor so later files are eventually inspected', async () => {
  const { maintenance, put, abandoned } = fixture();
  for (let index = 0; index < 70; index += 1) put(`retained-${index}`, 'unrelated');
  const temporary = put(`daemon.lock.${randomUUID()}.tmp`, abandoned);
  let removed = 0;
  for (let round = 0; round < 5; round += 1) {
    const result = await maintenance.runOnce();
    expect(result.scanned).toBeLessThanOrEqual(32);
    removed += result.removed;
  }
  expect(removed).toBe(1);
  expect(fs.existsSync(temporary)).toBe(false);
});

it('cancels without deleting files and closes its cursor idempotently', async () => {
  const { maintenance, put, abandoned } = fixture();
  const temporary = put(`daemon.lock.${randomUUID()}.tmp`, abandoned);
  const controller = new AbortController();
  controller.abort();
  expect(await maintenance.runOnce(controller.signal)).toEqual({ scanned: 0, removed: 0 });
  expect(fs.existsSync(temporary)).toBe(true);
  await maintenance.close();
  await maintenance.close();
  expect(await maintenance.runOnce()).toEqual({ scanned: 0, removed: 0 });
});

it.each(['read', 'delete'] as const)('continues past a persistently denied candidate on the next round (%s)', async (stage) => {
  const { maintenance, put, abandoned } = fixture();
  const blocked = put('daemon.lock.00000000-0000-4000-8000-000000000001.tmp', abandoned);
  const later = put('daemon.lock.00000000-0000-4000-8000-000000000002.tmp', abandoned);
  const failure = Object.assign(new Error('Candidate access denied'), { code: 'EACCES' });
  if (stage === 'read') {
    const openFile = fsPromises.open;
    vi.spyOn(fsPromises, 'open').mockImplementation(async (file, flags, mode) => {
      if (String(file) === blocked) throw failure;
      return openFile(file, flags, mode);
    });
  } else {
    const removeFile = fsPromises.unlink;
    vi.spyOn(fsPromises, 'unlink').mockImplementation(async (file) => {
      if (String(file) === blocked) throw failure;
      return removeFile(file);
    });
  }
  syncBuiltinESMExports();
  await expect(maintenance.runOnce()).rejects.toBe(failure);
  // Directory order is filesystem-defined (hash order on ext4), so `later` may
  // precede the denied candidate and be removed by the failing round.
  const removedBeforeFailure = !fs.existsSync(later);
  expect((await maintenance.runOnce()).removed).toBe(removedBeforeFailure ? 0 : 1);
  expect(fs.existsSync(later)).toBe(false);
  expect(fs.existsSync(blocked)).toBe(true);
});

it('closes a failed directory cursor and retries with a fresh cursor on the next round', async () => {
  const { maintenance, put, abandoned } = fixture();
  const target = put(`daemon.lock.${randomUUID()}.tmp`, abandoned);
  const openDirectory = fsPromises.opendir;
  let failNextCursor = true;
  const opening = vi.spyOn(fsPromises, 'opendir').mockImplementation(async (file, options) => {
    const directory = await openDirectory(file, options);
    if (failNextCursor) {
      failNextCursor = false;
      Object.defineProperty(directory, 'read', { value: async () => {
        throw Object.assign(new Error('Directory enumeration failed'), { code: 'EIO' });
      } });
    }
    return directory;
  });
  syncBuiltinESMExports();
  await expect(maintenance.runOnce()).rejects.toThrow('Directory enumeration failed');
  expect(fs.existsSync(target)).toBe(true);
  expect((await maintenance.runOnce()).removed).toBe(1);
  expect(opening).toHaveBeenCalledTimes(2);
});
