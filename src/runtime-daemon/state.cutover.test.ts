import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  acquireRuntimeInlineOwner,
  acquireRuntimeSessionStorageOwner,
  findRuntimeSessionStorageHost,
  prepareRuntimeDaemonOwner,
  readRuntimeOwnerPolicy,
  resolveRuntimeDaemonPaths,
  resolveRuntimeDaemonPathsFromConfigHome,
  tryAcquireRuntimeDaemonLock,
  tryAcquireRuntimeSessionStorageStartup,
  readRuntimeDaemonLockOwner,
  updateRuntimeOwnerPolicy,
  writeRuntimeDaemonState,
} from './state.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it.each(['alive', 'unknown', 'corrupt'] as const)('never migrates an %s inline owner', state => {
  const { paths, sessions } = fixture();
  updateRuntimeOwnerPolicy(paths, 'inline', 0);
  if (state === 'corrupt') fs.writeFileSync(paths.lockFile, '{');
  else tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: 'protected-inline', pid: process.pid, createdAt: new Date().toISOString(), kind: 'inline',
  });
  if (state === 'unknown') vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  const policy = fs.readFileSync(paths.ownerPolicyFile, 'utf8');
  const lock = fs.readFileSync(paths.lockFile, 'utf8');
  expect(() => prepareRuntimeDaemonOwner(paths, sessions)).toThrow(/owner|unreadable/i);
  expect(fs.readFileSync(paths.ownerPolicyFile, 'utf8')).toBe(policy);
  expect(fs.readFileSync(paths.lockFile, 'utf8')).toBe(lock);
});

it('does not cut over a profile while another profile owns the same real Session directory', () => {
  const { paths, sessions } = fixture();
  updateRuntimeOwnerPolicy(paths, 'inline', 0);
  acquireRuntimeSessionStorageOwner(sessions, 'other-profile');
  const alias = path.join(path.dirname(sessions), 'session-alias');
  fs.symlinkSync(sessions, alias, process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => prepareRuntimeDaemonOwner(paths, alias)).toThrow(/Session storage/i);
  expect(readRuntimeOwnerPolicy(paths)).toMatchObject({ mode: 'inline', revision: 1 });
});

it.each(['unknown', 'corrupt'] as const)('preserves an %s Session storage fence without publishing cutover', state => {
  const { paths, sessions } = fixture();
  updateRuntimeOwnerPolicy(paths, 'inline', 0);
  const storage = acquireRuntimeSessionStorageOwner(sessions, 'protected-storage');
  if (state === 'corrupt') fs.writeFileSync(storage.file, '{');
  else vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  const previous = fs.readFileSync(storage.file, 'utf8');
  expect(() => prepareRuntimeDaemonOwner(paths, sessions)).toThrow(/Session storage/i);
  expect(readRuntimeOwnerPolicy(paths)).toMatchObject({ mode: 'inline', revision: 1 });
  expect(fs.readFileSync(storage.file, 'utf8')).toBe(previous);
});

it('can prepare inside the existing launcher startup gate without reacquiring it', () => {
  const { paths, sessions } = fixture();
  const release = tryAcquireRuntimeSessionStorageStartup(sessions);
  expect(release).toBeDefined();
  try {
    expect(prepareRuntimeDaemonOwner(paths, sessions)).toMatchObject({ unified: true });
    expect(tryAcquireRuntimeSessionStorageStartup(sessions)).toBeUndefined();
  } finally {
    release?.();
  }
});

it.each(['corrupt', 'live-without-lock'] as const)('does not publish cutover over a %s Host descriptor', state => {
  const { paths, sessions } = fixture();
  updateRuntimeOwnerPolicy(paths, 'inline', 0);
  if (state === 'corrupt') fs.writeFileSync(paths.stateFile, '{');
  else writeRuntimeDaemonState(paths, {
    runtimeId: 'unfenced-live', profile: 'default', pid: process.pid,
    startedAt: new Date().toISOString(), endpoint: 'unused', version: '0.7.97', status: 'ready',
  });
  expect(() => prepareRuntimeDaemonOwner(paths, sessions)).toThrow(/descriptor/i);
  expect(readRuntimeOwnerPolicy(paths)).toMatchObject({ mode: 'inline', revision: 1 });
});

it('keeps a different live descriptor protected when a stale owner lock remains', () => {
  const { paths, sessions } = fixture();
  updateRuntimeOwnerPolicy(paths, 'inline', 0);
  tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: 'stale-inline', pid: 999_999_999, createdAt: new Date().toISOString(), kind: 'inline',
  });
  writeRuntimeDaemonState(paths, {
    runtimeId: 'other-live', profile: 'default', pid: process.pid,
    startedAt: new Date().toISOString(), endpoint: 'unused', version: '0.7.97', status: 'ready',
  });
  expect(() => prepareRuntimeDaemonOwner(paths, sessions)).toThrow(/descriptor/i);
  expect(readRuntimeOwnerPolicy(paths)).toMatchObject({ mode: 'inline', revision: 1 });
});

it('retries an interrupted atomic policy publication without changing the original decision', () => {
  const { paths, sessions } = fixture();
  updateRuntimeOwnerPolicy(paths, 'inline', 0);
  const originalRename = fsDefault.renameSync;
  const rename = vi.spyOn(fsDefault, 'renameSync').mockImplementation((source, destination) => {
    if (destination === paths.ownerPolicyFile) throw Object.assign(new Error('publication interrupted'), { code: 'EIO' });
    originalRename(source, destination);
  });
  syncBuiltinESMExports();
  expect(() => prepareRuntimeDaemonOwner(paths, sessions)).toThrow(/publication interrupted/);
  expect(readRuntimeOwnerPolicy(paths)).toMatchObject({ mode: 'inline', revision: 1 });
  expect(fs.existsSync(paths.ownerPolicyLockFile)).toBe(false);
  rename.mockRestore();
  syncBuiltinESMExports();
  prepareRuntimeDaemonOwner(paths, sessions);
  expect(readRuntimeOwnerPolicy(paths)).toMatchObject({ mode: 'daemon', unified: true, revision: 2 });
});

it('leaves the existing live shared Host for the normal authenticated upgrade path', () => {
  const { paths, sessions } = fixture();
  const storage = acquireRuntimeSessionStorageOwner(sessions, 'live-shared');
  tryAcquireRuntimeDaemonLock(paths, { ...storage.owner, createdAt: '2026-01-01T00:00:00.000Z' });
  expect(prepareRuntimeDaemonOwner(paths, sessions)).toMatchObject({ mode: 'daemon', revision: 0 });
  expect(fs.existsSync(paths.ownerPolicyFile)).toBe(false);
  expect(readRuntimeDaemonLockOwner(paths.lockFile)?.runtimeId).toBe('live-shared');
});
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-host-cutover-'));
  roots.push(home);
  return { paths: resolveRuntimeDaemonPaths(home, 'default'), sessions: path.join(home, '.kodax', 'sessions') };
}

it('permanently retires an unowned inline profile and safely repeats startup', () => {
  const { paths, sessions } = fixture();
  updateRuntimeOwnerPolicy(paths, 'inline', 0);
  prepareRuntimeDaemonOwner(paths, sessions);
  const first = fs.readFileSync(paths.ownerPolicyFile, 'utf8');
  expect(JSON.parse(first)).toMatchObject({ mode: 'host', revision: 2 });
  expect(readRuntimeOwnerPolicy(paths)).toMatchObject({ mode: 'daemon', unified: true });
  prepareRuntimeDaemonOwner(paths, sessions);
  expect(fs.readFileSync(paths.ownerPolicyFile, 'utf8')).toBe(first);
  expect(() => acquireRuntimeInlineOwner(paths, {
    runtimeId: 'old-inline', pid: process.pid, createdAt: new Date().toISOString(), kind: 'inline',
  }, true)).toThrow(/retired/i);
  expect(() => updateRuntimeOwnerPolicy(paths, 'inline', 2)).toThrow(/retired/i);
});

it('cuts over the requested legacy profile before redirecting to its verified shared Host', () => {
  const { paths, sessions, storage, hostPaths, shared } = sharedFixture();
  const priorStorage = fs.readFileSync(storage.file, 'utf8');
  const priorHost = fs.readFileSync(hostPaths.lockFile, 'utf8');
  prepareRuntimeDaemonOwner(paths, sessions, shared);
  expect(readRuntimeOwnerPolicy(paths)).toMatchObject({ mode: 'daemon', unified: true, revision: 2 });
  prepareRuntimeDaemonOwner(paths, sessions, shared);
  expect(readRuntimeOwnerPolicy(paths).revision).toBe(2);
  expect(fs.readFileSync(storage.file, 'utf8')).toBe(priorStorage);
  expect(fs.readFileSync(hostPaths.lockFile, 'utf8')).toBe(priorHost);
});

it('rejects a same-PID target whose profile lock lost its exact process identity', () => {
  const { paths, sessions, hostPaths, shared } = sharedFixture();
  const owner = readRuntimeDaemonLockOwner(hostPaths.lockFile);
  if (!owner) throw new Error('Expected shared profile owner.');
  const { processStartIdentity: _identity, ...withoutIdentity } = owner;
  fs.writeFileSync(hostPaths.lockFile, JSON.stringify(withoutIdentity));
  expect(() => prepareRuntimeDaemonOwner(paths, sessions, shared)).toThrow(/shared Host/i);
  expect(readRuntimeOwnerPolicy(paths)).toMatchObject({ mode: 'inline', revision: 1 });
});

it.each(['alive', 'unknown', 'corrupt', 'same-host-identity'] as const)(
  'preserves a requested profile with an %s owner during shared-Host redirect', state => {
    const { paths, sessions, storage, shared } = sharedFixture();
    if (state === 'same-host-identity') updateRuntimeOwnerPolicy(paths, 'daemon', 1);
    if (state === 'corrupt') fs.writeFileSync(paths.lockFile, '{');
    else tryAcquireRuntimeDaemonLock(paths, state === 'same-host-identity' ? storage.owner : {
      runtimeId: 'requested-owner', pid: state === 'unknown' ? 999_999_998 : process.pid,
      createdAt: new Date().toISOString(), kind: 'inline',
    });
    if (state === 'unknown') {
      const kill = process.kill.bind(process);
      vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === 999_999_998) throw Object.assign(new Error('denied'), { code: 'EPERM' });
        return kill(pid, signal);
      });
    }
    const previous = fs.readFileSync(paths.ownerPolicyFile, 'utf8');
    const previousLock = fs.readFileSync(paths.lockFile, 'utf8');
    expect(() => prepareRuntimeDaemonOwner(paths, sessions, shared)).toThrow(/owner|unreadable/i);
    expect(fs.readFileSync(paths.ownerPolicyFile, 'utf8')).toBe(previous);
    expect(fs.readFileSync(paths.lockFile, 'utf8')).toBe(previousLock);
  },
);

function sharedFixture() {
  const { paths, sessions } = fixture();
  updateRuntimeOwnerPolicy(paths, 'inline', 0);
  const storage = acquireRuntimeSessionStorageOwner(sessions, 'shared-host-a');
  const hostPaths = resolveRuntimeDaemonPathsFromConfigHome(paths.configHome, 'host-a');
  tryAcquireRuntimeDaemonLock(hostPaths, storage.owner);
  writeRuntimeDaemonState(hostPaths, {
    runtimeId: storage.owner.runtimeId, profile: 'host-a', pid: process.pid,
    startedAt: storage.owner.createdAt, endpoint: 'unused', version: '0.7.97', status: 'ready',
  });
  const shared = findRuntimeSessionStorageHost(paths.configHome, sessions);
  if (!shared) throw new Error('Expected the verified shared Host.');
  return { paths, sessions, storage, hostPaths, shared };
}
