import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import nodeFs from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const processTree = vi.hoisted(() => ({ killChild: vi.fn(), killPid: vi.fn(), capture: vi.fn() }));
vi.mock('./process-tree.js', async () => ({
  ...await vi.importActual<typeof import('./process-tree.js')>('./process-tree.js'),
  rememberChildProcessTree: () => '111',
  rememberedChildProcessTreeIdentities: () => [{ pid: 91234, creationTime: '111' }],
  rememberedChildProcessTreeIsComplete: () => true,
  killChildProcessTree: processTree.killChild,
  killPidTree: processTree.killPid,
  captureWindowsProcessTree: processTree.capture,
}));
vi.mock('node:child_process', async () => ({
  ...await vi.importActual<typeof import('node:child_process')>('node:child_process'),
  spawnSync: () => ({ status: 0, stdout: JSON.stringify({ CreationDate: '2026-08-01T00:00:00.000Z' }) }),
}));
import { setAgentConfigHome } from './agent-home.js';
import { cleanupManagedRunChildProcess, cleanupRegisteredManagedChildren, registerManagedChildProcess,
  type ManagedRunChildProcessReference } from './managed-child-processes.js';

let home = '';
let unregister: (() => void) | undefined;
afterEach(async () => {
  unregister?.();
  unregister = undefined;
  vi.restoreAllMocks();
  processTree.killChild.mockReset();
  processTree.killPid.mockReset();
  processTree.capture.mockReset();
  setAgentConfigHome(undefined);
  if (home) await rm(home, { recursive: true, force: true });
});

it('cleans only the referenced Run and retains proof until its owner releases it', async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kodax-run-child-'));
  setAgentConfigHome(home);
  const child = Object.assign(new EventEmitter(), { pid: 91234, exitCode: null, signalCode: null }) as ChildProcess;
  let reference: ManagedRunChildProcessReference | undefined;
  unregister = registerManagedChildProcess(child, { kind: 'bash', command: 'test', runtimeRunId: 'run-a' }, {
    manualUnregister: true, requireDurableRecord: true, onRegistered: (value) => { reference = value; },
  });
  expect(reference).toMatchObject({ runtimeRunId: 'run-a', pid: 91234 });
  if (!reference) throw new Error('Run child reference missing');
  processTree.killChild.mockResolvedValue({ status: 'terminated' });
  const result = await cleanupManagedRunChildProcess(reference);
  expect(result.status).toBe('verified');
  expect(processTree.killChild).toHaveBeenCalledWith(child);
  expect(processTree.killPid).not.toHaveBeenCalled();
  const file = path.join(home, 'runtime', 'processes', 'children', `${reference.pid}.${reference.registrationId}.json`);
  await expect(readFile(file, 'utf8')).resolves.toContain('run-a');
  await expect(cleanupManagedRunChildProcess(reference)).resolves.toMatchObject({ status: 'verified' });
  if (result.status === 'verified') { result.release(); result.release(); }
  await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not infer successful Run cleanup from missing registration evidence', async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kodax-run-child-'));
  setAgentConfigHome(home);
  await expect(cleanupManagedRunChildProcess({ runtimeRunId: 'run-a', pid: 91234,
    registrationId: '95bc0da4-8673-43c6-a8e7-a2c081da6dce' })).resolves.toEqual({ status: 'unknown' });
});

it('retires Run-labelled children that never registered a Runtime cleanup fence', async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kodax-run-child-'));
  setAgentConfigHome(home);
  const child = Object.assign(new EventEmitter(), { pid: 91234, exitCode: null, signalCode: null }) as ChildProcess;
  unregister = registerManagedChildProcess(child, { kind: 'bash', command: 'background', runtimeRunId: 'run-a' }, {
    manualUnregister: true, requireDurableRecord: true,
  });
  processTree.killChild.mockResolvedValue({ status: 'terminated' });
  processTree.killPid.mockResolvedValue({ status: 'terminated' });
  expect(await cleanupRegisteredManagedChildren({ includeCurrentOwner: true })).toMatchObject({ killed: 1 });
  const files = await readdir(path.join(home, 'runtime', 'processes', 'children'));
  expect(files.filter((file) => file.endsWith('.json'))).toEqual([]);
});

async function persistedRunChild(ownerPid = 91235): Promise<ManagedRunChildProcessReference> {
  home = await mkdtemp(path.join(tmpdir(), 'kodax-run-child-'));
  setAgentConfigHome(home);
  const reference = { runtimeRunId: 'run-a', pid: 91234, registrationId: '95bc0da4-8673-43c6-a8e7-a2c081da6dce' };
  const directory = path.join(home, 'runtime', 'processes', 'children');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${reference.pid}.${reference.registrationId}.json`), JSON.stringify({
    ...reference, version: 4, ownerPid, registeredAtMs: 100,
    kind: 'bash', command: 'test', processStartIdentity: '111',
    processTreeIdentities: [{ pid: 91234, creationTime: '111' }], processTreeComplete: true,
  }));
  return reference;
}

it.runIf(process.platform === 'win32')('keeps 122 extinct incomplete Run records unchanged without process-tree queries', async () => {
  const reference = await persistedRunChild(91233);
  const directory = path.join(home, 'runtime', 'processes', 'children');
  const originalFile = path.join(directory, `${reference.pid}.${reference.registrationId}.json`);
  const record = JSON.parse(await readFile(originalFile, 'utf8')) as Record<string, unknown>;
  const records = Array.from({ length: 122 }, (_, index) => {
    const pid = reference.pid + index;
    const bytes = JSON.stringify({ ...record, pid, processTreeComplete: false,
      processTreeIdentities: [{ pid, creationTime: '111' }] });
    return { file: path.join(directory, `${pid}.${reference.registrationId}.json`), bytes };
  });
  await Promise.all(records.map(({ file, bytes }) => writeFile(file, bytes)));
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  processTree.capture.mockReturnValue(null);
  processTree.killPid.mockResolvedValue({ status: 'unknown' });

  expect(await cleanupRegisteredManagedChildren()).toEqual({ killed: 0, pruned: 0, skipped: 122 });
  expect(processTree.capture).not.toHaveBeenCalled();
  expect(processTree.killPid).not.toHaveBeenCalled();
  expect(processTree.killChild).not.toHaveBeenCalled();
  for (const { file, bytes } of records) await expect(readFile(file, 'utf8')).resolves.toBe(bytes);
});

it.runIf(process.platform === 'win32').each([
  { name: 'live root', livePid: 91234 },
  { name: 'live retained descendant', livePid: 91236 },
  { name: 'live uncertain descendant', livePid: 91236, descendantIdentity: '0' },
  { name: 'unreadable root', errorPid: 91234, errorCode: 'EPERM' },
  { name: 'unreadable descendant', errorPid: 91236, errorCode: 'EPERM' },
  { name: 'failed descendant query', errorPid: 91236, errorCode: 'EIO' },
  { name: 'zero descendant PID', descendantPid: 0 },
  { name: 'negative descendant PID', descendantPid: -1 },
  { name: 'fractional descendant PID', descendantPid: 1.5 },
  { name: 'unsafe descendant PID', descendantPid: Number.MAX_SAFE_INTEGER + 1 },
  { name: 'mismatched retained root', rootIdentity: '222' },
  { name: 'missing retained root', omitRoot: true },
  { name: 'complete process tree', completeTree: true },
])('still attempts exact Run cleanup with $name', async (scenario) => {
  const reference = await persistedRunChild();
  const file = path.join(home, 'runtime', 'processes', 'children', `${reference.pid}.${reference.registrationId}.json`);
  const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  const identities = [
    ...(scenario.omitRoot ? [] : [{ pid: reference.pid, creationTime: scenario.rootIdentity ?? '111' }]),
    { pid: scenario.descendantPid ?? 91236, creationTime: scenario.descendantIdentity ?? '112' },
  ];
  const bytes = JSON.stringify({ ...record, processTreeComplete: scenario.completeTree ?? false,
    processTreeIdentities: identities });
  await writeFile(file, bytes);
  vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (pid === scenario.livePid) return true;
    throw Object.assign(new Error('query'), { code: pid === scenario.errorPid ? scenario.errorCode : 'ESRCH' });
  });
  processTree.capture.mockReturnValue(null);
  processTree.killPid.mockResolvedValue({ status: 'unknown' });

  expect(await cleanupManagedRunChildProcess(reference)).toEqual({ status: 'unknown' });
  expect(processTree.capture).toHaveBeenCalledWith(reference.pid, '111');
  expect(processTree.killPid).toHaveBeenCalledWith(reference.pid, {
    expectedProcessStartIdentity: '111', expectedProcessTreeComplete: scenario.completeTree ?? false,
    expectedProcessTreeIdentities: identities,
  });
  await expect(readFile(file, 'utf8')).resolves.toBe(bytes);
});

it.runIf(process.platform === 'win32').each([false, undefined])(
  'rechecks extinct known and uncertain descendants on each incomplete cleanup (complete: %s)', async (complete) => {
    const reference = await persistedRunChild();
    const file = path.join(home, 'runtime', 'processes', 'children', `${reference.pid}.${reference.registrationId}.json`);
    const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const bytes = JSON.stringify({ ...record, processTreeComplete: complete, processTreeIdentities: [
      { pid: reference.pid, creationTime: '111' }, { pid: 91236, creationTime: '112' }, { pid: 91237, creationTime: '0' },
    ] });
    await writeFile(file, bytes);
    let descendantAlive = false;
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (descendantAlive && pid === 91237) return true;
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    processTree.capture.mockReturnValue(null);
    processTree.killPid.mockResolvedValue({ status: 'unknown' });
    expect(await cleanupManagedRunChildProcess(reference)).toEqual({ status: 'unknown' });
    expect(kill).toHaveBeenCalledWith(91236, 0);
    expect(kill).toHaveBeenCalledWith(91237, 0);
    expect(processTree.capture).not.toHaveBeenCalled();
    expect(processTree.killPid).not.toHaveBeenCalled();
    await expect(readFile(file, 'utf8')).resolves.toBe(bytes);

    descendantAlive = true;
    expect(await cleanupManagedRunChildProcess(reference)).toEqual({ status: 'unknown' });
    expect(processTree.capture).toHaveBeenCalledOnce();
    expect(processTree.killPid).toHaveBeenCalledOnce();
    await expect(readFile(file, 'utf8')).resolves.toBe(bytes);
  },
);

it.runIf(process.platform === 'win32').each(['live', 'EPERM'])(
  'checks the %s owner before inspecting an incomplete Run tree', async (ownerState) => {
    const reference = await persistedRunChild();
    const file = path.join(home, 'runtime', 'processes', 'children', `${reference.pid}.${reference.registrationId}.json`);
    const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...record, processTreeComplete: false }));
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 91235 && ownerState === 'live') return true;
      throw Object.assign(new Error('query'), { code: pid === 91235 ? ownerState : 'ESRCH' });
    });
    expect(await cleanupManagedRunChildProcess(reference)).toEqual({ status: 'unknown' });
    expect(kill).toHaveBeenCalledExactlyOnceWith(91235, 0);
    expect(processTree.capture).not.toHaveBeenCalled();
    expect(processTree.killPid).not.toHaveBeenCalled();
  },
);

it('keeps incomplete dead-owner POSIX cleanup on the existing termination path', async () => {
  const reference = await persistedRunChild();
  const file = path.join(home, 'runtime', 'processes', 'children', `${reference.pid}.${reference.registrationId}.json`);
  const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...record, processTreeComplete: false }));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  processTree.killPid.mockResolvedValue({ status: 'unknown' });
  try {
    expect(await cleanupManagedRunChildProcess(reference)).toEqual({ status: 'unknown' });
    expect(processTree.killPid).toHaveBeenCalledWith(reference.pid, {
      expectedProcessStartIdentity: '111', expectedProcessTreeComplete: false,
      expectedProcessTreeIdentities: [{ pid: reference.pid, creationTime: '111' }],
    });
  } finally { Object.defineProperty(process, 'platform', platform); }
});

it('keeps an owned incomplete Run on its exact child-handle cleanup path', async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kodax-run-child-'));
  setAgentConfigHome(home);
  const child = Object.assign(new EventEmitter(), { pid: 91234, exitCode: null, signalCode: null }) as ChildProcess;
  let reference: ManagedRunChildProcessReference | undefined;
  unregister = registerManagedChildProcess(child, { kind: 'bash', command: 'test', runtimeRunId: 'run-a' }, {
    manualUnregister: true, requireDurableRecord: true, onRegistered: (value) => { reference = value; },
  });
  if (!reference) throw new Error('Run child reference missing');
  const file = path.join(home, 'runtime', 'processes', 'children', `${reference.pid}.${reference.registrationId}.json`);
  const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...record, processTreeComplete: false }));
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  processTree.killChild.mockResolvedValue({ status: 'unknown' });
  expect(await cleanupManagedRunChildProcess(reference)).toEqual({ status: 'unknown' });
  expect(processTree.killChild).toHaveBeenCalledWith(child);
  expect(processTree.killPid).not.toHaveBeenCalled();
  expect(kill).not.toHaveBeenCalled();
});

it.each([false, true])('keeps verified dead-owner Run cleanup recoverable after a global child sweep (root alive: %s)', async (rootAlive) => {
  const reference = await persistedRunChild();
  const file = path.join(home, 'runtime', 'processes', 'children', `${reference.pid}.${reference.registrationId}.json`);
  vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (rootAlive && pid === reference.pid) return true;
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  processTree.killPid.mockResolvedValue({ status: 'terminated' });
  expect(await cleanupRegisteredManagedChildren()).toMatchObject({ killed: 1, skipped: 0 });
  await expect(readFile(file, 'utf8')).resolves.toContain('run-a');
  processTree.killPid.mockResolvedValue({ status: 'unknown' });
  const recovered = await cleanupManagedRunChildProcess(reference);
  expect(recovered.status).toBe('verified');
  expect(processTree.killPid).toHaveBeenCalledOnce();
  if (recovered.status === 'verified') recovered.release();
  await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([false, true])('retains POSIX dead-owner evidence without inventing identity (root alive: %s)', async (rootAlive) => {
  const reference = await persistedRunChild();
  const file = path.join(home, 'runtime', 'processes', 'children', `${reference.pid}.${reference.registrationId}.json`);
  const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  delete record.processStartIdentity;
  await writeFile(file, JSON.stringify(record));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (rootAlive && pid === reference.pid) return true;
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  try {
    expect(await cleanupRegisteredManagedChildren()).toEqual({ killed: 0, pruned: 0, skipped: 1 });
    expect(await cleanupManagedRunChildProcess(reference)).toEqual({ status: 'unknown' });
    expect(processTree.killPid).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(file, 'utf8')).cleanupVerified).toBeUndefined();
  } finally { Object.defineProperty(process, 'platform', platform); }
});

it('retains current-owner cleanup proof through late exit refresh and PID reuse', async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kodax-run-child-'));
  setAgentConfigHome(home);
  const child = Object.assign(new EventEmitter(), { pid: 91234, exitCode: null, signalCode: null }) as ChildProcess;
  let reference: ManagedRunChildProcessReference | undefined;
  unregister = registerManagedChildProcess(child, { kind: 'bash', command: 'test', runtimeRunId: 'run-a' }, {
    manualUnregister: true, requireDurableRecord: true, onRegistered: (value) => { reference = value; },
  });
  if (!reference) throw new Error('Run child reference missing');
  processTree.killChild.mockResolvedValue({ status: 'already-exited' });
  expect(await cleanupRegisteredManagedChildren({ includeCurrentOwner: true, currentOwnerJobContained: true }))
    .toMatchObject({ killed: 1, pruned: 0 });
  child.emit('exit', 0);
  const file = path.join(home, 'runtime', 'processes', 'children', `${reference.pid}.${reference.registrationId}.json`);
  expect(JSON.parse(await readFile(file, 'utf8')).cleanupVerified).toBe(true);
  processTree.killChild.mockResolvedValue({ status: 'unknown' });
  const recovered = await cleanupManagedRunChildProcess(reference);
  expect(recovered.status).toBe('verified');
  expect(processTree.killChild).toHaveBeenCalledOnce();
  expect(processTree.killPid).not.toHaveBeenCalled();
  if (recovered.status === 'verified') recovered.release();
  child.emit('exit', 0);
  await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not use current-owner Job containment as proof of a Run tree drain', async () => {
  const reference = await persistedRunChild(process.pid);
  processTree.killPid.mockResolvedValue({ status: 'unknown' });
  expect(await cleanupRegisteredManagedChildren({ includeCurrentOwner: true, currentOwnerJobContained: true }))
    .toEqual({ killed: 0, pruned: 0, skipped: 1 });
  expect(await cleanupManagedRunChildProcess(reference)).toEqual({ status: 'unknown' });
  expect(processTree.killPid).not.toHaveBeenCalled();
});

it('does not revive a registry record released while another cleanup was awaiting termination', async () => {
  const reference = await persistedRunChild();
  const file = path.join(home, 'runtime', 'processes', 'children', `${reference.pid}.${reference.registrationId}.json`);
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  let finish!: (result: { status: 'terminated' }) => void;
  processTree.killPid.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValue({ status: 'terminated' });
  const pending = cleanupManagedRunChildProcess(reference);
  const completed = await cleanupManagedRunChildProcess(reference);
  if (completed.status === 'verified') completed.release();
  finish({ status: 'terminated' });
  expect(await pending).toEqual({ status: 'unknown' });
  await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['ownerPid', 'ownerProcessStartIdentity', 'processStartIdentity', 'runtimeRunId', 'registrationId'] as const)(
  'does not certify a replaced registration after awaiting termination (%s)', async (field) => {
    const reference = await persistedRunChild();
    const file = path.join(home, 'runtime', 'processes', 'children', `${reference.pid}.${reference.registrationId}.json`);
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    processTree.killPid.mockImplementation(async () => {
      const replacement = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      replacement[field] = field === 'ownerPid' ? 91236 : 'replaced';
      await writeFile(file, JSON.stringify(replacement));
      return { status: 'terminated' };
    });
    expect(await cleanupManagedRunChildProcess(reference)).toEqual({ status: 'unknown' });
    const retained = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(retained[field]).toBe(field === 'ownerPid' ? 91236 : 'replaced');
    expect(retained.cleanupVerified).toBeUndefined();
  },
);

it('does not report verified cleanup if persisting the verification fails', async () => {
  const reference = await persistedRunChild();
  const file = path.join(home, 'runtime', 'processes', 'children', `${reference.pid}.${reference.registrationId}.json`);
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  processTree.killPid.mockResolvedValue({ status: 'terminated' });
  const mutableFs = createRequire(import.meta.url)('node:fs') as { writeFileSync: typeof nodeFs.writeFileSync };
  const write = mutableFs.writeFileSync;
  mutableFs.writeFileSync = () => { throw new Error('verification write unavailable'); };
  syncBuiltinESMExports();
  try {
    await expect(cleanupManagedRunChildProcess(reference)).rejects.toThrow('verification write unavailable');
    expect(JSON.parse(await readFile(file, 'utf8')).cleanupVerified).toBeUndefined();
  } finally { mutableFs.writeFileSync = write; syncBuiltinESMExports(); }
});

it('recovers an exact dead-owner Run using retained process identities', async () => {
  const reference = await persistedRunChild();
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  processTree.killPid.mockResolvedValue({ status: 'terminated' });
  await expect(cleanupManagedRunChildProcess(reference)).resolves.toMatchObject({ status: 'verified' });
  expect(processTree.killPid).toHaveBeenCalledWith(reference.pid, {
    expectedProcessStartIdentity: '111', expectedProcessTreeComplete: true,
    expectedProcessTreeIdentities: [{ pid: 91234, creationTime: '111' }],
  });
});

it.each(['other-run', 'other-reference', 'missing-identity', 'live-owner', 'unreadable-owner', 'unknown-tree'] as const)(
  'preserves uncertain evidence without affecting other Runs: %s', async (scenario) => {
    const reference = await persistedRunChild();
    const file = path.join(home, 'runtime', 'processes', 'children', `${reference.pid}.${reference.registrationId}.json`);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (scenario === 'live-owner') return true;
      throw Object.assign(new Error('unavailable'), { code: scenario === 'unreadable-owner' ? 'EPERM' : 'ESRCH' });
    });
    if (scenario === 'missing-identity') {
      const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      delete record.processStartIdentity;
      await writeFile(file, JSON.stringify(record));
    }
    processTree.killPid.mockResolvedValue({ status: 'unknown' });
    const requested = scenario === 'other-run' ? { ...reference, runtimeRunId: 'run-b' }
      : scenario === 'other-reference' ? { ...reference, registrationId: '85bc0da4-8673-43c6-a8e7-a2c081da6dce' }
      : reference;
    await expect(cleanupManagedRunChildProcess(requested)).resolves.toEqual({ status: 'unknown' });
    if (scenario !== 'unknown-tree') expect(processTree.killPid).not.toHaveBeenCalled();
    await expect(readFile(file, 'utf8')).resolves.toContain('run-a');
  },
);

it('does not release evidence replaced while a verified result awaited persistence', async () => {
  const reference = await persistedRunChild();
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  processTree.killPid.mockResolvedValue({ status: 'terminated' });
  const result = await cleanupManagedRunChildProcess(reference);
  expect(result.status).toBe('verified');
  const file = path.join(home, 'runtime', 'processes', 'children', `${reference.pid}.${reference.registrationId}.json`);
  const replacement = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  replacement.processStartIdentity = '222';
  await writeFile(file, JSON.stringify(replacement));
  if (result.status === 'verified') result.release();
  await expect(readFile(file, 'utf8')).resolves.toContain('222');
});

it('does not borrow a live child handle when persisted Run ownership was replaced', async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kodax-run-child-'));
  setAgentConfigHome(home);
  const child = Object.assign(new EventEmitter(), { pid: 91234, exitCode: null, signalCode: null }) as ChildProcess;
  let reference: ManagedRunChildProcessReference | undefined;
  unregister = registerManagedChildProcess(child, { kind: 'bash', command: 'test', runtimeRunId: 'run-a' }, {
    manualUnregister: true, requireDurableRecord: true, onRegistered: (value) => { reference = value; },
  });
  if (!reference) throw new Error('Run child reference missing');
  const file = path.join(home, 'runtime', 'processes', 'children', `${reference.pid}.${reference.registrationId}.json`);
  const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...record, runtimeRunId: 'run-b' }));
  processTree.killChild.mockResolvedValue({ status: 'terminated' });
  await expect(cleanupManagedRunChildProcess({ ...reference, runtimeRunId: 'run-b' }))
    .resolves.toEqual({ status: 'unknown' });
  expect(processTree.killChild).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'win32')('preserves the complete tree before dead-owner termination for retries after root exit', async () => {
  const reference = await persistedRunChild();
  const file = path.join(home, 'runtime', 'processes', 'children', `${reference.pid}.${reference.registrationId}.json`);
  const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...record, processTreeComplete: false }));
  vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (pid === reference.pid) return true;
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  processTree.capture.mockReturnValueOnce({ root: { pid: 91234, parentPid: 1, creationTime: '111' },
    descendants: [{ pid: 91236, parentPid: 91234, creationTime: '112' }],
    uncertainDescendantPids: [], completeTree: true }).mockReturnValue(null);
  processTree.killPid.mockImplementation(async (_pid: number, options: { expectedProcessTreeComplete: boolean }) => (
    { status: options.expectedProcessTreeComplete ? 'terminated' : 'unknown' }
  ));
  await expect(cleanupManagedRunChildProcess(reference)).resolves.toMatchObject({ status: 'verified' });
  await expect(cleanupManagedRunChildProcess(reference)).resolves.toMatchObject({ status: 'verified' });
  expect(processTree.killPid).toHaveBeenLastCalledWith(reference.pid, {
    expectedProcessStartIdentity: '111', expectedProcessTreeComplete: true,
    expectedProcessTreeIdentities: [{ pid: 91234, creationTime: '111' }, { pid: 91236, creationTime: '112' }],
  });
});

it('keeps exact local recovery available if persisting the Run reference fails', async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kodax-run-child-'));
  setAgentConfigHome(home);
  const child = Object.assign(new EventEmitter(), { pid: 91234, exitCode: null, signalCode: null }) as ChildProcess;
  let reference: ManagedRunChildProcessReference | undefined;
  expect(() => registerManagedChildProcess(child, { kind: 'bash', command: 'test', runtimeRunId: 'run-a' }, {
    manualUnregister: true, requireDurableRecord: true, onRegistered: (value) => {
      reference = value;
      throw new Error('Run persistence unavailable');
    },
  })).toThrow('Run persistence unavailable');
  if (!reference) throw new Error('Run child reference missing');
  processTree.killChild.mockResolvedValue({ status: 'terminated' });
  const result = await cleanupManagedRunChildProcess(reference);
  expect(result.status).toBe('verified');
  if (result.status === 'verified') result.release();
});

it.runIf(process.platform === 'win32')('keeps a known orphan in persisted Run evidence when a new snapshot loses its parent', async () => {
  const reference = await persistedRunChild();
  const file = path.join(home, 'runtime', 'processes', 'children', `${reference.pid}.${reference.registrationId}.json`);
  const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  const identities = [{ pid: 91234, creationTime: '111' }, { pid: 91236, creationTime: '112' }, { pid: 91237, creationTime: '113' }];
  await writeFile(file, JSON.stringify({ ...record, processTreeIdentities: identities }));
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  processTree.capture.mockReturnValue({ root: { pid: 91234, parentPid: 1, creationTime: '111' },
    descendants: [], uncertainDescendantPids: [], completeTree: true });
  processTree.killPid.mockResolvedValue({ status: 'unknown' });
  await expect(cleanupManagedRunChildProcess(reference)).resolves.toEqual({ status: 'unknown' });
  expect(processTree.killPid).toHaveBeenLastCalledWith(reference.pid, {
    expectedProcessStartIdentity: '111', expectedProcessTreeComplete: true, expectedProcessTreeIdentities: identities,
  });
  const persisted = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  expect(persisted.processTreeIdentities).toEqual(identities);
});
