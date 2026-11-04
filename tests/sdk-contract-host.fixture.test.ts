import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readRuntimeDaemonLockOwner, readRuntimeOwnerProcessStartIdentity, resolveRuntimeDaemonPaths,
  tryAcquireRuntimeDaemonLock, tryAcquireRuntimeLockMaintenance } from '../src/runtime-daemon/state.js';

const children: ChildProcess[] = [];
const homes: string[] = [];

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Fixture process deadline exceeded')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await bounded(exited, 5000);
}

afterEach(async () => {
  for (const child of children.splice(0)) await stop(child);
  for (const home of homes.splice(0)) {
    if (dirname(home) !== resolve(tmpdir()) || !basename(home).startsWith('kodax-fixture-owner-')) throw new Error('Unsafe fixture cleanup');
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

async function home() {
  const directory = await mkdtemp(join(tmpdir(), 'kodax-fixture-owner-'));
  homes.push(directory);
  return directory;
}

async function startHost(homeDir: string): Promise<ChildProcess> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key)));
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/sdk-contract-host.fixture.ts'), homeDir], {
    cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  children.push(child);
  child.stdout!.resume();
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-12_000); });
  const ready: unknown = await bounded(Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'exit').then(([code]) => { throw new Error(`Fixture Host exited ${String(code)}: ${stderr}`); }),
  ]), 45_000);
  expect(ready).toMatchObject({ pid: child.pid, endpoint: expect.any(String) });
  expect(child.pid).not.toBe(process.pid);
  return child;
}

it('reclaims an exited fixture owner after PID reuse using its published process birth', async () => {
  const homeDir = await home();
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const original = await startHost(homeDir);
  const owner = readRuntimeDaemonLockOwner(paths.lockFile);
  if (!owner) throw new Error('Original Host did not publish its owner');
  const originalBirth = readRuntimeOwnerProcessStartIdentity(owner.pid);
  expect(originalBirth).toBeTruthy();
  expect(originalBirth).not.toBe(readRuntimeOwnerProcessStartIdentity(process.pid));
  await stop(original);
  // Reuse a known live PID without claiming it has the original process birth.
  await writeFile(paths.lockFile, JSON.stringify({ ...owner, pid: process.pid }));
  const replacement = await startHost(homeDir);
  expect(owner).toMatchObject({ kind: 'daemon', processStartIdentity: originalBirth });
  expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({ pid: replacement.pid, kind: 'daemon',
    processStartIdentity: readRuntimeOwnerProcessStartIdentity(replacement.pid!) });
}, 90_000);

it('does not replace a live independent fixture Host owner', async () => {
  const homeDir = await home();
  const paths = resolveRuntimeDaemonPaths(homeDir);
  await startHost(homeDir);
  const original = await readFile(paths.lockFile, 'utf8');
  await expect(startHost(homeDir)).rejects.toThrow('previousState=alive; reclaim=not-attempted');
  expect(await readFile(paths.lockFile, 'utf8')).toBe(original);
}, 90_000);

it('does not reclaim a live legacy PID with no process birth', async () => {
  const homeDir = await home();
  const paths = resolveRuntimeDaemonPaths(homeDir);
  await mkdir(paths.rootDir, { recursive: true });
  const owner = { runtimeId: 'legacy-fixture', pid: process.pid, createdAt: new Date().toISOString() };
  expect(tryAcquireRuntimeDaemonLock(paths, owner)).toBeDefined();
  await expect(startHost(homeDir)).rejects.toThrow('previousState=alive; reclaim=not-attempted');
  expect(readRuntimeDaemonLockOwner(paths.lockFile)).toEqual(owner);
}, 90_000);

it('reports a failed ownership CAS and leaves a gone owner intact while coordination is held', async () => {
  const homeDir = await home();
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const original = await startHost(homeDir);
  await stop(original);
  const owner = await readFile(paths.lockFile, 'utf8');
  const release = tryAcquireRuntimeLockMaintenance(paths.lockFile);
  if (!release) throw new Error('Could not hold the ownership coordination fixture');
  try {
    await expect(startHost(homeDir)).rejects.toThrow('previousState=gone; reclaim=false');
    expect(await readFile(paths.lockFile, 'utf8')).toBe(owner);
  } finally { release(); }
}, 90_000);
