import fsDefault, * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  claimRuntimeDaemonOwnership,
  classifyRuntimeDaemonHealth,
  clearRuntimeDaemonShutdownOutcome,
  createRuntimeDaemonToken,
  enableRuntimeDaemonOwner,
  normalizeRuntimeDaemonProfile,
  readRuntimeDaemonShutdownOutcome,
  readRuntimeOwnerPolicy,
  readRuntimeDaemonLockOwner,
  readRuntimeDaemonState,
  readRuntimeDaemonToken,
  releaseRuntimeDaemonLock,
  releaseRuntimeDaemonOwnership,
  removeRuntimeDaemonOwnershipIfUnchanged,
  resolveRuntimeDaemonEndpointScope,
  resolveRuntimeDaemonPaths,
  resolveRuntimeDaemonPathsFromConfigHome,
  tryAcquireRuntimeDaemonLock,
  updateRuntimeOwnerPolicy,
  writeRuntimeDaemonShutdownOutcome,
  writeRuntimeDaemonState,
  writeRuntimeDaemonToken,
  type RuntimeDaemonState,
} from './state.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-state-'));
  tempRoots.push(dir);
  return dir;
}

function countFsyncCalls(operation: () => void): number {
  const original = fsDefault.fsyncSync;
  let calls = 0;
  fsDefault.fsyncSync = (fd) => {
    calls += 1;
    original(fd);
  };
  syncBuiltinESMExports();
  try {
    operation();
    return calls;
  } finally {
    fsDefault.fsyncSync = original;
    syncBuiltinESMExports();
  }
}

function state(overrides: Partial<RuntimeDaemonState> = {}): RuntimeDaemonState {
  return {
    runtimeId: 'runtime-1',
    profile: 'default',
    pid: 1234,
    startedAt: '2026-07-09T00:00:00.000Z',
    endpoint: 'pipe://kodax-runtime-default',
    version: '0.7.66',
    status: 'ready',
    ...overrides,
  };
}

describe('runtime daemon state paths', () => {
  it('resolves profile-scoped daemon files under the KodaX runtime directory', () => {
    const paths = resolveRuntimeDaemonPaths('C:/Users/test', 'space');

    expect(paths.profile).toBe('space');
    expect(paths.configHome).toBe(path.resolve('C:/Users/test', '.kodax'));
    expect(paths.stateFile.replaceAll('\\', '/')).toContain('/.kodax/runtime/daemon/space/daemon.json');
    expect(paths.lockFile.endsWith('daemon.lock')).toBe(true);
    expect(paths.tokenFile.endsWith('daemon.token')).toBe(true);
    expect(paths.ownerPolicyLockFile.endsWith('owner-policy.lock')).toBe(true);
  });

  it('resolves daemon files from an explicit config home without basename inference', () => {
    const configHome = path.join(tempHome(), 'custom-config-home');
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, 'space');

    expect(paths.configHome).toBe(path.resolve(configHome));
    expect(paths.rootDir).toBe(path.join(path.resolve(configHome), 'runtime', 'daemon', 'space'));
    expect(paths.stateFile).toBe(path.join(paths.rootDir, 'daemon.json'));
  });

  it('round-trips and clears a runtime-bound daemon shutdown outcome', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'space');
    const outcome = {
      version: 1 as const,
      runtimeId: 'runtime-shutdown',
      pid: 4321,
      status: 'succeeded' as const,
      completedAt: '2026-08-03T00:00:00.000Z',
    };

    writeRuntimeDaemonShutdownOutcome(paths, outcome);

    expect(readRuntimeDaemonShutdownOutcome(paths, outcome)).toEqual(outcome);
    expect(readRuntimeDaemonShutdownOutcome(paths, outcome)).toEqual(outcome);
    clearRuntimeDaemonShutdownOutcome(paths, outcome);
    expect(readRuntimeDaemonShutdownOutcome(paths, outcome)).toBeUndefined();
  });

  it('keeps shutdown outcomes isolated across consecutive daemon owners', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'space');
    const first = {
      version: 1 as const,
      runtimeId: 'runtime-first',
      pid: 4321,
      status: 'succeeded' as const,
      completedAt: '2026-08-03T00:00:00.000Z',
    };
    const second = {
      ...first,
      runtimeId: 'runtime-second',
      pid: 5432,
    };

    writeRuntimeDaemonShutdownOutcome(paths, first);
    writeRuntimeDaemonShutdownOutcome(paths, second);
    clearRuntimeDaemonShutdownOutcome(paths, second);

    expect(readRuntimeDaemonShutdownOutcome(paths, first)).toEqual(first);
    expect(readRuntimeDaemonShutdownOutcome(paths, second)).toBeUndefined();
  });

  it('retains a bounded multi-reader window of shutdown outcomes', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'space');
    for (let index = 0; index < 40; index += 1) {
      writeRuntimeDaemonShutdownOutcome(paths, {
        version: 1,
        runtimeId: `runtime-${String(index).padStart(2, '0')}`,
        pid: 4_000 + index,
        status: 'succeeded',
        completedAt: new Date(Date.UTC(2026, 7, 3, 0, 0, index)).toISOString(),
      });
    }

    const outcomes = fs.readdirSync(paths.rootDir).filter(
      (name) => name.startsWith('shutdown-outcome.'),
    );
    expect(outcomes).toHaveLength(32);
    expect(readRuntimeDaemonShutdownOutcome(paths, {
      runtimeId: 'runtime-39',
      pid: 4_039,
    })).toMatchObject({ status: 'succeeded' });
  });

  it('preserves the legacy endpoint scope for canonical config and isolates arbitrary config homes', () => {
    const homeDir = tempHome();

    expect(resolveRuntimeDaemonEndpointScope(homeDir, path.join(homeDir, '.kodax')))
      .toBe(path.resolve(homeDir));
    expect(resolveRuntimeDaemonEndpointScope(homeDir, path.join(homeDir, 'custom-config-home')))
      .toBe(path.resolve(homeDir, 'custom-config-home'));
  });

  it('rejects path-like profile names', () => {
    expect(() => normalizeRuntimeDaemonProfile('../escape')).toThrow(/Invalid runtime daemon profile/);
    expect(() => normalizeRuntimeDaemonProfile('..')).toThrow(/Invalid runtime daemon profile/);
    expect(() => normalizeRuntimeDaemonProfile('.')).toThrow(/Invalid runtime daemon profile/);
    expect(() => normalizeRuntimeDaemonProfile('space profile')).toThrow(/Invalid runtime daemon profile/);
  });

  it('round-trips daemon state with validation', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const expected = state();

    writeRuntimeDaemonState(paths, expected);

    expect(readRuntimeDaemonState(paths)).toEqual(expected);
  });

  it('atomically replaces daemon state without leaving staging files', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    writeRuntimeDaemonState(paths, state());

    const stopping = state({ status: 'stopping' });
    writeRuntimeDaemonState(paths, stopping);

    expect(readRuntimeDaemonState(paths)).toEqual(stopping);
    expect(fs.readdirSync(paths.rootDir)).toContain('daemon.json');
    expect(fs.readdirSync(paths.rootDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('fsyncs a user-only staging file before publishing daemon state', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');

    const fsyncCalls = countFsyncCalls(() => writeRuntimeDaemonState(paths, state()));

    expect(fsyncCalls).toBe(1);
    if (process.platform !== 'win32') {
      expect(fs.statSync(paths.stateFile).mode & 0o777).toBe(0o600);
    }
  });

  it('treats malformed daemon state as missing instead of throwing', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    fs.mkdirSync(paths.rootDir, { recursive: true });
    fs.writeFileSync(paths.stateFile, '{not-json', 'utf8');

    expect(readRuntimeDaemonState(paths)).toBeUndefined();
  });

  it('stores a profile-scoped local daemon token with user-only permissions where supported', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const token = createRuntimeDaemonToken();

    writeRuntimeDaemonToken(paths, token);

    expect(token).toMatch(/^dt_[a-f0-9]+$/);
    expect(readRuntimeDaemonToken(paths)).toBe(token);
    if (process.platform !== 'win32') {
      expect(fs.statSync(paths.tokenFile).mode & 0o777).toBe(0o600);
    }
  });

  it('treats a daemon token removed during a concurrent lifecycle transition as missing', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    writeRuntimeDaemonToken(paths, 'token-to-remove-concurrently');
    const original = fsDefault.readFileSync;
    fsDefault.readFileSync = (() => {
      const error = new Error('token removed') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }) as typeof fsDefault.readFileSync;
    syncBuiltinESMExports();
    try {
      expect(readRuntimeDaemonToken(paths)).toBeUndefined();
    } finally {
      fsDefault.readFileSync = original;
      syncBuiltinESMExports();
    }
  });
});

describe('runtime daemon lock ownership', () => {
  it('round-trips the exact Windows supervisor generation and accepts legacy owners', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const exactOwner = {
      runtimeId: 'runtime-contained',
      pid: 111,
      createdAt: '2026-07-14T00:00:00.000Z',
      kind: 'daemon' as const,
      processContainment: 'windows-job' as const,
      supervisorPid: 222,
      supervisorProcessStartIdentity: 'windows:134158464000000000',
    };
    const exactLock = tryAcquireRuntimeDaemonLock(paths, exactOwner);

    expect(exactLock).toBeDefined();
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toEqual(exactOwner);
    expect(exactLock ? releaseRuntimeDaemonLock(exactLock) : false).toBe(true);

    const legacyOwner = {
      runtimeId: 'runtime-contained-legacy',
      pid: 333,
      createdAt: '2026-07-14T00:00:01.000Z',
      kind: 'daemon' as const,
      processContainment: 'windows-job' as const,
      supervisorPid: 444,
    };
    const legacyLock = tryAcquireRuntimeDaemonLock(paths, legacyOwner);

    expect(legacyLock).toBeDefined();
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toEqual(legacyOwner);
    expect(legacyLock ? releaseRuntimeDaemonLock(legacyLock) : false).toBe(true);
  });

  it('fsyncs a user-only owner lock before returning ownership', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    let lock: ReturnType<typeof tryAcquireRuntimeDaemonLock> = undefined;
    const fsyncCalls = countFsyncCalls(() => {
      lock = tryAcquireRuntimeDaemonLock(paths, {
        runtimeId: 'runtime-durable',
        pid: 111,
        createdAt: '2026-07-14T00:00:00.000Z',
      });
    });

    expect(lock).toBeDefined();
    expect(fsyncCalls).toBe(1);
    if (process.platform !== 'win32') {
      expect(fs.statSync(paths.lockFile).mode & 0o777).toBe(0o600);
    }
  });

  it('allows exactly one atomic lock owner', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const first = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: 'runtime-1',
      pid: 111,
      createdAt: '2026-07-09T00:00:00.000Z',
    });
    const second = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: 'runtime-2',
      pid: 222,
      createdAt: '2026-07-09T00:00:01.000Z',
    });

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(first ? releaseRuntimeDaemonLock(first) : false).toBe(true);
  });

  it('does not release a lock owned by another runtime', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const owner = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: 'runtime-1',
      pid: 111,
      createdAt: '2026-07-09T00:00:00.000Z',
    });

    expect(owner).toBeDefined();
    expect(releaseRuntimeDaemonLock({
      file: paths.lockFile,
      owner: {
        runtimeId: 'runtime-2',
        pid: 222,
        createdAt: '2026-07-09T00:00:01.000Z',
      },
    })).toBe(false);
    expect(fs.existsSync(paths.lockFile)).toBe(true);
    expect(owner ? releaseRuntimeDaemonLock(owner) : false).toBe(true);
  });

  it('does not release an owner lock during an owner-policy transaction', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: 'runtime-1',
      pid: 111,
      createdAt: '2026-07-09T00:00:00.000Z',
    });
    expect(lock).toBeDefined();
    fs.writeFileSync(paths.ownerPolicyLockFile, JSON.stringify({
      runtimeId: 'owner-transition-live',
      pid: process.pid,
      createdAt: '2026-07-09T00:00:01.000Z',
      nonce: 'live',
    }), 'utf8');

    expect(lock ? releaseRuntimeDaemonLock(lock) : false).toBe(false);
    expect(fs.existsSync(paths.lockFile)).toBe(true);
  });

  it('removes daemon state and token before atomically releasing ownership', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const daemonState = state();
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: daemonState.runtimeId,
      pid: daemonState.pid,
      createdAt: daemonState.startedAt,
    });
    expect(lock).toBeDefined();
    writeRuntimeDaemonState(paths, daemonState);
    writeRuntimeDaemonToken(paths, 'token-to-remove');

    expect(lock ? releaseRuntimeDaemonOwnership(paths, lock) : false).toBe(true);
    expect(readRuntimeDaemonState(paths)).toBeUndefined();
    expect(readRuntimeDaemonToken(paths)).toBeUndefined();
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
  });

  it('treats malformed lock ownership as unreadable instead of throwing', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    fs.mkdirSync(paths.rootDir, { recursive: true });
    fs.writeFileSync(paths.lockFile, '{not-json', 'utf8');

    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
  });
});

describe('runtime Coder owner policy', () => {
  it('uses revision CAS and leaves no transition lock after a successful update', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');

    const updated = updateRuntimeOwnerPolicy(paths, 'inline', 0);

    expect(updated).toMatchObject({ mode: 'inline', revision: 1 });
    expect(readRuntimeOwnerPolicy(paths)).toEqual(updated);
    expect(fs.existsSync(paths.ownerPolicyLockFile)).toBe(false);
    expect(() => updateRuntimeOwnerPolicy(paths, 'daemon', 0)).toThrow(/conflict/i);
  });

  it('fails closed while another process-shaped policy transaction owns the lock', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    fs.mkdirSync(paths.rootDir, { recursive: true });
    fs.writeFileSync(paths.ownerPolicyLockFile, JSON.stringify({ pid: 1234, nonce: 'other' }), 'utf8');

    expect(() => updateRuntimeOwnerPolicy(paths, 'inline', 0)).toThrow(/already in progress/i);
    expect(readRuntimeOwnerPolicy(paths)).toMatchObject({ mode: 'daemon', revision: 0 });
    expect(fs.readFileSync(paths.ownerPolicyLockFile, 'utf8')).toContain('other');
  });

  it('recovers a verified abandoned owner transition without touching live processes', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    fs.mkdirSync(paths.rootDir, { recursive: true });
    fs.writeFileSync(paths.ownerPolicyLockFile, JSON.stringify({
      runtimeId: 'owner-transition-stale',
      pid: 999_999_999,
      createdAt: '2026-07-09T00:00:00.000Z',
      nonce: 'stale-transition',
    }), 'utf8');

    expect(updateRuntimeOwnerPolicy(paths, 'inline', 0)).toMatchObject({
      mode: 'inline',
      revision: 1,
    });
  });

  it('does not change owner policy while a Runtime owner holds the profile', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    expect(tryAcquireRuntimeDaemonLock(paths, owner('runtime-active'))).toBeDefined();

    expect(() => updateRuntimeOwnerPolicy(paths, 'inline', 0)).toThrow(/owner lock exists/i);
    expect(readRuntimeOwnerPolicy(paths)).toMatchObject({ mode: 'daemon', revision: 0 });
  });

  it('re-enables daemon ownership after a stopped daemon releases its lock', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: 'runtime-rollback',
      pid: process.pid,
      createdAt: '2026-07-15T00:00:00.000Z',
      kind: 'daemon',
    });
    expect(lock).toBeDefined();
    if (!lock) throw new Error('Expected daemon owner lock.');

    // FEATURE_298 T25 — rollbackToInline is retired; a stopped daemon keeps
    // its sticky daemon policy and the next owner resumes at the next
    // revision without guessing.
    expect(readRuntimeOwnerPolicy(paths)).toMatchObject({ mode: 'daemon', revision: 0 });
    expect(releaseRuntimeDaemonLock(lock)).toBe(true);

    const daemon = enableRuntimeDaemonOwner(paths);
    expect(daemon).toMatchObject({ mode: 'daemon', revision: 0 });
    expect(enableRuntimeDaemonOwner(paths)).toEqual(daemon);
  });

  it('atomically reclaims a dead inline owner while enabling daemon ownership', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    expect(updateRuntimeOwnerPolicy(paths, 'inline', 0)).toMatchObject({
      mode: 'inline',
      revision: 1,
    });
    expect(tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: 'inline-abandoned',
      pid: 999_999_999,
      createdAt: '2026-08-11T00:00:00.000Z',
      kind: 'inline',
    })).toBeDefined();

    expect(enableRuntimeDaemonOwner(paths)).toMatchObject({
      mode: 'daemon',
      revision: 2,
    });
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
  });

  it('keeps a live inline owner and its policy fail-closed', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    updateRuntimeOwnerPolicy(paths, 'inline', 0);
    expect(tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: 'inline-live',
      pid: process.pid,
      createdAt: '2026-08-11T00:00:00.000Z',
      kind: 'inline',
    })).toBeDefined();

    expect(() => enableRuntimeDaemonOwner(paths)).toThrow(/inline owner.*active/i);
    expect(readRuntimeOwnerPolicy(paths)).toMatchObject({ mode: 'inline', revision: 1 });
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({
      runtimeId: 'inline-live',
    });
  });

  it('keeps an inline owner fail-closed when process liveness is unverifiable', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const ownerPid = 999_999_998;
    updateRuntimeOwnerPolicy(paths, 'inline', 0);
    expect(tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: 'inline-unverifiable',
      pid: ownerPid,
      createdAt: '2026-08-11T00:00:00.000Z',
      kind: 'inline',
    })).toBeDefined();
    const originalKill = process.kill;
    process.kill = ((pid, signal) => {
      if (pid === ownerPid) {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }
      return originalKill(pid, signal);
    }) as typeof process.kill;

    try {
      expect(() => enableRuntimeDaemonOwner(paths)).toThrow(/liveness could not be verified/i);
      expect(readRuntimeOwnerPolicy(paths)).toMatchObject({ mode: 'inline', revision: 1 });
      expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({
        runtimeId: 'inline-unverifiable',
      });
    } finally {
      process.kill = originalKill;
    }
  });

  it('reclaims an inline lock after PID reuse is proved by process identity', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    updateRuntimeOwnerPolicy(paths, 'inline', 0);
    const reusedPidOwner = {
      runtimeId: 'inline-reused-pid',
      pid: process.pid,
      createdAt: '2026-08-11T00:00:00.000Z',
      kind: 'inline' as const,
      processStartIdentity: 'not-the-current-process',
    };
    expect(tryAcquireRuntimeDaemonLock(paths, reusedPidOwner)).toBeDefined();

    expect(enableRuntimeDaemonOwner(paths)).toMatchObject({ mode: 'daemon', revision: 2 });
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
  });

  it('never reclaims a daemon-kind lock while enabling daemon ownership', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    updateRuntimeOwnerPolicy(paths, 'inline', 0);
    expect(tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: 'daemon-abandoned',
      pid: 999_999_999,
      createdAt: '2026-08-11T00:00:00.000Z',
      kind: 'daemon',
    })).toBeDefined();

    expect(() => enableRuntimeDaemonOwner(paths)).toThrow(/daemon owner lock exists/i);
    expect(readRuntimeOwnerPolicy(paths)).toMatchObject({ mode: 'inline', revision: 1 });
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({
      runtimeId: 'daemon-abandoned',
    });
  });

  it('never guesses that a dead legacy-kind owner is an inline owner', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    updateRuntimeOwnerPolicy(paths, 'inline', 0);
    expect(tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: 'legacy-abandoned',
      pid: 999_999_999,
      createdAt: '2026-08-11T00:00:00.000Z',
    })).toBeDefined();

    expect(() => enableRuntimeDaemonOwner(paths)).toThrow(/legacy owner lock exists/i);
    expect(readRuntimeOwnerPolicy(paths)).toMatchObject({ mode: 'inline', revision: 1 });
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({
      runtimeId: 'legacy-abandoned',
    });
  });

  it('never reclaims a malformed owner lock while enabling daemon ownership', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    updateRuntimeOwnerPolicy(paths, 'inline', 0);
    fs.writeFileSync(paths.lockFile, JSON.stringify({
      runtimeId: 'inline-invalid',
      pid: -1,
      createdAt: '2026-08-11T00:00:00.000Z',
      kind: 'inline',
    }), 'utf8');

    expect(() => enableRuntimeDaemonOwner(paths)).toThrow(/owner lock is unreadable/i);
    expect(fs.existsSync(paths.lockFile)).toBe(true);
    expect(readRuntimeOwnerPolicy(paths)).toMatchObject({ mode: 'inline', revision: 1 });
  });
});

describe('runtime daemon health classification', () => {
  it('classifies the documented healthy, stale, unhealthy, and mismatch cases', () => {
    const current = state();

    expect(classifyRuntimeDaemonHealth({
      state: current,
      pidAlive: true,
      endpointReachable: true,
      identityMatches: true,
    })).toBe('healthy');
    expect(classifyRuntimeDaemonHealth({
      state: current,
      pidAlive: false,
      endpointReachable: false,
      identityMatches: false,
    })).toBe('stale');
    expect(classifyRuntimeDaemonHealth({
      state: current,
      pidAlive: true,
      endpointReachable: false,
      identityMatches: false,
    })).toBe('unhealthy');
    expect(classifyRuntimeDaemonHealth({
      state: current,
      pidAlive: true,
      endpointReachable: true,
      identityMatches: false,
    })).toBe('mismatch');
  });
});

describe('runtime daemon ownership claims', () => {
  it('attaches to a healthy daemon instead of taking the lock', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const current = state();
    expect(tryAcquireRuntimeDaemonLock(paths, owner(current.runtimeId, current.pid))).toBeDefined();

    const decision = claimRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      state: current,
      pidAlive: true,
      endpointReachable: true,
      identityMatches: true,
    });

    expect(decision).toMatchObject({ kind: 'attach', state: current });
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({
      runtimeId: current.runtimeId,
    });
  });

  it('refuses to attach when a healthy endpoint has no matching owner fence', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const current = state();

    const decision = claimRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      state: current,
      pidAlive: true,
      endpointReachable: true,
      identityMatches: true,
    });

    expect(decision).toMatchObject({ kind: 'unhealthy', health: 'mismatch' });
  });

  it('claims an atomic lock when no daemon exists and makes a racing claimant wait', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');

    const first = claimRuntimeDaemonOwnership(paths, owner('runtime-1'), {
      pidAlive: false,
      endpointReachable: false,
      identityMatches: false,
    });
    const second = claimRuntimeDaemonOwnership(paths, owner('runtime-2'), {
      pidAlive: false,
      endpointReachable: false,
      identityMatches: false,
    });

    expect(first.kind).toBe('claim');
    expect(second).toMatchObject({
      kind: 'wait',
      lockOwner: { runtimeId: 'runtime-1' },
    });
  });

  it('claims a missing profile when an old lock owner is no longer alive', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const staleLock = tryAcquireRuntimeDaemonLock(paths, owner('runtime-stale', 999));
    expect(staleLock).toBeDefined();

    const decision = claimRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      pidAlive: false,
      endpointReachable: false,
      identityMatches: false,
      lockOwnerPidAlive: false,
    });

    expect(decision.kind).toBe('claim');
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({ runtimeId: 'runtime-next' });
  });

  it('does not delete malformed missing-state locks on the normal claim path', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    fs.mkdirSync(paths.rootDir, { recursive: true });
    fs.writeFileSync(paths.lockFile, '{not-json', 'utf8');

    const decision = claimRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      pidAlive: false,
      endpointReachable: false,
      identityMatches: false,
    });

    expect(decision.kind).toBe('unhealthy');
    expect(fs.readFileSync(paths.lockFile, 'utf8')).toBe('{not-json');
  });

  it('cleans verified stale ownership before claiming the profile', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const stale = state({ runtimeId: 'runtime-stale', pid: 999 });
    writeRuntimeDaemonState(paths, stale);
    const staleLock = tryAcquireRuntimeDaemonLock(paths, owner('runtime-stale', 999));
    expect(staleLock).toBeDefined();

    const decision = claimRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      state: stale,
      pidAlive: false,
      endpointReachable: false,
      identityMatches: false,
    });

    expect(decision.kind).toBe('claim');
    expect(readRuntimeDaemonState(paths)).toBeUndefined();
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({ runtimeId: 'runtime-next' });
  });

  it('never deletes a replacement owner based on an older stale observation', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const stale = state({ runtimeId: 'runtime-stale', pid: 999 });
    writeRuntimeDaemonState(paths, stale);
    const staleLock = tryAcquireRuntimeDaemonLock(paths, owner('runtime-stale', 999));
    expect(staleLock).toBeDefined();
    expect(staleLock ? releaseRuntimeDaemonLock(staleLock) : false).toBe(true);
    expect(tryAcquireRuntimeDaemonLock(paths, owner('runtime-replacement', 777))).toBeDefined();

    const decision = claimRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      state: stale,
      pidAlive: false,
      endpointReachable: false,
      identityMatches: false,
    });

    expect(decision).toMatchObject({
      kind: 'wait',
      lockOwner: { runtimeId: 'runtime-replacement' },
    });
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({
      runtimeId: 'runtime-replacement',
    });
  });

  it('does not delete a reacquired lock with the same runtime and process identity', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const stale = state({ runtimeId: 'runtime-stale', pid: 999 });
    const observedOwner = owner('runtime-stale', 999);
    writeRuntimeDaemonState(paths, stale);
    const staleLock = tryAcquireRuntimeDaemonLock(paths, observedOwner);
    expect(staleLock).toBeDefined();
    expect(staleLock ? releaseRuntimeDaemonLock(staleLock) : false).toBe(true);
    const replacementOwner = {
      ...observedOwner,
      createdAt: '2026-07-09T00:00:02.000Z',
    };
    expect(tryAcquireRuntimeDaemonLock(paths, replacementOwner)).toBeDefined();

    const decision = claimRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      state: stale,
      pidAlive: false,
      endpointReachable: false,
      identityMatches: false,
      observedLockOwner: observedOwner,
    });

    expect(decision).toMatchObject({ kind: 'wait', lockOwner: replacementOwner });
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toEqual(replacementOwner);
  });

  it('refuses force cleanup when ownership changed after observation', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const stale = state({ runtimeId: 'runtime-stale', pid: 999 });
    writeRuntimeDaemonState(paths, stale);
    const staleLock = tryAcquireRuntimeDaemonLock(paths, owner('runtime-stale', 999));
    expect(staleLock).toBeDefined();
    expect(staleLock ? releaseRuntimeDaemonLock(staleLock) : false).toBe(true);
    expect(tryAcquireRuntimeDaemonLock(paths, owner('runtime-replacement', 777))).toBeDefined();

    expect(removeRuntimeDaemonOwnershipIfUnchanged(paths, {
      state: stale,
      lockOwner: owner('runtime-stale', 999),
    })).toBe(false);
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({
      runtimeId: 'runtime-replacement',
    });
  });

  it('refuses force cleanup after the same owner reacquires its lock', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const stale = state({ runtimeId: 'runtime-stale', pid: 999 });
    const observedOwner = owner('runtime-stale', 999);
    writeRuntimeDaemonState(paths, stale);
    const staleLock = tryAcquireRuntimeDaemonLock(paths, observedOwner);
    expect(staleLock).toBeDefined();
    expect(staleLock ? releaseRuntimeDaemonLock(staleLock) : false).toBe(true);
    expect(tryAcquireRuntimeDaemonLock(paths, {
      ...observedOwner,
      createdAt: '2026-07-09T00:00:02.000Z',
    })).toBeDefined();

    expect(removeRuntimeDaemonOwnershipIfUnchanged(paths, {
      state: stale,
      lockOwner: observedOwner,
    })).toBe(false);
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({
      createdAt: '2026-07-09T00:00:02.000Z',
    });
  });

  it('waits for a live transitional daemon instead of marking it unhealthy', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const starting = state({ runtimeId: 'runtime-starting', status: 'starting' });
    writeRuntimeDaemonState(paths, starting);
    expect(tryAcquireRuntimeDaemonLock(paths, owner('runtime-starting', 777))).toBeDefined();

    const decision = claimRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      state: starting,
      pidAlive: true,
      endpointReachable: false,
      identityMatches: false,
    });

    expect(decision).toMatchObject({
      kind: 'wait',
      state: starting,
      lockOwner: { runtimeId: 'runtime-starting' },
    });
    expect(readRuntimeDaemonState(paths)).toEqual(starting);
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({ runtimeId: 'runtime-starting' });
  });

  it('does not delete ownership for live unhealthy or mismatched daemon states', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const current = state({ runtimeId: 'runtime-live', pid: 777 });
    writeRuntimeDaemonState(paths, current);
    const liveLock = tryAcquireRuntimeDaemonLock(paths, owner('runtime-live', 777));
    expect(liveLock).toBeDefined();

    const unhealthy = claimRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      state: current,
      pidAlive: true,
      endpointReachable: false,
      identityMatches: false,
    });
    const mismatch = claimRuntimeDaemonOwnership(paths, owner('runtime-next'), {
      state: current,
      pidAlive: true,
      endpointReachable: true,
      identityMatches: false,
    });

    expect(unhealthy).toMatchObject({ kind: 'unhealthy', health: 'unhealthy' });
    expect(mismatch).toMatchObject({ kind: 'unhealthy', health: 'mismatch' });
    expect(readRuntimeDaemonState(paths)).toEqual(current);
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({ runtimeId: 'runtime-live' });
  });
});

function owner(runtimeId: string, pid = 111): { runtimeId: string; pid: number; createdAt: string } {
  return {
    runtimeId,
    pid,
    createdAt: '2026-07-09T00:00:00.000Z',
  };
}
