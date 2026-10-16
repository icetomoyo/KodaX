import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>(
    'node:child_process',
  );
  return { ...actual, spawnSync: spawnSyncMock };
});

import { setAgentConfigHome } from './agent-home.js';
import { cleanupRegisteredManagedChildren } from './managed-child-processes.js';

describe.runIf(process.platform === 'win32')('managed child cleanup query reuse', () => {
  let tempHome = '';

  afterEach(async () => {
    vi.restoreAllMocks();
    spawnSyncMock.mockReset();
    setAgentConfigHome(undefined);
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
    tempHome = '';
  });

  it('queries one current owner identity once for all of its records', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-owner-cache-'));
    setAgentConfigHome(tempHome);
    const creationDate = '2026-08-01T00:00:00.000Z';
    const creationMs = Date.parse(creationDate);
    const ownerProcessStartIdentity =
      `windows:${(BigInt(creationMs) + 11_644_473_600_000n).toString()}`;
    spawnSyncMock.mockReturnValue({
      pid: 1,
      output: [null, '', ''],
      stdout: `${process.pid},1,${ownerProcessStartIdentity.slice('windows:'.length)}`,
      stderr: '',
      status: 0,
      signal: null,
    });

    const registry = path.join(tempHome, 'runtime', 'processes', 'children');
    await mkdir(registry, { recursive: true });
    for (let index = 0; index < 4; index += 1) {
      const registrationId = `same-owner-${index}`;
      await writeFile(path.join(registry, `${90_000 + index}.${registrationId}.json`), JSON.stringify({
        version: 4,
        registrationId,
        pid: 90_000 + index,
        ownerPid: process.pid,
        ownerProcessStartIdentity,
        registeredAtMs: Date.now(),
        kind: 'test-child',
        command: process.execPath,
      }), 'utf8');
    }

    await expect(cleanupRegisteredManagedChildren()).resolves.toMatchObject({
      killed: 0,
      pruned: 0,
      skipped: 4,
    });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it('reuses the owner identity query for Run-owned records in the same sweep', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-run-owner-cache-'));
    setAgentConfigHome(tempHome);
    const creationDate = '2026-08-01T00:00:00.000Z';
    const ownerProcessStartIdentity =
      `windows:${(BigInt(Date.parse(creationDate)) + 11_644_473_600_000n).toString()}`;
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: `${process.ppid},1,${ownerProcessStartIdentity.slice('windows:'.length)}`,
    });
    const registry = path.join(tempHome, 'runtime', 'processes', 'children');
    await mkdir(registry, { recursive: true });
    for (let index = 0; index < 4; index += 1) {
      const pid = 92_000 + index;
      const registrationId = `95bc0da4-8673-43c6-a8e7-a2c081da6dc${index}`;
      await writeFile(path.join(registry, `${pid}.${registrationId}.json`), JSON.stringify({
        version: 4, registrationId, pid, ownerPid: process.ppid,
        ownerProcessStartIdentity, registeredAtMs: Date.now(),
        kind: 'bash', command: process.execPath, runtimeRunId: 'run-a',
      }), 'utf8');
    }

    await expect(cleanupRegisteredManagedChildren()).resolves.toEqual({
      killed: 0, pruned: 0, skipped: 4,
    });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it('preserves extinct incomplete Run trees whose PIDs were reused without attempting termination', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-reused-run-pids-'));
    setAgentConfigHome(tempHome);
    const ownerPid = 93_000;
    const pids = [93_001, 93_002, 93_003];
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pids.includes(pid)) return true;
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: pids.map((pid) => `${pid},4,222`).join('\n'),
    });
    const registry = path.join(tempHome, 'runtime', 'processes', 'children');
    await mkdir(registry, { recursive: true });
    const records = pids.map((pid) => {
      const registrationId = '95bc0da4-8673-43c6-a8e7-a2c081da6dce';
      return {
        file: path.join(registry, `${pid}.${registrationId}.json`),
        bytes: JSON.stringify({
          version: 4, registrationId, pid, ownerPid,
          ownerProcessStartIdentity: 'windows:old-owner', registeredAtMs: Date.now(),
          kind: 'bash', command: process.execPath, runtimeRunId: 'run-a',
          processStartIdentity: '111', processTreeComplete: false,
          processTreeIdentities: [{ pid, creationTime: '111' }],
        }),
      };
    });
    await Promise.all(records.map(({ file, bytes }) => writeFile(file, bytes)));

    const paint = vi.fn();
    const nextFrame = setImmediate(paint);
    try {
      await expect(cleanupRegisteredManagedChildren()).resolves.toEqual({
        killed: 0, pruned: 0, skipped: 3,
      });
      expect(paint).toHaveBeenCalledOnce();
    } finally {
      clearImmediate(nextFrame);
    }
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const script = spawnSyncMock.mock.calls[0]?.[1]?.join(' ') as string;
    expect(script).not.toContain('[KodaXNativeProcessSnapshot]::TerminateExact(');
    for (const { file, bytes } of records) {
      await expect(readFile(file, 'utf8')).resolves.toBe(bytes);
    }
  });

  it.each(['unreadable', 'permission-denied', 'missing'] as const)(
    'preserves incomplete Run trees with %s live identities without attempting termination',
    async evidence => {
      tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-unknown-run-pids-'));
      const ownerPid = 93_000;
      const pids = Array.from({ length: 32 }, (_, index) => 93_001 + index);
      const signal = vi.spyOn(process, 'kill').mockImplementation((pid, value) => {
        if (value !== 0) throw new Error('Cleanup must not signal an unverified process');
        if (pids.includes(pid)) {
          if (evidence === 'permission-denied') throw Object.assign(new Error('denied'), { code: 'EPERM' });
          return true;
        }
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      });
      spawnSyncMock.mockReturnValue({ status: 0,
        stdout: evidence === 'missing' ? '4,0,0' : pids.map(pid => `${pid},4,0`).join('\n'),
      });
      const directory = path.join(tempHome, 'runtime', 'processes', 'children');
      await mkdir(directory, { recursive: true });
      const records = pids.map(pid => {
        const registrationId = '95bc0da4-8673-43c6-a8e7-a2c081da6dce';
        return { file: path.join(directory, `${pid}.${registrationId}.json`),
          bytes: JSON.stringify({ version: 4, registrationId, pid, ownerPid,
            registeredAtMs: 100, kind: 'bash', command: process.execPath, runtimeRunId: 'run-a',
            processStartIdentity: '111', processTreeComplete: false,
            processTreeIdentities: [{ pid, creationTime: '111' }],
          }),
        };
      });
      await Promise.all(records.map(({ file, bytes }) => writeFile(file, bytes)));

      await expect(cleanupRegisteredManagedChildren({ configHome: tempHome })).resolves.toEqual({
        killed: 0, pruned: 0, skipped: pids.length,
      });
      expect(spawnSyncMock.mock.calls.some(([, args]) =>
        (args as string[]).join(' ').includes('[KodaXNativeProcessSnapshot]::TerminateExact('),
      )).toBe(false);
      expect(spawnSyncMock.mock.calls.length).toBeLessThanOrEqual(1);
      expect(signal.mock.calls.every(([, value]) => value === 0)).toBe(true);
      for (const { file, bytes } of records) await expect(readFile(file, 'utf8')).resolves.toBe(bytes);
    },
  );

  it('still attempts exact cleanup for a verified descendant of an unreadable incomplete root', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-known-descendant-'));
    const pid = 93_001;
    const descendantPid = 93_002;
    vi.spyOn(process, 'kill').mockImplementation((target, value) => {
      if (value !== 0) throw new Error('Cleanup must use exact process identities');
      if (target === pid || target === descendantPid) return true;
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    spawnSyncMock.mockReturnValue({ status: 0, stdout: `${pid},4,0\n${descendantPid},4,112` });
    const directory = path.join(tempHome, 'runtime', 'processes', 'children');
    await mkdir(directory, { recursive: true });
    const registrationId = '95bc0da4-8673-43c6-a8e7-a2c081da6dce';
    const file = path.join(directory, `${pid}.${registrationId}.json`);
    const bytes = JSON.stringify({ version: 4, registrationId, pid, ownerPid: 93_000,
      registeredAtMs: 100, kind: 'bash', command: process.execPath, runtimeRunId: 'run-a',
      processStartIdentity: '111', processTreeComplete: false, processTreeIdentities: [
        { pid, creationTime: '111' }, { pid: descendantPid, creationTime: '112' },
      ],
    });
    await writeFile(file, bytes);

    await expect(cleanupRegisteredManagedChildren({ configHome: tempHome })).resolves.toEqual({
      killed: 0, pruned: 0, skipped: 1,
    });
    expect(spawnSyncMock.mock.calls.some(([, args]) => (args as string[]).join(' ')
      .includes(`[KodaXNativeProcessSnapshot]::TerminateExact(${descendantPid}, [UInt64]112)`),
    )).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(bytes);
  });

  it('queries all live owner identities in one Windows process snapshot', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-owner-batch-'));
    setAgentConfigHome(tempHome);
    const creationDate = '2026-08-01T00:00:00.000Z';
    const creationMs = Date.parse(creationDate);
    const ownerProcessStartIdentity =
      `windows:${(BigInt(creationMs) + 11_644_473_600_000n).toString()}`;
    const ownerPids = [process.pid, process.ppid];
    spawnSyncMock.mockReturnValue({
      pid: 1,
      output: [null, '', ''],
      stdout: ownerPids.map(pid => `${pid},1,${ownerProcessStartIdentity.slice('windows:'.length)}`).join('\n'),
      stderr: '',
      status: 0,
      signal: null,
    });

    const registry = path.join(tempHome, 'runtime', 'processes', 'children');
    await mkdir(registry, { recursive: true });
    for (const [index, ownerPid] of ownerPids.entries()) {
      const registrationId = `distinct-owner-${index}`;
      await writeFile(path.join(registry, `${91_000 + index}.${registrationId}.json`), JSON.stringify({
        version: 4,
        registrationId,
        pid: 91_000 + index,
        ownerPid,
        ownerProcessStartIdentity,
        registeredAtMs: Date.now(),
        kind: 'test-child',
        command: process.execPath,
      }), 'utf8');
    }

    await expect(cleanupRegisteredManagedChildren()).resolves.toMatchObject({
      killed: 0,
      pruned: 0,
      skipped: ownerPids.length,
    });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it('uses one OS observation for stale Owner identity and retained tree PID reuse', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-owner-tree-batch-'));
    setAgentConfigHome(tempHome);
    const pid = 95_001;
    const creationDate = '2026-08-01T00:00:00.000Z';
    const ownerIdentity = (BigInt(Date.parse(creationDate)) + 11_644_473_600_000n).toString();
    vi.spyOn(process, 'kill').mockImplementation(target => {
      if (target === process.ppid || target === pid) return true;
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    spawnSyncMock.mockImplementation((_command, args: string[]) => ({ status: 0,
      stdout: args.join(' ').includes('KodaXNativeProcessSnapshot')
        ? `${process.ppid},1,${ownerIdentity}\n${pid},4,222\n`
        : JSON.stringify({ ProcessId: process.ppid, CreationDate: creationDate }),
    }));
    const directory = path.join(tempHome, 'runtime', 'processes', 'children');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${pid}.95bc0da4-8673-43c6-a8e7-a2c081da6dce.json`);
    const evidence = JSON.stringify({ version: 4, registrationId: '95bc0da4-8673-43c6-a8e7-a2c081da6dce',
      pid, ownerPid: process.ppid, ownerProcessStartIdentity: 'windows:old', registeredAtMs: Date.now(),
      kind: 'bash', command: process.execPath, runtimeRunId: 'run-a', processStartIdentity: '111',
      processTreeComplete: false, processTreeIdentities: [{ pid, creationTime: '111' }],
    });
    await writeFile(file, evidence);
    await expect(cleanupRegisteredManagedChildren()).resolves.toEqual({ killed: 0, pruned: 0, skipped: 1 });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(await readFile(file, 'utf8')).toBe(evidence);
  });

  it('does not apply a cached owner identity to a Run record replaced after the owner query', async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'kodax-managed-replaced-run-owner-'));
    setAgentConfigHome(tempHome);
    const pid = 94_001;
    vi.spyOn(process, 'kill').mockImplementation((target) => {
      if (target === pid || target === process.ppid) return true;
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    const creationDate = '2026-08-01T00:00:00.000Z';
    const registrationId = '95bc0da4-8673-43c6-a8e7-a2c081da6dce';
    const record = {
      version: 4, registrationId, pid, ownerPid: process.ppid,
      ownerProcessStartIdentity: `windows:${(BigInt(Date.parse(creationDate)) + 11_644_473_600_000n).toString()}`,
      registeredAtMs: Date.now(), kind: 'bash', command: process.execPath,
      runtimeRunId: 'run-a', processStartIdentity: '111', processTreeComplete: false,
      processTreeIdentities: [{ pid, creationTime: '111' }],
    };
    const registry = path.join(tempHome, 'runtime', 'processes', 'children');
    await mkdir(registry, { recursive: true });
    const file = path.join(registry, `${pid}.${registrationId}.json`);
    await writeFile(file, JSON.stringify(record));
    const replacement = JSON.stringify({ ...record, ownerProcessStartIdentity: 'windows:new-owner' });
    spawnSyncMock.mockImplementation(() => {
      writeFileSync(file, replacement);
      return { status: 0, stdout: `${process.ppid},1,${record.ownerProcessStartIdentity.slice('windows:'.length)}` };
    });

    await expect(cleanupRegisteredManagedChildren()).resolves.toEqual({ killed: 0, pruned: 0, skipped: 1 });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    await expect(readFile(file, 'utf8')).resolves.toBe(replacement);
  });
});
