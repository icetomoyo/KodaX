import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  killChildProcessTree,
  killChildProcessTreeSync,
  killPidTree,
  captureWindowsProcessTree,
  readProcessStartIdentity,
  rememberChildProcessTree,
} from './process-tree.js';

const originalPlatform = process.platform;
const originalKill = process.kill;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
}

function setKill(mock: typeof process.kill): void {
  Object.defineProperty(process, 'kill', {
    configurable: true,
    value: mock,
  });
}

function exitedChild(pid: number): ChildProcess {
  return {
    pid,
    exitCode: 0,
    signalCode: null,
    kill: vi.fn(),
  } as unknown as ChildProcess;
}

function notFoundError(): NodeJS.ErrnoException {
  const error = new Error('not found') as NodeJS.ErrnoException;
  error.code = 'ESRCH';
  return error;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readSpawnedPid(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error('nested child pid was not reported')), 5_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const line = stdout.split(/\r?\n/, 1)[0];
      const pid = Number(line);
      if (!Number.isInteger(pid) || pid <= 0) return;
      clearTimeout(timer);
      resolve(pid);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`process ${pid} did not exit`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('process tree cleanup', () => {
  afterEach(() => {
    setPlatform(originalPlatform);
    setKill(originalKill);
    vi.restoreAllMocks();
  });

  it('still signals a POSIX process group when the parent child has already exited', async () => {
    const calls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
    const mockKill = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      calls.push({ pid, signal });
      if (signal === 0) {
        throw notFoundError();
      }
      return true;
    }) as typeof process.kill;
    setPlatform('linux');
    setKill(mockKill);

    const result = await killChildProcessTree(exitedChild(12345));

    expect(calls).toContainEqual({ pid: -12345, signal: 'SIGTERM' });
    expect(result.status).toBe('terminated');
  });

  it('sync cleanup also signals a POSIX process group after parent exit', () => {
    const calls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
    const mockKill = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      calls.push({ pid, signal });
      return true;
    }) as typeof process.kill;
    setPlatform('linux');
    setKill(mockKill);

    killChildProcessTreeSync(exitedChild(12345));

    expect(calls).toContainEqual({ pid: -12345, signal: 'SIGTERM' });
    expect(calls).toContainEqual({ pid: -12345, signal: 'SIGKILL' });
  });

  it('reads a stable start identity for the current process', () => {
    const first = readProcessStartIdentity(process.pid);
    const second = readProcessStartIdentity(process.pid);

    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it.runIf(originalPlatform === 'win32')('uses the same exact FILETIME identity as native tree capture', () => {
    const identity = readProcessStartIdentity(process.pid);
    expect(identity).toBeDefined();
    const capture = captureWindowsProcessTree(process.pid, identity!);
    expect(capture?.root.creationTime).toBe(identity);
  });

  it('does not send a destructive POSIX signal when exact identity is requested', async () => {
    const calls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
    const mockKill = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      calls.push({ pid, signal });
      return true;
    }) as typeof process.kill;
    setPlatform('linux');
    setKill(mockKill);

    await expect(killPidTree(12_345, {
      expectedProcessStartIdentity: 'linux:exact-owner',
      forceMs: 0,
    })).resolves.toEqual({ status: 'unknown' });
    expect(calls.some(({ signal }) => signal === 'SIGTERM' || signal === 'SIGKILL'))
      .toBe(false);
  });

  it.skipIf(process.platform === 'win32')('does not signal a reused POSIX pid', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    if (child.pid === undefined) throw new Error('test process pid missing');
    const identity = readProcessStartIdentity(child.pid);
    if (identity === undefined) throw new Error('test process identity missing');

    try {
      await expect(killPidTree(child.pid, {
        expectedProcessStartIdentity: `${identity}:reused`,
        forceMs: 0,
      })).resolves.toEqual({ status: 'unknown' });
      expect(isPidAlive(child.pid)).toBe(true);
    } finally {
      process.kill(-child.pid, 'SIGKILL');
      await waitForPidExit(child.pid, 2_000).catch(() => undefined);
    }
  });

  it.skipIf(process.platform === 'win32')('fails closed for a matching POSIX identity', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    if (child.pid === undefined) throw new Error('test process pid missing');
    const identity = readProcessStartIdentity(child.pid);
    if (identity === undefined) throw new Error('test process identity missing');

    try {
      await expect(killPidTree(child.pid, {
        expectedProcessStartIdentity: identity,
        forceMs: 0,
      })).resolves.toEqual({ status: 'unknown' });
      expect(isPidAlive(child.pid)).toBe(true);
    } finally {
      await killPidTree(child.pid, { forceMs: 100 });
      await waitForPidExit(child.pid, 2_000).catch(() => undefined);
    }
  });

  it('reports unknown when a POSIX tree is still observable after force termination', async () => {
    const mockKill = vi.fn(() => true) as typeof process.kill;
    setPlatform('linux');
    setKill(mockKill);

    await expect(killPidTree(12345, { forceMs: 0 })).resolves.toEqual({
      status: 'unknown',
    });
  });

  it.skipIf(process.platform !== 'win32')('kills a snapshotted Windows tree through exact process handles', async () => {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'kodax-process-tree-'));
    const stopFile = path.join(fixtureDir, 'stop');
    const nestedScript = [
      'const {existsSync}=require("node:fs");',
      `const stopFile=${JSON.stringify(stopFile)};`,
      'setInterval(()=>{if(existsSync(stopFile))process.exit(0)},25);',
      'setTimeout(()=>process.exit(0),30000)',
    ].join('');
    const root = spawn(process.execPath, [
      '-e',
      `const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e",${JSON.stringify(nestedScript)}],{stdio:"ignore",windowsHide:true}); process.stdout.write(String(child.pid)+"\\n"); setInterval(()=>{},1000);`,
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const nestedPid = await readSpawnedPid(root);
    expect(rememberChildProcessTree(root)).toBeDefined();

    try {
      await expect(
        killChildProcessTree(root),
      ).resolves.toEqual({ status: 'terminated' });
      await waitForPidExit(nestedPid, 10_000);
    } finally {
      await writeFile(stopFile, 'stop');
      if (root.exitCode === null && root.signalCode === null) root.kill('SIGKILL');
      await waitForPidExit(nestedPid, 2_000).catch(() => undefined);
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }, 20_000);

  it.skipIf(process.platform !== 'win32')('kills retained exact descendants without touching a reused root pid', async () => {
    const reusedRoot = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const retainedDescendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (reusedRoot.pid === undefined || retainedDescendant.pid === undefined) {
      throw new Error('test process pid missing');
    }
    const currentRootIdentity = rememberChildProcessTree(reusedRoot);
    const descendantIdentity = rememberChildProcessTree(retainedDescendant);
    if (currentRootIdentity === undefined || descendantIdentity === undefined) {
      throw new Error('Windows process identity missing');
    }
    const oldRootIdentity = (BigInt(currentRootIdentity) - 1n).toString();

    try {
      await expect(killPidTree(reusedRoot.pid, {
        expectedProcessStartIdentity: oldRootIdentity,
        expectedProcessTreeIdentities: [
          { pid: reusedRoot.pid, creationTime: oldRootIdentity },
          { pid: retainedDescendant.pid, creationTime: descendantIdentity },
        ],
        expectedProcessTreeComplete: true,
      })).resolves.toEqual({ status: 'terminated' });
      expect(isPidAlive(reusedRoot.pid)).toBe(true);
      await waitForPidExit(retainedDescendant.pid, 10_000);
    } finally {
      if (reusedRoot.exitCode === null && reusedRoot.signalCode === null) {
        reusedRoot.kill('SIGKILL');
      }
      if (
        retainedDescendant.exitCode === null
        && retainedDescendant.signalCode === null
      ) retainedDescendant.kill('SIGKILL');
    }
  }, 20_000);
});
