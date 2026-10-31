import { spawn, type ChildProcess } from 'node:child_process';
import nodeFs from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setAgentConfigHome } from './agent-home.js';
import {
  cleanupRegisteredManagedChildren,
  registerManagedChildProcess,
} from './managed-child-processes.js';
import { killChildProcessTree, readProcessStartIdentity } from './process-tree.js';

const PARENT_WATCHED_CHILD_SCRIPT = 'const parent=process.ppid; setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 1000)';

const mutableNodeFs = createRequire(import.meta.url)('node:fs') as {
  readdirSync: typeof nodeFs.readdirSync;
  renameSync: typeof nodeFs.renameSync;
  writeFileSync: typeof nodeFs.writeFileSync;
};

function childRegistryPath(home: string, pid: number, registrationId: string): string {
  return path.join(home, 'runtime', 'processes', 'children', `${pid}.${registrationId}.json`);
}

function legacyChildRegistryPath(home: string, fileName: string): string {
  return path.join(home, 'processes', 'children', fileName);
}

function unresolvedRegistryPath(home: string, file: string): string {
  return path.join(home, 'runtime', 'processes', 'children', '.unresolved', path.basename(file));
}

async function registeredChildFiles(home: string, pid: number): Promise<string[]> {
  const directory = path.join(home, 'runtime', 'processes', 'children');
  return (await readdir(directory))
    .filter((name) => name.startsWith(`${pid}.`) && name.endsWith('.json'))
    .map((name) => path.join(directory, name));
}

async function writeRegistryRecord(home: string, record: Record<string, unknown>): Promise<void> {
  const pid = record.pid;
  if (typeof pid !== 'number') {
    throw new Error('test registry record needs a numeric pid');
  }
  const registrationId = record.registrationId;
  if (typeof registrationId !== 'string') {
    throw new Error('test registry record needs a registration id');
  }
  const file = childRegistryPath(home, pid, registrationId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(record), 'utf8');
}

async function writeLegacyRegistryRecord(
  home: string,
  record: Record<string, unknown>,
): Promise<string> {
  const pid = record.pid;
  if (typeof pid !== 'number') {
    throw new Error('test registry record needs a numeric pid');
  }
  const file = path.join(home, 'runtime', 'processes', 'children', `${pid}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(record), 'utf8');
  return file;
}

function findDeadPid(): number {
  for (let pid = 999_999; pid < 1_010_000; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return pid;
    }
  }
  throw new Error('could not find an unused pid for test');
}

function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('child did not exit'));
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', onExit);
  });
}

describe('managed child process registry', () => {
  let tempHome = '';
  let child: ChildProcess | undefined;

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      await killChildProcessTree(child);
    }
    child = undefined;
    setAgentConfigHome(undefined);
    if (tempHome) {
      await rm(tempHome, { recursive: true, force: true });
      tempHome = '';
    }
  });

  it('cleans up a confirmed registered child process', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    child = spawn(process.execPath, ['-e', PARENT_WATCHED_CHILD_SCRIPT], {
      stdio: 'ignore',
      windowsHide: true,
    });
    registerManagedChildProcess(child, {
      kind: 'test-child',
      command: process.execPath,
      args: ['-e', PARENT_WATCHED_CHILD_SCRIPT],
    });

    const summary = await cleanupRegisteredManagedChildren({ includeCurrentOwner: true });

    expect(summary.killed).toBe(1);
    await expect(waitForExit(child)).resolves.toBeUndefined();
  });

  it('quarantines unauthenticated pre-Runtime registry evidence without signaling its process', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-upgrade-'));
    setAgentConfigHome(tempHome);
    child = spawn(process.execPath, ['-e', PARENT_WATCHED_CHILD_SCRIPT], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child.pid === undefined) throw new Error('child pid missing');
    const unregister = registerManagedChildProcess(child, {
      kind: 'pre-runtime-registry-child',
      command: process.execPath,
      args: ['-e', PARENT_WATCHED_CHILD_SCRIPT],
    }, { manualUnregister: true });
    const [currentFile] = await registeredChildFiles(tempHome, child.pid);
    if (currentFile === undefined) throw new Error('managed child record missing');
    const record = JSON.parse(await readFile(currentFile, 'utf8')) as Record<string, unknown>;
    record.ownerPid = findDeadPid();
    delete record.ownerProcessStartIdentity;
    const legacyFile = legacyChildRegistryPath(tempHome, path.basename(currentFile));
    await mkdir(path.dirname(legacyFile), { recursive: true });
    await writeFile(legacyFile, JSON.stringify(record), 'utf8');
    unregister();

    await expect(cleanupRegisteredManagedChildren({ includeCurrentOwner: true }))
      .resolves.toMatchObject({ killed: 0, skipped: 1 });
    expect(() => process.kill(child!.pid!, 0)).not.toThrow();
    await expect(readFile(legacyFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(unresolvedRegistryPath(tempHome, legacyFile), 'utf8'))
      .resolves.toContain('pre-runtime-registry-child');
  });

  it('does not traverse a legacy registry symlink or move files outside Agent Home', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-legacy-link-'));
    const victim = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-victim-'));
    setAgentConfigHome(tempHome);
    const victimRecord = path.join(victim, 'unrelated.json');
    await writeFile(victimRecord, '{}', 'utf8');
    const processes = path.join(tempHome, 'processes');
    await mkdir(processes, { recursive: true });
    await symlink(victim, path.join(processes, 'children'), process.platform === 'win32' ? 'junction' : 'dir');

    try {
      await expect(cleanupRegisteredManagedChildren()).resolves.toEqual({
        killed: 0,
        pruned: 0,
        skipped: 0,
      });
      await expect(readFile(victimRecord, 'utf8')).resolves.toBe('{}');
      await expect(readFile(
        unresolvedRegistryPath(tempHome, victimRecord),
        'utf8',
      )).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(victim, { recursive: true, force: true });
    }
  });

  it('strictly cleans a current-owner child after its registry file is corrupted', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    child = spawn(process.execPath, ['-e', PARENT_WATCHED_CHILD_SCRIPT], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child.pid === undefined) throw new Error('child pid missing');
    registerManagedChildProcess(child, {
      kind: 'test-child',
      command: process.execPath,
      args: ['-e', PARENT_WATCHED_CHILD_SCRIPT],
    });
    const [recordFile] = await registeredChildFiles(tempHome, child.pid);
    if (recordFile === undefined) throw new Error('managed child record missing');
    await writeFile(recordFile, '{corrupt', 'utf8');

    await expect(cleanupRegisteredManagedChildren({
      includeCurrentOwner: true,
      requireCurrentOwnerCleanup: true,
    })).resolves.toMatchObject({ killed: 1, skipped: 0 });
    await expect(waitForExit(child)).resolves.toBeUndefined();
  });

  it('retains in-memory cleanup evidence when registry persistence fails', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    child = spawn(process.execPath, ['-e', PARENT_WATCHED_CHILD_SCRIPT], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const writeFileSync = mutableNodeFs.writeFileSync;
    mutableNodeFs.writeFileSync = (() => {
      throw Object.assign(new Error('registry unavailable'), { code: 'EACCES' });
    }) as typeof nodeFs.writeFileSync;
    syncBuiltinESMExports();
    try {
      registerManagedChildProcess(child, {
        kind: 'test-child',
        command: process.execPath,
        args: ['-e', PARENT_WATCHED_CHILD_SCRIPT],
      });
    } finally {
      mutableNodeFs.writeFileSync = writeFileSync;
      syncBuiltinESMExports();
    }

    await expect(cleanupRegisteredManagedChildren({
      includeCurrentOwner: true,
      requireCurrentOwnerCleanup: true,
    })).resolves.toMatchObject({ killed: 1, skipped: 0 });
    await expect(waitForExit(child)).resolves.toBeUndefined();
  });

  it('rejects an external-effect gate when durable registration fails', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    child = spawn(process.execPath, ['-e', PARENT_WATCHED_CHILD_SCRIPT], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const writeFileSync = mutableNodeFs.writeFileSync;
    mutableNodeFs.writeFileSync = (() => {
      throw Object.assign(new Error('registry unavailable'), { code: 'ENOSPC' });
    }) as typeof nodeFs.writeFileSync;
    syncBuiltinESMExports();
    try {
      expect(() => registerManagedChildProcess(child!, {
        kind: 'external-effect-gate',
        command: process.execPath,
      }, { requireDurableRecord: true })).toThrow('registry unavailable');
    } finally {
      mutableNodeFs.writeFileSync = writeFileSync;
      syncBuiltinESMExports();
    }
  });

  it('surfaces an unreadable registry during strict final cleanup', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    const readdirSync = mutableNodeFs.readdirSync;
    mutableNodeFs.readdirSync = (() => {
      throw Object.assign(new Error('registry unreadable'), { code: 'EACCES' });
    }) as typeof nodeFs.readdirSync;
    syncBuiltinESMExports();
    try {
      await expect(cleanupRegisteredManagedChildren({
        includeCurrentOwner: true,
        requireCurrentOwnerCleanup: true,
      })).rejects.toThrow(/registry.*unreadable/i);
    } finally {
      mutableNodeFs.readdirSync = readdirSync;
      syncBuiltinESMExports();
    }
  });

  it('skips children owned by the current live process by default', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    child = spawn(process.execPath, ['-e', PARENT_WATCHED_CHILD_SCRIPT], {
      stdio: 'ignore',
      windowsHide: true,
    });
    registerManagedChildProcess(child, {
      kind: 'test-child',
      command: process.execPath,
      args: ['-e', PARENT_WATCHED_CHILD_SCRIPT],
    });

    const summary = await cleanupRegisteredManagedChildren();

    expect(summary.killed).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(child.exitCode).toBeNull();
  });

  it('supports caller-owned cleanup after process stdio closes', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child.pid === undefined) throw new Error('child pid missing');
    const pid = child.pid;
    const unregister = registerManagedChildProcess(child, {
      kind: 'manual-child',
      command: process.execPath,
    }, {
      manualUnregister: true,
    });

    await waitForExit(child);
    const [recordFile] = await registeredChildFiles(tempHome, pid);
    if (recordFile === undefined) throw new Error('managed child record missing');
    await expect(readFile(recordFile, 'utf8')).resolves.toContain('manual-child');

    unregister();
    expect(await registeredChildFiles(tempHome, pid)).toHaveLength(
      process.platform === 'win32' ? 1 : 0,
    );
  });

  it('retains default Windows recovery evidence after a natural root exit', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child.pid === undefined) throw new Error('child pid missing');
    const pid = child.pid;
    registerManagedChildProcess(child, {
      kind: 'natural-exit-child',
      command: process.execPath,
    });

    await waitForExit(child);

    expect(await registeredChildFiles(tempHome, pid)).toHaveLength(
      process.platform === 'win32' ? 1 : 0,
    );
  });

  it('does not let an old unregister delete a newer registration for the same pid', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    child = spawn(process.execPath, ['-e', PARENT_WATCHED_CHILD_SCRIPT], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child.pid === undefined) throw new Error('child pid missing');
    const unregisterOld = registerManagedChildProcess(child, {
      kind: 'old-registration',
      command: process.execPath,
    }, { manualUnregister: true });
    const unregisterCurrent = registerManagedChildProcess(child, {
      kind: 'current-registration',
      command: process.execPath,
    }, { manualUnregister: true });

    unregisterOld();
    const [currentFile] = await registeredChildFiles(tempHome, child.pid);
    if (currentFile === undefined) throw new Error('current child record missing');
    const persisted = JSON.parse(await readFile(currentFile, 'utf8')) as {
      readonly kind?: unknown;
    };
    expect(persisted.kind).toBe('current-registration');

    unregisterCurrent();
    expect(await registeredChildFiles(tempHome, child.pid)).toEqual([]);
  });

  it('prunes an unconfirmed live pid without killing it', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    child = spawn(process.execPath, ['-e', PARENT_WATCHED_CHILD_SCRIPT], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child.pid === undefined) {
      throw new Error('child pid missing');
    }
    const deadOwnerPid = findDeadPid();
    const registrationId = 'fixture-confirmed';
    const source = childRegistryPath(tempHome, child.pid, registrationId);
    const processStartIdentity = readProcessStartIdentity(child.pid);
    if (process.platform === 'win32') expect(processStartIdentity).toBeDefined();
    await writeRegistryRecord(tempHome, {
      version: 4,
      registrationId,
      pid: child.pid,
      ownerPid: deadOwnerPid,
      processStartIdentity,
      registeredAtMs: Date.now(),
      kind: 'test-child',
      command: 'definitely-not-this-process',
      args: ['not-present-in-command-line'],
    });

    const summary = await cleanupRegisteredManagedChildren({ includeCurrentOwner: true });

    expect(summary.killed).toBe(0);
    expect(summary.pruned).toBe(process.platform === 'win32' ? 0 : 1);
    expect(summary.skipped).toBe(process.platform === 'win32' ? 1 : 0);
    if (process.platform === 'win32') {
      await expect(readFile(unresolvedRegistryPath(tempHome, source), 'utf8'))
        .resolves.toContain(registrationId);
    }
    expect(child.exitCode).toBeNull();
  });

  it('does not trust a tampered current-owner registry record', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    child = spawn(process.execPath, ['-e', PARENT_WATCHED_CHILD_SCRIPT], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child.pid === undefined) {
      throw new Error('child pid missing');
    }
    const registrationId = 'fixture-unconfirmed';
    const source = childRegistryPath(tempHome, child.pid, registrationId);
    const processStartIdentity = readProcessStartIdentity(child.pid);
    if (process.platform === 'win32') expect(processStartIdentity).toBeDefined();
    await writeRegistryRecord(tempHome, {
      version: 4,
      registrationId,
      pid: child.pid,
      ownerPid: process.pid,
      ownerProcessStartIdentity: 'reused-owner-pid',
      processStartIdentity,
      registeredAtMs: Date.now(),
      kind: 'test-child',
      command: 'definitely-not-this-process',
      args: ['not-present-in-command-line'],
    });

    const summary = await cleanupRegisteredManagedChildren({ includeCurrentOwner: true });

    expect(summary.killed).toBe(0);
    expect(summary.pruned).toBe(process.platform === 'win32' ? 0 : 1);
    expect(summary.skipped).toBe(process.platform === 'win32' ? 1 : 0);
    if (process.platform === 'win32') {
      await expect(readFile(unresolvedRegistryPath(tempHome, source), 'utf8'))
        .resolves.toContain(registrationId);
    }
    expect(child.exitCode).toBeNull();
  });

  it('does not let current-owner cleanup cross a foreign live owner boundary', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    child = spawn(process.execPath, ['-e', PARENT_WATCHED_CHILD_SCRIPT], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const foreignTarget = spawn(process.execPath, ['-e', PARENT_WATCHED_CHILD_SCRIPT], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child.pid === undefined || foreignTarget.pid === undefined) {
      throw new Error('test process pid missing');
    }
    const registrationId = 'foreign-live-owner';
    await writeRegistryRecord(tempHome, {
      version: 4,
      registrationId,
      pid: foreignTarget.pid,
      ownerPid: child.pid,
      registeredAtMs: Date.now(),
      kind: 'test-child',
      command: process.execPath,
      args: ['-e', PARENT_WATCHED_CHILD_SCRIPT],
    });

    try {
      await expect(cleanupRegisteredManagedChildren({ includeCurrentOwner: true }))
        .resolves.toEqual({ killed: 0, pruned: 0, skipped: 1 });
      expect(foreignTarget.exitCode).toBeNull();
      await expect(readFile(
        childRegistryPath(tempHome, foreignTarget.pid, registrationId),
        'utf8',
      )).resolves.toContain(registrationId);
    } finally {
      if (foreignTarget.exitCode === null && foreignTarget.signalCode === null) {
        await killChildProcessTree(foreignTarget);
      }
    }
  });

  it('keeps a live-owner legacy record in place for mixed-version unregister', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    child = spawn(process.execPath, ['-e', PARENT_WATCHED_CHILD_SCRIPT], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child.pid === undefined) throw new Error('child pid missing');
    const legacyFile = await writeLegacyRegistryRecord(tempHome, {
      version: 1,
      pid: child.pid,
      ownerPid: process.pid,
      registeredAtMs: Date.now(),
      kind: 'legacy-child',
      command: process.execPath,
      args: ['-e', PARENT_WATCHED_CHILD_SCRIPT],
    });

    const summary = await cleanupRegisteredManagedChildren({ includeCurrentOwner: true });

    expect(summary).toMatchObject({ killed: 0, pruned: 0, skipped: 1 });
    await expect(cleanupRegisteredManagedChildren({
      includeCurrentOwner: true,
      requireCurrentOwnerCleanup: true,
    })).rejects.toThrow(/could not verify 1 current-owner process tree/i);
    await expect(readFile(legacyFile, 'utf8')).resolves.toContain('legacy-child');
    await expect(readFile(unresolvedRegistryPath(tempHome, legacyFile), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(child.exitCode).toBeNull();
  });

  it('isolates a legacy record only after both owner and child are gone', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    const deadPid = findDeadPid();
    const legacyFile = await writeLegacyRegistryRecord(tempHome, {
      version: 1,
      pid: deadPid,
      ownerPid: deadPid,
      registeredAtMs: Date.now(),
      kind: 'legacy-child',
      command: process.execPath,
    });

    await expect(cleanupRegisteredManagedChildren()).resolves.toEqual({
      killed: 0,
      pruned: 0,
      skipped: 1,
    });
    const unresolved = unresolvedRegistryPath(tempHome, legacyFile);
    await expect(readFile(unresolved, 'utf8')).resolves.toContain('legacy-child');
    await expect(readFile(legacyFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(cleanupRegisteredManagedChildren()).resolves.toEqual({
      killed: 0,
      pruned: 0,
      skipped: 0,
    });
    await expect(readFile(unresolved, 'utf8')).resolves.toContain('legacy-child');
  });

  it('fails closed when the current owner identity was not captured', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    child = spawn(process.execPath, ['-e', PARENT_WATCHED_CHILD_SCRIPT], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child.pid === undefined) throw new Error('child pid missing');
    await writeRegistryRecord(tempHome, {
      version: 4,
      registrationId: 'fixture-owner-identity-unknown',
      pid: child.pid,
      ownerPid: process.pid,
      registeredAtMs: Date.now(),
      kind: 'test-child',
      command: 'untrusted-command',
    });

    const summary = await cleanupRegisteredManagedChildren();

    expect(summary).toMatchObject({ killed: 0, pruned: 0, skipped: 1 });
    expect(await registeredChildFiles(tempHome, child.pid)).toHaveLength(1);
    expect(child.exitCode).toBeNull();
  });

  it('retains an incomplete Windows tree record after its root pid exits', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    const deadPid = findDeadPid();
    const registrationId = 'fixture-tampered';
    const source = childRegistryPath(tempHome, deadPid, registrationId);
    await writeRegistryRecord(tempHome, {
      version: 4,
      registrationId,
      pid: deadPid,
      ownerPid: deadPid,
      registeredAtMs: Date.now(),
      kind: 'test-child',
      command: process.execPath,
    });

    const summary = await cleanupRegisteredManagedChildren();

    expect(summary.killed).toBe(0);
    expect(summary.pruned).toBe(process.platform === 'win32' ? 0 : 1);
    expect(summary.skipped).toBe(process.platform === 'win32' ? 1 : 0);
    if (process.platform === 'win32') {
      const unresolved = unresolvedRegistryPath(tempHome, source);
      await expect(readFile(unresolved, 'utf8')).resolves.toContain(registrationId);
      expect(await registeredChildFiles(tempHome, deadPid)).toEqual([]);
      await expect(cleanupRegisteredManagedChildren()).resolves.toEqual({
        killed: 0,
        pruned: 0,
        skipped: 0,
      });
      await expect(readFile(unresolved, 'utf8')).resolves.toContain(registrationId);
    }
  });

  it.skipIf(process.platform !== 'win32')(
    'retires current-owner incomplete records only when a Windows Job contains the owner',
    async () => {
      tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
      setAgentConfigHome(tempHome);
      const deadPid = findDeadPid();
      await writeRegistryRecord(tempHome, {
        version: 4,
        registrationId: 'fixture-job-contained',
        pid: deadPid,
        ownerPid: process.pid,
        registeredAtMs: Date.now(),
        kind: 'short-lived-probe',
        command: process.execPath,
        processTreeComplete: false,
      });

      await expect(cleanupRegisteredManagedChildren({
        includeCurrentOwner: true,
        requireCurrentOwnerCleanup: true,
        currentOwnerJobContained: true,
      })).resolves.toEqual({ killed: 0, pruned: 1, skipped: 0 });
      expect(await registeredChildFiles(tempHome, deadPid)).toEqual([]);
    },
  );

  it.skipIf(process.platform !== 'win32')('preserves active recovery evidence when isolation rename fails', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-child-'));
    setAgentConfigHome(tempHome);
    const deadPid = findDeadPid();
    const registrationId = 'fixture-isolation-failure';
    const source = childRegistryPath(tempHome, deadPid, registrationId);
    await writeRegistryRecord(tempHome, {
      version: 4,
      registrationId,
      pid: deadPid,
      ownerPid: deadPid,
      registeredAtMs: Date.now(),
      kind: 'test-child',
      command: process.execPath,
    });
    const renameSync = mutableNodeFs.renameSync;
    mutableNodeFs.renameSync = ((oldPath, newPath) => {
      if (String(oldPath) === source) {
        throw Object.assign(new Error('synthetic isolation failure'), { code: 'EPERM' });
      }
      return renameSync(oldPath, newPath);
    }) as typeof nodeFs.renameSync;
    syncBuiltinESMExports();
    try {
      await expect(cleanupRegisteredManagedChildren()).resolves.toEqual({
        killed: 0,
        pruned: 0,
        skipped: 1,
      });
    } finally {
      mutableNodeFs.renameSync = renameSync;
      syncBuiltinESMExports();
    }
    await expect(readFile(source, 'utf8')).resolves.toContain(registrationId);
    await expect(readFile(unresolvedRegistryPath(tempHome, source), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
