import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { waitForRuntimeDaemonOwnerExit } from './process.js';
import { observeRuntimeDaemonHealth, resolveRuntimeDaemonOwnership } from './lifecycle.js';
import { acquireRuntimeSessionStorageOwner, findRuntimeSessionStorageHost,
  readRuntimeDaemonLockOwner, resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock,
  writeRuntimeDaemonState, type RuntimeDaemonLockOwner, type RuntimeDaemonPaths } from './state.js';

const proc = vi.hoisted(() => new Map<string, string | Error>());
vi.mock('node:fs', async original => {
  const module = await original<typeof import('node:fs')>();
  return { ...module, readFileSync: (...args: Parameters<typeof module.readFileSync>) => {
    const value = typeof args[0] === 'string' ? proc.get(args[0]) : undefined;
    if (value instanceof Error) throw value;
    return value ?? module.readFileSync(...args);
  } };
});

let child: ChildProcess;
let exited: Promise<unknown>;
let homeDir: string;
let paths: RuntimeDaemonPaths;
let owner: RuntimeDaemonLockOwner;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(async () => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-owner-identity-'));
  paths = resolveRuntimeDaemonPaths(homeDir);
  child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); process.stdin.resume();'], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  exited = once(child, 'exit');
  await once(child.stdout!, 'data');
  owner = { runtimeId: 'sdk-host', pid: child.pid!, createdAt: new Date().toISOString(),
    kind: 'daemon', processStartIdentity: 'linux:42' };
  // Exercise Linux ownership policy on every test platform; the child really is alive.
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  proc.set(`/proc/${owner.pid}/stat`, `${owner.pid} (SDK Host) S ${'0 '.repeat(18)}42 0`);
  proc.set(`/proc/${owner.pid}/cmdline`, 'node\0vitest-worker\0');
});

afterEach(async () => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', platform);
  proc.clear();
  if (child?.exitCode === null && child.signalCode === null) child.kill();
  if (exited) await exited;
  if (homeDir) fs.rmSync(homeDir, { recursive: true, force: true });
});

function publishOwner(record = owner): void {
  expect(tryAcquireRuntimeDaemonLock(paths, record)).toBeDefined();
  writeRuntimeDaemonState(paths, { runtimeId: record.runtimeId, profile: paths.profile,
    pid: record.pid, startedAt: record.createdAt, endpoint: '/tmp/sdk-host.sock', version: 'test', status: 'ready' });
}

const unreachable = { createTransport: async () => { throw new Error('Endpoint unavailable'); } };

function publishSharedOwner(): { sessionsDir: string; ownerFile: string } {
  publishOwner();
  const sessionsDir = path.join(paths.configHome, 'sessions');
  const ownerFile = path.join(sessionsDir, '.product-host', 'owner.lock');
  fs.mkdirSync(path.dirname(ownerFile), { recursive: true });
  fs.writeFileSync(ownerFile, JSON.stringify(owner));
  return { sessionsDir, ownerFile };
}

it.each(['Z', 'X', 'x'])('uses the same terminated-process semantics for %s owners across discovery, health, exit and reclamation', async state => {
  const { sessionsDir } = publishSharedOwner();
  proc.set(`/proc/${owner.pid}/stat`, `${owner.pid} (SDK ) Host) ${state} ${'0 '.repeat(18)}42 0`);
  expect(findRuntimeSessionStorageHost(paths.configHome, sessionsDir)).toBeUndefined();
  expect(await observeRuntimeDaemonHealth(paths, unreachable)).toMatchObject({ pidAlive: false });
  await expect(waitForRuntimeDaemonOwnerExit(owner, 100)).resolves.toBeUndefined();
  expect(acquireRuntimeSessionStorageOwner(sessionsDir, 'replacement').owner.runtimeId).toBe('replacement');
});

it.each(['EACCES', 'ENOENT', 'malformed', 'EPERM', 'EINVAL'])('preserves shared and daemon ownership when evidence is %s', async evidence => {
  const { sessionsDir, ownerFile } = publishSharedOwner();
  if (evidence === 'EPERM' || evidence === 'EINVAL') {
    const kill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === owner.pid && signal === 0) throw Object.assign(new Error('Cannot probe owner'), { code: evidence });
      return kill(pid, signal);
    });
  } else {
    proc.set(`/proc/${owner.pid}/stat`, evidence === 'malformed' ? 'not a process stat'
      : Object.assign(new Error('Cannot read proc evidence'), { code: evidence }));
  }
  expect(findRuntimeSessionStorageHost(paths.configHome, sessionsDir)?.owner).toEqual(owner);
  expect(await observeRuntimeDaemonHealth(paths, unreachable)).toMatchObject({ pidAlive: true });
  await expect(waitForRuntimeDaemonOwnerExit(owner, 10)).rejects.toThrow(/Cannot verify/);
  expect(() => acquireRuntimeSessionStorageOwner(sessionsDir, 'replacement')).toThrow(expect.objectContaining({ code: 'session_storage_owned' }));
  expect(readRuntimeDaemonLockOwner(ownerFile)).toEqual(owner);
  expect(readRuntimeDaemonLockOwner(paths.lockFile)).toEqual(owner);
});

it('recognizes PID reuse in shared storage without killing the replacement process', async () => {
  const { sessionsDir } = publishSharedOwner();
  proc.set(`/proc/${owner.pid}/stat`, `${owner.pid} (different process) S ${'0 '.repeat(18)}43 0`);
  expect(findRuntimeSessionStorageHost(paths.configHome, sessionsDir)).toBeUndefined();
  expect(await observeRuntimeDaemonHealth(paths, unreachable)).toMatchObject({ pidAlive: false });
  await expect(waitForRuntimeDaemonOwnerExit(owner, 100)).resolves.toBeUndefined();
  expect(acquireRuntimeSessionStorageOwner(sessionsDir, 'replacement').owner.runtimeId).toBe('replacement');
  expect(() => process.kill(owner.pid, 0)).not.toThrow();
});

it('never reclaims or kills a live shared owner on timeout', async () => {
  const { sessionsDir, ownerFile } = publishSharedOwner();
  expect(findRuntimeSessionStorageHost(paths.configHome, sessionsDir)?.owner).toEqual(owner);
  await expect(waitForRuntimeDaemonOwnerExit(owner, 10)).rejects.toThrow('still running');
  expect(() => acquireRuntimeSessionStorageOwner(sessionsDir, 'replacement')).toThrow(expect.objectContaining({ code: 'session_storage_owned' }));
  expect(readRuntimeDaemonLockOwner(ownerFile)).toEqual(owner);
  expect(() => process.kill(owner.pid, 0)).not.toThrow();
});

it.each([true, false])('observes a live SDK Host without daemon serve argv (start identity=%s)', async identified => {
  publishOwner(identified ? owner : { ...owner, processStartIdentity: undefined });
  const observation = await observeRuntimeDaemonHealth(paths, { createTransport: async () => ({
    async request() { return { identity: { runtimeId: owner.runtimeId, profile: paths.profile } }; },
    subscribe() { return { close() {} }; }, close() {},
  }) });
  expect(observation).toMatchObject({ pidAlive: true, endpointReachable: true, identityMatches: true });
  expect(readRuntimeDaemonLockOwner(paths.lockFile)?.runtimeId).toBe(owner.runtimeId);
});

it.each(['daemon', 'inline'] as const)('preserves a live %s owner with missing daemon state', async kind => {
  expect(tryAcquireRuntimeDaemonLock(paths, { ...owner, kind })).toBeDefined();
  const decision = await resolveRuntimeDaemonOwnership(paths,
    { runtimeId: 'replacement', pid: process.pid, createdAt: new Date().toISOString() }, unreachable);
  expect(decision.kind).toBe('wait');
  expect(readRuntimeDaemonLockOwner(paths.lockFile)?.runtimeId).toBe(owner.runtimeId);
});

it('reclaims an original owner whose PID now names a different process, even with daemon serve argv', async () => {
  publishOwner({ ...owner, processStartIdentity: 'linux:41' });
  proc.set(`/proc/${owner.pid}/cmdline`, 'node\0kodax\0daemon\0serve\0');
  const decision = await resolveRuntimeDaemonOwnership(paths,
    { runtimeId: 'replacement', pid: process.pid, createdAt: new Date().toISOString() }, unreachable);
  expect(decision.kind).toBe('claim');
  expect(readRuntimeDaemonLockOwner(paths.lockFile)?.runtimeId).toBe('replacement');
  expect(() => process.kill(owner.pid, 0)).not.toThrow();
});

it('preserves a live owner when its start identity cannot be read', async () => {
  publishOwner();
  proc.set(`/proc/${owner.pid}/stat`, Object.assign(new Error('Identity unavailable'), { code: 'EACCES' }));
  const decision = await resolveRuntimeDaemonOwnership(paths,
    { runtimeId: 'replacement', pid: process.pid, createdAt: new Date().toISOString() }, unreachable);
  expect(decision).toMatchObject({ kind: 'unhealthy', health: 'unhealthy' });
  expect(readRuntimeDaemonLockOwner(paths.lockFile)?.runtimeId).toBe(owner.runtimeId);
});

it('does not use a different lock owner as process identity evidence for the state', async () => {
  publishOwner();
  fs.writeFileSync(paths.lockFile, JSON.stringify({ ...owner, runtimeId: 'different-owner', processStartIdentity: 'linux:41' }));
  const observation = await observeRuntimeDaemonHealth(paths, unreachable);
  expect(observation).toMatchObject({ pidAlive: true, endpointReachable: false });
  expect(readRuntimeDaemonLockOwner(paths.lockFile)?.runtimeId).toBe('different-owner');
});
