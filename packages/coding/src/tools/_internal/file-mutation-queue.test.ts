/**
 * FEATURE_131 v0.7.36 Part A — file-mutation-queue contract tests.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  acquireKodaXFileLock,
  KodaXFileLockTimeoutError,
  readProcessStartIdentity,
  setAgentConfigHome,
} from '@kodax-ai/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _peekFileMutationQueueSizeForTests,
  _resetFileMutationQueueForTests,
  _resetFileSystemEffectLeasesForTests,
  acquireExclusiveFileSystemEffectLease,
  acquireFileSystemMutationLease,
  type FileSystemMutationLeaseRelease,
  FileSystemCleanupAdmissionTimeoutError,
  finishAndReleaseFileSystemEffectLease,
  normalizePathForKey,
  withHostFileSystemMutation,
  withHostFileSystemNamespaceMutation,
  withFileMutation,
  withExclusiveFileSystemCleanupLease,
} from './file-mutation-queue.js';

const processIdentityMock = vi.hoisted(() => ({
  unreadablePids: new Set<number>(),
}));
const coordinatorFailureMock = vi.hoisted(() => ({
  beforeEffectAcquire: undefined as (
    ((acquireTimeoutMs: number | undefined) => Promise<void>) | undefined
  ),
  beforeEffectAcquireAtCall: undefined as number | undefined,
  calls: 0,
  nonblockingTimeoutFailures: 0,
  remaining: 0,
  timeouts: [] as Array<number | undefined>,
}));
const managedCleanupMock = vi.hoisted(() => ({ failure: undefined as Error | undefined }));

vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return {
    ...actual,
    acquireKodaXFileLock: async (
      lockPath: string,
      acquireTimeoutMs?: number,
    ) => {
      if (
        lockPath.endsWith('model-filesystem-effects.lock')
      ) {
        coordinatorFailureMock.calls += 1;
        coordinatorFailureMock.timeouts.push(acquireTimeoutMs);
        if (
          coordinatorFailureMock.beforeEffectAcquire !== undefined
          && (
            coordinatorFailureMock.beforeEffectAcquireAtCall === undefined
            || coordinatorFailureMock.beforeEffectAcquireAtCall === coordinatorFailureMock.calls
          )
        ) {
          const beforeEffectAcquire = coordinatorFailureMock.beforeEffectAcquire;
          coordinatorFailureMock.beforeEffectAcquire = undefined;
          coordinatorFailureMock.beforeEffectAcquireAtCall = undefined;
          await beforeEffectAcquire(acquireTimeoutMs);
        }
        if (acquireTimeoutMs === 0 && coordinatorFailureMock.nonblockingTimeoutFailures > 0) {
          coordinatorFailureMock.nonblockingTimeoutFailures -= 1;
          throw new actual.KodaXFileLockTimeoutError(lockPath);
        }
        if (coordinatorFailureMock.remaining > 0) {
          coordinatorFailureMock.remaining -= 1;
          throw new Error('injected filesystem-effect coordinator failure');
        }
      }
      return actual.acquireKodaXFileLock(lockPath, acquireTimeoutMs);
    },
    cleanupRegisteredManagedChildren: async (
      ...args: Parameters<typeof actual.cleanupRegisteredManagedChildren>
    ) => {
      if (managedCleanupMock.failure !== undefined) throw managedCleanupMock.failure;
      return actual.cleanupRegisteredManagedChildren(...args);
    },
    readProcessStartIdentity: (pid: number) => (
      processIdentityMock.unreadablePids.has(pid)
        ? undefined
        : actual.readProcessStartIdentity(pid)
    ),
  };
});

let configHome: string;
const cleanupChildren: ChildProcess[] = [];

function effectRuntimeDirectory(): string {
  const workerScope = process.env.VITEST_WORKER_ID === undefined
    ? undefined
    : `${process.env.VITEST_WORKER_ID}-${process.pid}`.replace(/[^a-z0-9_-]/gi, '_');
  return path.join(
    process.platform === 'win32'
      ? path.join(
          path.resolve(process.env.PROGRAMDATA ?? 'C:\\ProgramData'),
          'KodaX',
          'sandbox-runtime',
        )
      : configHome,
    'runtime',
    ...(workerScope === undefined ? [] : [`test-filesystem-effects-${workerScope}`]),
  );
}

beforeEach(() => {
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-file-effects-'));
  setAgentConfigHome(configHome);
});

afterEach(async () => {
  for (const child of cleanupChildren.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  _resetFileMutationQueueForTests();
  await _resetFileSystemEffectLeasesForTests();
  processIdentityMock.unreadablePids.clear();
  managedCleanupMock.failure = undefined;
  coordinatorFailureMock.beforeEffectAcquire = undefined;
  coordinatorFailureMock.beforeEffectAcquireAtCall = undefined;
  coordinatorFailureMock.calls = 0;
  coordinatorFailureMock.nonblockingTimeoutFailures = 0;
  coordinatorFailureMock.remaining = 0;
  coordinatorFailureMock.timeouts.length = 0;
  delete process.env.KODAX_PATH_KEY_PLATFORM;
  setAgentConfigHome(undefined);
  fs.rmSync(configHome, { recursive: true, force: true });
});

describe('normalizePathForKey — POSIX mode', () => {
  beforeEach(() => {
    process.env.KODAX_PATH_KEY_PLATFORM = 'posix';
  });

  it('lowercases the drive letter on Windows-style paths but preserves component case', () => {
    expect(normalizePathForKey('C:\\Foo\\Bar')).toBe('c:/Foo/Bar');
    expect(normalizePathForKey('D:/x')).toBe('d:/x');
  });

  it('treats backslash and forward-slash variants as the same key', () => {
    expect(normalizePathForKey('C:\\Foo\\Bar')).toBe(normalizePathForKey('c:/Foo/Bar'));
  });

  it('collapses repeated separators', () => {
    expect(normalizePathForKey('/a//b///c')).toBe('/a/b/c');
  });

  it('preserves the leading // on UNC-style paths', () => {
    expect(normalizePathForKey('//server/share/file')).toBe('//server/share/file');
  });

  it('trims a trailing slash unless the path is the root', () => {
    expect(normalizePathForKey('/foo/')).toBe('/foo');
    expect(normalizePathForKey('/')).toBe('/');
  });

  it('returns an empty string for empty input', () => {
    expect(normalizePathForKey('')).toBe('');
  });

  it('preserves component case on POSIX (case-sensitive filesystem)', () => {
    expect(normalizePathForKey('/Foo/Bar')).toBe('/Foo/Bar');
  });
});

describe('normalizePathForKey — Windows mode', () => {
  beforeEach(() => {
    process.env.KODAX_PATH_KEY_PLATFORM = 'win32';
  });

  it('lowercases the entire path (case-insensitive filesystem)', () => {
    expect(normalizePathForKey('C:\\Foo\\Bar')).toBe('c:/foo/bar');
    expect(normalizePathForKey('c:/foo/Bar')).toBe('c:/foo/bar');
    expect(normalizePathForKey('C:/FOO/bar')).toBe('c:/foo/bar');
  });

  it('keeps backslash/forward-slash + case variants on the same queue key', () => {
    expect(normalizePathForKey('C:\\Foo\\Bar.txt')).toBe(normalizePathForKey('c:/foo/Bar.txt'));
  });
});

describe('withFileMutation — same path serialization', () => {
  it('runs same-path mutations in arrival order', async () => {
    const log: string[] = [];
    const slow = (label: string, ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          log.push(label);
          resolve();
        }, ms);
      });

    // First call is slower than the second; without the queue the
    // second would record before the first.
    const a = withFileMutation('/tmp/file.txt', () => slow('A', 30));
    const b = withFileMutation('/tmp/file.txt', () => slow('B', 5));
    await Promise.all([a, b]);
    expect(log).toEqual(['A', 'B']);
  });

  it('serializes calls with equivalent Windows path spellings (acceptance #9)', async () => {
    process.env.KODAX_PATH_KEY_PLATFORM = 'win32';
    const log: string[] = [];
    const slow = (label: string, ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          log.push(label);
          resolve();
        }, ms);
      });

    const a = withFileMutation('C:\\Foo\\Bar.txt', () => slow('A', 25));
    const b = withFileMutation('c:/foo/Bar.txt', () => slow('B', 5));
    await Promise.all([a, b]);
    expect(log).toEqual(['A', 'B']);
  });

  it('returns each caller their own result', async () => {
    const a = withFileMutation('/tmp/file.txt', async () => 'A');
    const b = withFileMutation('/tmp/file.txt', async () => 'B');
    const c = withFileMutation('/tmp/file.txt', async () => 'C');
    expect(await a).toBe('A');
    expect(await b).toBe('B');
    expect(await c).toBe('C');
  });

  it('queue continues after a previous mutation rejects', async () => {
    const result = withFileMutation('/tmp/file.txt', async () => {
      throw new Error('boom');
    });
    await expect(result).rejects.toThrow('boom');
    const next = await withFileMutation('/tmp/file.txt', async () => 'after');
    expect(next).toBe('after');
  });
});

describe('withFileMutation — different path concurrency', () => {
  it('runs different paths concurrently (wall-clock ≈ slowest, not the sum)', async () => {
    let active = 0;
    let maxActive = 0;
    let releaseMutations: (() => void) | undefined;
    const released = new Promise<void>((resolve) => { releaseMutations = resolve; });
    let allEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { allEntered = resolve; });
    const mutation = async (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 3) allEntered?.();
      await released;
      active -= 1;
    };
    const mutations = Promise.all([
      withFileMutation('/tmp/a.txt', mutation),
      withFileMutation('/tmp/b.txt', mutation),
      withFileMutation('/tmp/c.txt', mutation),
    ]);
    const concurrent = await Promise.race([
      entered.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    releaseMutations?.();
    await mutations;
    expect(concurrent).toBe(true);
    expect(maxActive).toBe(3);
  });
});

describe('cross-process filesystem effect lease', () => {
  it('keeps a host file mutation fenced from a long-lived shell effect', async () => {
    const releaseShell = await acquireFileSystemMutationLease();
    try {
      await expect(withFileMutation('/tmp/host.txt', async () => 'unsafe'))
        .rejects.toThrow('filesystem effect is already active');
    } finally {
      await releaseShell();
    }
  });

  it('removes a crashed process marker before admitting new work', async () => {
    const runtimeDirectory = effectRuntimeDirectory();
    await fs.promises.mkdir(runtimeDirectory, { recursive: true });
    await fs.promises.writeFile(
      path.join(runtimeDirectory, 'model-filesystem-effects.json'),
      JSON.stringify({
        direct: [{ pid: 2_147_483_647, token: 'crashed-direct' }],
        shells: [],
      }),
      'utf8',
    );

    await expect(withFileMutation('/tmp/recovered.txt', async () => 'recovered'))
      .resolves.toBe('recovered');
  });

  it('recovers a released direct owner even while its daemon process remains alive', async () => {
    const runtimeDirectory = effectRuntimeDirectory();
    const statePath = path.join(runtimeDirectory, 'model-filesystem-effects.json');
    const token = 'released-live-direct';
    await fs.promises.mkdir(runtimeDirectory, { recursive: true });
    await fs.promises.writeFile(
      statePath,
      JSON.stringify({
        direct: [{ pid: process.pid, token }],
        namespaces: [],
        shells: [],
      }),
      'utf8',
    );
    const encodedToken = Buffer.from(token, 'utf8').toString('base64url');
    await fs.promises.writeFile(`${statePath}.${encodedToken}.released`, `${token}\n`, 'utf8');

    const releaseShell = await acquireFileSystemMutationLease();
    await releaseShell();
  });

  it('removes its state through the coordinator when release-marker creation fails', async () => {
    const runtimeDirectory = effectRuntimeDirectory();
    const statePath = path.join(runtimeDirectory, 'model-filesystem-effects.json');
    const releaseEffect = await acquireFileSystemMutationLease();
    const state = JSON.parse(await fs.promises.readFile(statePath, 'utf8')) as {
      readonly shells: readonly { readonly token: string }[];
    };
    const token = state.shells[0]?.token;
    if (token === undefined) throw new Error('Expected the acquired shell lease token.');
    const encodedToken = Buffer.from(token, 'utf8').toString('base64url');
    const markerPath = `${statePath}.${encodedToken}.released`;
    await fs.promises.mkdir(markerPath);

    await expect(releaseEffect()).resolves.toBeUndefined();
    await expect(fs.promises.readFile(statePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.promises.rm(markerPath, { recursive: true, force: true });
  });

  it('recovers the incident shape of an orphan coordinator ticket plus released direct owner', async () => {
    const runtimeDirectory = effectRuntimeDirectory();
    const statePath = path.join(runtimeDirectory, 'model-filesystem-effects.json');
    const coordinatorPath = path.join(runtimeDirectory, 'model-filesystem-effects.lock');
    const queuePath = `${coordinatorPath}.queue`;
    const directToken = 'incident-released-direct';
    const ticketToken = '47474747-4747-4474-8474-474747474747';
    const ticketPath = path.join(
      queuePath,
      `ticket-0000000000000001-${ticketToken}.lock`,
    );
    await fs.promises.mkdir(queuePath, { recursive: true });
    await fs.promises.writeFile(
      statePath,
      JSON.stringify({
        direct: [{ pid: process.pid, token: directToken }],
        namespaces: [],
        shells: [],
      }),
      'utf8',
    );
    const encodedToken = Buffer.from(directToken, 'utf8').toString('base64url');
    await fs.promises.writeFile(
      `${statePath}.${encodedToken}.released`,
      `${directToken}\n`,
      'utf8',
    );
    await fs.promises.writeFile(ticketPath, `${process.pid} ${ticketToken}\n`, 'utf8');
    const old = new Date(Date.now() - 60_000);
    await fs.promises.utimes(ticketPath, old, old);

    const releaseShell = await acquireFileSystemMutationLease();
    await releaseShell();
  });

  it('recovers a pre-bind shell marker after managed cleanup proves no child remains', async () => {
    const runtimeDirectory = effectRuntimeDirectory();
    await fs.promises.mkdir(runtimeDirectory, { recursive: true });
    await fs.promises.writeFile(
      path.join(runtimeDirectory, 'model-filesystem-effects.json'),
      JSON.stringify({
        direct: [],
        shells: [{ pid: 2_147_483_647, token: 'crashed-unbound-shell' }],
      }),
      'utf8',
    );

    await expect(withFileMutation('/tmp/recovered-after-pre-bind-crash.txt', async () => 'safe'))
      .resolves.toBe('safe');
  });

  it('recovers an abandoned namespace marker after managed cleanup converges', async () => {
    const runtimeDirectory = effectRuntimeDirectory();
    await fs.promises.mkdir(runtimeDirectory, { recursive: true });
    await fs.promises.writeFile(
      path.join(runtimeDirectory, 'model-filesystem-effects.json'),
      JSON.stringify({
        direct: [],
        namespaces: [{ pid: 2_147_483_647, token: 'crashed-namespace' }],
        shells: [],
      }),
      'utf8',
    );

    const releaseShell = await acquireFileSystemMutationLease();
    await releaseShell();
  });

  it('keeps an abandoned external effect fenced when managed-child evidence is unreadable', async () => {
    const runtimeDirectory = effectRuntimeDirectory();
    const statePath = path.join(runtimeDirectory, 'model-filesystem-effects.json');
    await fs.promises.mkdir(runtimeDirectory, { recursive: true });
    await fs.promises.writeFile(statePath, JSON.stringify({
      direct: [],
      namespaces: [{ pid: 2_147_483_647, token: 'unreadable-managed-evidence' }],
      shells: [],
    }), 'utf8');
    managedCleanupMock.failure = new Error('Managed child registry is unreadable');

    await expect(acquireFileSystemMutationLease())
      .rejects.toThrow('Managed child registry is unreadable');
    const state = JSON.parse(await fs.promises.readFile(statePath, 'utf8')) as {
      readonly namespaces: readonly { readonly token: string }[];
    };
    expect(state.namespaces).toContainEqual({
      pid: 2_147_483_647,
      token: 'unreadable-managed-evidence',
    });
  });

  it('allows independent shell effects to overlap', async () => {
    const releaseFirst = await acquireFileSystemMutationLease();
    const releaseSecond = await acquireFileSystemMutationLease();
    await releaseSecond();
    await releaseFirst();
  });

  it('waits through a coordinator handoff longer than five seconds', async () => {
    const coordinatorPath = path.join(
      effectRuntimeDirectory(),
      'model-filesystem-effects.lock',
    );
    const releaseCoordinator = await acquireKodaXFileLock(coordinatorPath, 1_000);
    const releaseTimer = setTimeout(() => {
      void releaseCoordinator();
    }, 5_500);
    try {
      const releaseEffect = await acquireFileSystemMutationLease();
      await releaseEffect();
    } finally {
      clearTimeout(releaseTimer);
      await releaseCoordinator();
    }
  });

  it('lets sandbox ACL coordination overlap only with its exact policy', async () => {
    const releaseSamePolicy = await acquireFileSystemMutationLease('policy-a');
    const releaseCoordination = await acquireExclusiveFileSystemEffectLease('policy-a');
    await releaseCoordination();
    await releaseSamePolicy();
  });

  it('serializes slow ACL transitions for the same sandbox policy without falling back', async () => {
    const releaseFirst = await acquireExclusiveFileSystemEffectLease('policy-a');
    const second = acquireExclusiveFileSystemEffectLease('policy-a');
    const releaseTimer = setTimeout(() => {
      void releaseFirst();
    }, 1_600);
    try {
      const releaseSecond = await second;
      await releaseSecond();
    } finally {
      clearTimeout(releaseTimer);
      await releaseFirst();
    }
  });

  it('waits for sandbox ACL coordination before starting ordinary permission fallback', async () => {
    const releaseCoordination = await acquireExclusiveFileSystemEffectLease('policy-a');
    let fallbackSettled = false;
    const fallback = acquireFileSystemMutationLease().finally(() => {
      fallbackSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
    expect(fallbackSettled).toBe(false);
    await releaseCoordination();
    const releaseFallback = await fallback;
    await releaseFallback();
  });

  it('keeps cleanup queued past 30 seconds and blocks same-policy admission', async () => {
    let now = performance.now();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const activeShell = await acquireFileSystemMutationLease('policy-a');
    await activeShell.bindEffectProcess(process.pid, false);
    let cleanupSettled = false;
    const cleanupChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    cleanupChildren.push(cleanupChild);
    if (cleanupChild.pid === undefined) throw new Error('expected a cleanup child PID');
    const cleanupAction = vi.fn(async () => {
      const exited = once(cleanupChild, 'exit');
      cleanupChild.kill();
      await exited;
    });
    const cleanup = withExclusiveFileSystemCleanupLease('policy-a', {
      pid: cleanupChild.pid,
      windowsJobContained: false,
    }, cleanupAction);
    void cleanup.then(
      () => { cleanupSettled = true; },
      () => { cleanupSettled = true; },
    );

    const statePath = path.join(
      effectRuntimeDirectory(),
      'model-filesystem-effects.json',
    );
    const readCleanupMarker = (): {
      readonly cleanupTransition?: boolean;
      readonly sandboxPolicyKey?: string;
    } | undefined => {
      if (!fs.existsSync(statePath)) return undefined;
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
        readonly namespaces: readonly {
          readonly cleanupTransition?: boolean;
          readonly sandboxPolicyKey?: string;
        }[];
      };
      return state.namespaces.find((owner) => owner.cleanupTransition === true);
    };
    await expect.poll(readCleanupMarker).toBeDefined();
    const cleanupMarker = readCleanupMarker();
    expect(cleanupMarker).toBeDefined();
    expect(cleanupMarker).not.toHaveProperty('sandboxPolicyKey');

    now += 31_000;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(cleanupSettled).toBe(false);

    const samePolicyAdmission = acquireFileSystemMutationLease('policy-a');
    now += 31_000;
    await expect(samePolicyAdmission).rejects.toThrow(
      'filesystem effect is already active',
    );

    await activeShell.finishEffectProcess();
    await activeShell();
    await expect.poll(() => cleanupSettled).toBe(true);
    await cleanup;
    expect(cleanupAction).toHaveBeenCalledOnce();
    const releaseAdmission = await acquireFileSystemMutationLease('policy-a');
    await releaseAdmission();
  });

  it('does not release cleanup coordination when the cleanup proof rejects', async () => {
    const cleanup = withExclusiveFileSystemCleanupLease('policy-a', {
      pid: process.pid,
      windowsJobContained: false,
    }, async () => {
      throw new Error('cleanup process tree was not drained');
    });

    await expect(cleanup).rejects.toThrow('cleanup process tree was not drained');
    const statePath = path.join(effectRuntimeDirectory(), 'model-filesystem-effects.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      readonly namespaces: readonly {
        readonly cleanupTransition?: boolean;
        readonly effectPid?: number;
        readonly effectFinished?: boolean;
      }[];
    };
    expect(state.namespaces).toContainEqual(expect.objectContaining({
      cleanupTransition: true,
      effectPid: process.pid,
      effectFinished: false,
    }));
  });

  it('reports a cleanup wait deadline but keeps working until cleanup converges', async () => {
    let now = performance.now();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const activeShell = await acquireFileSystemMutationLease('policy-a');
    await activeShell.bindEffectProcess(process.pid, false);
    const cleanupChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    cleanupChildren.push(cleanupChild);
    if (cleanupChild.pid === undefined) throw new Error('expected a cleanup child PID');
    const cleanupAction = vi.fn(async () => {
      const exited = once(cleanupChild, 'exit');
      cleanupChild.kill();
      await exited;
    });
    const cleanup = withExclusiveFileSystemCleanupLease('policy-a', {
      pid: cleanupChild.pid,
      windowsJobContained: false,
    }, cleanupAction);
    const statePath = path.join(
      effectRuntimeDirectory(),
      'model-filesystem-effects.json',
    );
    const readCleanupMarker = (): unknown => {
      if (!fs.existsSync(statePath)) return undefined;
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
        readonly namespaces: readonly { readonly cleanupTransition?: boolean }[];
      };
      return state.namespaces.find((owner) => owner.cleanupTransition === true);
    };

    await expect.poll(readCleanupMarker).toBeDefined();
    coordinatorFailureMock.nonblockingTimeoutFailures = 1;
    now += 131_000;
    await expect(cleanup).rejects.toThrow(/cleanup.*drain.*deadline/i);
    await expect.poll(() => coordinatorFailureMock.timeouts.includes(0)).toBe(true);
    expect(readCleanupMarker()).toBeDefined();
    expect(cleanupAction).not.toHaveBeenCalled();
    await activeShell.finishEffectProcess();
    await activeShell();
    await expect.poll(() => cleanupAction.mock.calls.length).toBe(1);
    await expect.poll(readCleanupMarker).toBeUndefined();
    const releaseAdmission = await acquireFileSystemMutationLease('policy-a');
    await releaseAdmission();
  });

  it('keeps converging when coordinator contention crosses the cleanup deadline', async () => {
    let now = performance.now();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const activeShell = await acquireFileSystemMutationLease('policy-a');
    await activeShell.bindEffectProcess(process.pid, false);
    const cleanupAction = vi.fn(async () => undefined);
    coordinatorFailureMock.beforeEffectAcquireAtCall = coordinatorFailureMock.calls + 2;
    coordinatorFailureMock.beforeEffectAcquire = async () => {
      now += 131_000;
      throw new KodaXFileLockTimeoutError('injected-effect-coordinator.lock');
    };

    const cleanup = withExclusiveFileSystemCleanupLease('policy-a', {
      pid: process.pid,
      windowsJobContained: false,
    }, cleanupAction);

    await expect(cleanup).rejects.toBeInstanceOf(FileSystemCleanupAdmissionTimeoutError);
    await activeShell.finishEffectProcess();
    await activeShell();
    await expect.poll(() => cleanupAction.mock.calls.length).toBe(1);
  });

  it('reports the cleanup deadline when coordinator admission succeeds after it', async () => {
    let now = performance.now();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const cleanupAction = vi.fn(async () => undefined);
    const acquiredLeases: FileSystemMutationLeaseRelease[] = [];
    const releasedLeases: FileSystemMutationLeaseRelease[] = [];
    coordinatorFailureMock.beforeEffectAcquireAtCall = coordinatorFailureMock.calls + 2;
    coordinatorFailureMock.beforeEffectAcquire = async () => {
      now += 131_000;
    };

    const cleanup = withExclusiveFileSystemCleanupLease('policy-a', {
      pid: process.pid,
      windowsJobContained: false,
    }, cleanupAction, undefined, (lease) => {
      acquiredLeases.push(lease);
    }, (lease) => {
      releasedLeases.push(lease);
    });

    await expect(cleanup).rejects.toBeInstanceOf(FileSystemCleanupAdmissionTimeoutError);
    await expect.poll(() => cleanupAction.mock.calls.length).toBe(1);
    await expect.poll(() => releasedLeases.length).toBe(1);
    expect(releasedLeases).toEqual(acquiredLeases);
  });

  it('keeps converging when managed-effect reconciliation crosses the cleanup deadline', async () => {
    let now = performance.now();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const cleanupAction = vi.fn(async () => undefined);
    coordinatorFailureMock.beforeEffectAcquireAtCall = coordinatorFailureMock.calls + 1;
    coordinatorFailureMock.beforeEffectAcquire = async () => {
      now += 131_000;
      throw new KodaXFileLockTimeoutError('injected-effect-reconciliation.lock');
    };

    const cleanup = withExclusiveFileSystemCleanupLease('policy-a', {
      pid: process.pid,
      windowsJobContained: false,
    }, cleanupAction);

    await expect(cleanup).rejects.toBeInstanceOf(FileSystemCleanupAdmissionTimeoutError);
    await expect.poll(() => cleanupAction.mock.calls.length).toBe(1);
  });

  it('bounds the caller while managed-effect reconciliation remains pending', async () => {
    vi.useFakeTimers();
    let releaseReconciliation: (() => void) | undefined;
    let releaseCleanupAction: (() => void) | undefined;
    let reportCleanupActionStarted: (() => void) | undefined;
    const cleanupActionStarted = new Promise<void>((resolve) => {
      reportCleanupActionStarted = resolve;
    });
    const cleanupAction = vi.fn(async () => {
      reportCleanupActionStarted?.();
      await new Promise<void>((resolve) => { releaseCleanupAction = resolve; });
    });
    coordinatorFailureMock.beforeEffectAcquireAtCall = coordinatorFailureMock.calls + 1;
    coordinatorFailureMock.beforeEffectAcquire = async () => {
      await new Promise<void>((resolve) => { releaseReconciliation = resolve; });
    };
    const cleanup = withExclusiveFileSystemCleanupLease('policy-a', {
      pid: process.pid,
      windowsJobContained: false,
    }, cleanupAction);

    for (let attempt = 0; attempt < 10 && releaseReconciliation === undefined; attempt += 1) {
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(releaseReconciliation).toBeTypeOf('function');
    const callerTimedOut = expect(cleanup).rejects.toBeInstanceOf(
      FileSystemCleanupAdmissionTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(130_000);
    await callerTimedOut;

    vi.useRealTimers();
    releaseReconciliation?.();
    await cleanupActionStarted;
    expect(cleanupAction).toHaveBeenCalledOnce();
    releaseCleanupAction?.();
    const later = await acquireFileSystemMutationLease('policy-a');
    await later();
  });

  it('keeps a crashed cleanup owner fenced while its reset process is still alive', async () => {
    let now = performance.now();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const exitedOwner = spawnSync(process.execPath, ['-e', '']);
    if (exitedOwner.pid === undefined) throw new Error('expected an exited cleanup owner PID');
    const statePath = path.join(effectRuntimeDirectory(), 'model-filesystem-effects.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      direct: [],
      namespaces: [{
        cleanupTransition: true,
        effectPid: process.pid,
        effectProcessStartIdentity: readProcessStartIdentity(process.pid),
        pid: exitedOwner.pid,
        token: 'crashed-cleanup-owner',
        windowsJobContained: false,
      }],
      shells: [],
    }));
    const admission = acquireFileSystemMutationLease('policy-a');
    now += 31_000;

    try {
      await expect(admission).rejects.toThrow('filesystem effect is already active');
    } finally {
      fs.rmSync(statePath, { force: true });
    }
  });

  it.runIf(process.platform === 'win32')(
    'keeps a crashed Job-contained cleanup fenced when child identity is unreadable',
    async () => {
      let now = performance.now();
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const exitedOwner = spawnSync(process.execPath, ['-e', '']);
      if (exitedOwner.pid === undefined) throw new Error('expected an exited cleanup owner PID');
      const effectIdentity = readProcessStartIdentity(process.pid);
      const statePath = path.join(effectRuntimeDirectory(), 'model-filesystem-effects.json');
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({
        direct: [],
        namespaces: [{
          cleanupTransition: true,
          effectPid: process.pid,
          effectProcessStartIdentity: effectIdentity,
          pid: exitedOwner.pid,
          token: 'unreadable-cleanup-child',
          windowsJobContained: true,
        }],
        shells: [],
      }));
      processIdentityMock.unreadablePids.add(process.pid);

      const admission = acquireFileSystemMutationLease('policy-a');
      now += 31_000;
      await expect(admission).rejects.toThrow('filesystem effect is already active');
    },
  );

  it('keeps different sandbox policies out of the same ACL coordination window', async () => {
    const releaseOtherPolicy = await acquireFileSystemMutationLease('policy-b');
    const startedAt = Date.now();
    try {
      await expect(acquireExclusiveFileSystemEffectLease('policy-a'))
        .rejects.toThrow('different sandbox policy');
      expect(Date.now() - startedAt).toBeLessThan(250);
    } finally {
      await releaseOtherPolicy();
    }
  });

  it('requires and records a fresh completion proof after rebinding one lease', async () => {
    const releaseEffect = await acquireFileSystemMutationLease();
    await releaseEffect.bindEffectProcess(process.pid, false);
    await releaseEffect.finishEffectProcess();
    await releaseEffect.bindEffectProcess(process.pid, false);
    await releaseEffect.finishEffectProcess();

    await expect(releaseEffect()).resolves.toBeUndefined();
  });

  it('releases against the Agent Home captured when the lease was acquired', async () => {
    const releaseEffect = await acquireFileSystemMutationLease();
    setAgentConfigHome(path.join(configHome, 'next-agent-home'));

    await expect(releaseEffect()).resolves.toBeUndefined();
  });

  it('retries a transient release failure without another lifecycle event', async () => {
    const releaseEffect = await acquireFileSystemMutationLease();
    const coordinatorPath = path.join(
      effectRuntimeDirectory(),
      'model-filesystem-effects.lock',
    );
    const releaseCoordinator = await acquireKodaXFileLock(coordinatorPath, 1_000);
    const coordinatorReleased = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        releaseCoordinator().then(resolve, reject);
      }, 1_100);
    });
    await expect(releaseEffect()).resolves.toBeUndefined();
    await coordinatorReleased;
    const statePath = path.join(
      effectRuntimeDirectory(),
      'model-filesystem-effects.json',
    );
    expect(fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : undefined)
      .toBeUndefined();
    await expect(withFileMutation('/tmp/after-release-retry.txt', async () => 'recovered'))
      .resolves.toBe('recovered');
  });

  it.each([
    ['direct', () => withHostFileSystemMutation(async () => {
      coordinatorFailureMock.remaining = 3;
      throw new Error('direct operation failed');
    })],
    ['namespace', () => withHostFileSystemNamespaceMutation(async () => {
      coordinatorFailureMock.remaining = 3;
      throw new Error('namespace operation failed');
    })],
  ])('preserves the %s operation failure when lease release also fails', async (_mode, run) => {
    const failure = await run().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining('operation failed') }),
      expect.objectContaining({ message: 'injected filesystem-effect coordinator failure' }),
    ]);
  });

  it('releases after a deferred process finish eventually succeeds', async () => {
    const releaseEffect = await acquireExclusiveFileSystemEffectLease();
    await releaseEffect.bindEffectProcess(process.pid, false);
    coordinatorFailureMock.remaining = 6;

    await expect(finishAndReleaseFileSystemEffectLease(releaseEffect))
      .rejects.toThrow('Filesystem cleanup completion and lease release both failed.');
    await vi.waitFor(async () => {
      const later = await acquireFileSystemMutationLease();
      await later();
    }, { timeout: 5_000 });
  });

  it('stops deferred finish retries after an unbound lease is released', async () => {
    const releaseEffect = await acquireFileSystemMutationLease();
    // Other tests intentionally leave unref'd best-effort retries behind. Keep
    // the failure budget above any stray calls until this operation completes
    // its three synchronous attempts, then clear it before releasing the lease.
    coordinatorFailureMock.remaining = 1_000;

    await expect(releaseEffect.finishEffectProcess())
      .rejects.toThrow('injected filesystem-effect coordinator failure');
    coordinatorFailureMock.remaining = 0;
    await releaseEffect();
    const callsAfterRelease = coordinatorFailureMock.calls;
    await new Promise<void>((resolve) => setTimeout(resolve, 400));

    expect(coordinatorFailureMock.calls).toBe(callsAfterRelease);
  });

  it('uses nonblocking coordinator attempts for deferred finish retries', async () => {
    const releaseEffect = await acquireFileSystemMutationLease();
    coordinatorFailureMock.remaining = 1_000;

    await expect(releaseEffect.finishEffectProcess())
      .rejects.toThrow('injected filesystem-effect coordinator failure');
    coordinatorFailureMock.remaining = 0;
    await expect.poll(() => coordinatorFailureMock.timeouts.filter(
      (timeoutMs) => timeoutMs === 0,
    ).length).toBeGreaterThan(0);
    await releaseEffect();
  });
});

describe('withFileMutation — cleanup', () => {
  it('clears the queue entry after the chain settles (no leak)', async () => {
    for (let i = 0; i < 100; i++) {
      await withFileMutation(`/tmp/file-${i}.txt`, async () => i);
    }
    expect(_peekFileMutationQueueSizeForTests()).toBe(0);
  });

  it('clears the entry even when the mutation rejects', async () => {
    await withFileMutation('/tmp/file.txt', async () => {
      throw new Error('boom');
    }).catch(() => undefined);
    // Allow the microtask to run so the finally fires.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(_peekFileMutationQueueSizeForTests()).toBe(0);
  });
});

describe('withFileMutation — Agent Home execution boundary', () => {
  it('allows an approved sensitive-file mutation to reach the sink', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-mutation-sensitive-'));
    setAgentConfigHome(home);
    try {
      await expect(withFileMutation(path.join(home, 'config.json'), async () => 'written'))
        .resolves.toBe('written');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('hard-denies Runtime even after the guardrail stage', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-mutation-runtime-'));
    setAgentConfigHome(home);
    try {
      await expect(withFileMutation(path.join(home, 'runtime', 'state.json'), async () => 'written'))
        .rejects.toThrow('protected KodaX state');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('hard-denies the lexical Runtime entry when it is a symlink outside Agent Home', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-mutation-runtime-link-'));
    const home = path.join(root, 'home');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(home);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(home, 'runtime'), process.platform === 'win32' ? 'junction' : 'dir');
    setAgentConfigHome(home);
    try {
      await expect(withFileMutation(path.join(home, 'runtime', 'state.json'), async () => 'written'))
        .rejects.toThrow('protected KodaX state');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
