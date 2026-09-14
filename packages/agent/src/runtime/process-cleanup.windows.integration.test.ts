import * as childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAgentConfigHome } from './agent-home.js';
import { cleanupManagedRunChildProcess, cleanupRegisteredManagedChildren } from './managed-child-processes.js';
import { killChildProcessTree, rememberChildProcessTree, waitForChildProcessExit } from './process-tree.js';

const mutableChildProcess = createRequire(import.meta.url)('node:child_process') as {
  spawnSync: typeof childProcess.spawnSync;
};

function expectMissingPid(pid: number): void {
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
}

describe.runIf(process.platform === 'win32')('Windows cleanup with real process queries', () => {
  let child: childProcess.ChildProcess | undefined;
  let home = '';

  afterEach(async () => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      expect(await waitForChildProcessExit(child, 5_000)).toBe(true);
    }
    child = undefined;
    setAgentConfigHome(undefined);
    if (home) {
      expect(path.dirname(home)).toBe(path.resolve(tmpdir()));
      await rm(home, { recursive: true, force: true });
      home = '';
    }
  });

  it('terminates a real child using one combined termination and verification query', async () => {
    child = childProcess.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore', windowsHide: true,
    });
    expect(rememberChildProcessTree(child)).toBeDefined();
    const queries = vi.spyOn(mutableChildProcess, 'spawnSync');
    syncBuiltinESMExports();

    await expect(killChildProcessTree(child)).resolves.toEqual({ status: 'terminated' });
    expect(await waitForChildProcessExit(child, 5_000)).toBe(true);
    expect(child.exitCode).toBe(1);
    // A busy OS may legitimately need another query. The deterministic tests
    // assert the two-query fast case; here the real combined operation must run.
    expect(queries.mock.calls.some(([, args]) => Array.isArray(args)
      && args.some((argument: unknown) => typeof argument === 'string'
        && argument.includes('::TerminateExact(') && argument.includes('::ReadRows()')))).toBe(true);
  });

  it('keeps 122 unresolved historical records without starting PowerShell on repeated exit sweeps', async () => {
    home = await mkdtemp(path.join(tmpdir(), 'kodax-exit-registry-'));
    setAgentConfigHome(home);
    const directory = path.join(home, 'runtime', 'processes', 'children');
    await mkdir(directory, { recursive: true });
    const ownerPid = 2_147_483_500;
    expectMissingPid(ownerPid);
    const originals = new Map<string, string>();
    for (let index = 0; index < 122; index += 1) {
      const pid = 2_147_483_000 + index;
      expectMissingPid(pid);
      const registrationId = randomUUID();
      const file = path.join(directory, `${pid}.${registrationId}.json`);
      const contents = JSON.stringify({
        version: 4, pid, ownerPid, registrationId, registeredAtMs: Date.now(),
        kind: 'bash', command: 'test', runtimeRunId: 'historical-run', runCleanupRequired: true,
        processStartIdentity: '1', ownerProcessStartIdentity: 'windows:1',
        processTreeComplete: false, processTreeIdentities: [{ pid, creationTime: '1' }],
      });
      originals.set(file, contents);
      await writeFile(file, contents);
    }
    const queries = vi.spyOn(mutableChildProcess, 'spawnSync');
    syncBuiltinESMExports();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(cleanupRegisteredManagedChildren({ includeCurrentOwner: true }))
        .resolves.toEqual({ killed: 0, pruned: 0, skipped: 122 });
      expect(queries).not.toHaveBeenCalled();
      expect(await readdir(directory)).toHaveLength(122);
      for (const [file, contents] of originals) {
        expect(await readFile(file, 'utf8')).toBe(contents);
      }
    }
  });

  it('still terminates a live retained descendant when its historical root is gone', async () => {
    home = await mkdtemp(path.join(tmpdir(), 'kodax-exit-descendant-'));
    setAgentConfigHome(home);
    child = childProcess.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore', windowsHide: true,
    });
    const identity = rememberChildProcessTree(child);
    expect(identity).toBeDefined();
    const pid = 2_147_483_000;
    const ownerPid = 2_147_483_500;
    expectMissingPid(pid);
    expectMissingPid(ownerPid);
    const reference = { pid, registrationId: randomUUID(), runtimeRunId: 'historical-run' };
    const directory = path.join(home, 'runtime', 'processes', 'children');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${pid}.${reference.registrationId}.json`);
    const contents = JSON.stringify({
      ...reference, version: 4, ownerPid, registeredAtMs: Date.now(), kind: 'bash', command: 'test',
      runCleanupRequired: true, processStartIdentity: '1', ownerProcessStartIdentity: 'windows:1',
      processTreeComplete: false, processTreeIdentities: [
        { pid, creationTime: '1' }, { pid: child.pid, creationTime: identity },
      ],
    });
    await writeFile(file, contents);

    await expect(cleanupManagedRunChildProcess(reference)).resolves.toEqual({ status: 'unknown' });
    expect(await waitForChildProcessExit(child, 5_000)).toBe(true);
    expect(child.exitCode).toBe(1);
    expect(await readFile(file, 'utf8')).toBe(contents);
  });
});
