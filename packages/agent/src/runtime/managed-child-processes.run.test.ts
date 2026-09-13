import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { cleanupManagedRunChildProcess, registerManagedChildProcess,
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
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
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
