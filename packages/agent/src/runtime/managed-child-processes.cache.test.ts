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
      stdout: JSON.stringify({ ProcessId: process.pid, CreationDate: creationDate }),
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
      stdout: JSON.stringify({ ProcessId: process.ppid, CreationDate: creationDate }),
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
      stdout: JSON.stringify(ownerPids.map((ProcessId) => ({
        ProcessId,
        CreationDate: creationDate,
      }))),
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
      return { status: 0, stdout: JSON.stringify({ ProcessId: process.ppid, CreationDate: creationDate }) };
    });

    await expect(cleanupRegisteredManagedChildren()).resolves.toEqual({ killed: 0, pruned: 0, skipped: 1 });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    await expect(readFile(file, 'utf8')).resolves.toBe(replacement);
  });
});
