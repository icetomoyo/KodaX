import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { ClientStartupProgress } from '@kodax-ai/coding/client-contract';
import { acquireRuntimeDaemonProcessLease, waitForRuntimeDaemonOwnerExit } from './process.js';
import { observeRuntimeDaemonHealth } from './lifecycle.js';
import {
  acquireRuntimeSessionStorageOwner, findRuntimeSessionStorageHost,
  readRuntimeDaemonLockOwner, readRuntimeDaemonState, readRuntimeDaemonToken,
  readRuntimeOwnerProcessStartIdentity, resolveRuntimeDaemonEndpointScope,
  resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock, writeRuntimeDaemonState,
  tryAcquireRuntimeSessionStorageStartup,
} from './state.js';
import { createRuntimeDaemonSocketClientTransport, defaultRuntimeDaemonEndpoint } from './transport.js';
import type { RuntimeDaemonClientTransport } from './client.js';

describe('Host launcher waits for the original process', () => {
  it.skipIf(process.platform !== 'linux')('recovers shared storage and confirms exit while the original PID is an unreaped zombie', async () => {
    // This parent deliberately waits for stdin before waitpid. Node never owns
    // the terminated child, so libuv cannot reap it before the assertions.
    const parent = spawn('python3', ['-c', [
      'import os, sys',
      'pid = os.fork()',
      'if pid == 0: os._exit(0)',
      'print(pid, flush=True)',
      'sys.stdin.readline()',
      'os.waitpid(pid, 0)',
    ].join('\n')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(parent, 'exit');
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'kodax-zombie-owner-'));
    try {
      const [output] = await once(parent.stdout, 'data') as [Buffer];
      const pid = Number(output.toString().trim());
      expect(pid).toBeGreaterThan(0);
      const stat = (): string => readFileSync(`/proc/${pid}/stat`, 'utf8');
      await expect.poll(() => {
        const value = stat();
        return value.slice(value.lastIndexOf(') ') + 2).split(' ')[0];
      }).toBe('Z');
      expect(() => process.kill(pid, 0)).not.toThrow();
      const processStartIdentity = readRuntimeOwnerProcessStartIdentity(pid);
      expect(processStartIdentity).toBeDefined();
      const owner = { runtimeId: 'unreaped-host', pid, processStartIdentity,
        createdAt: new Date().toISOString(), kind: 'daemon' as const };
      const paths = resolveRuntimeDaemonPaths(homeDir);
      expect(tryAcquireRuntimeDaemonLock(paths, owner)).toBeDefined();
      writeRuntimeDaemonState(paths, { runtimeId: owner.runtimeId, pid, profile: paths.profile,
        startedAt: owner.createdAt, endpoint: '/tmp/terminated-host.sock', version: 'test', status: 'ready' });
      const sessionsDir = path.join(paths.configHome, 'sessions');
      const ownerFile = path.join(sessionsDir, '.product-host', 'owner.lock');
      mkdirSync(path.dirname(ownerFile), { recursive: true });
      writeFileSync(ownerFile, JSON.stringify(owner));
      const startupFile = path.join(path.dirname(ownerFile), 'startup.lock');
      writeFileSync(startupFile, JSON.stringify({ ...owner, runtimeId: 'owner-transition-zombie', nonce: 'zombie' }));
      const releaseStartup = tryAcquireRuntimeSessionStorageStartup(sessionsDir);
      expect(releaseStartup).toBeTypeOf('function');
      releaseStartup?.();

      expect(findRuntimeSessionStorageHost(paths.configHome, sessionsDir)).toBeUndefined();
      expect(await observeRuntimeDaemonHealth(paths, {
        createTransport: async () => { throw new Error('Terminated Host endpoint'); },
      })).toMatchObject({ pidAlive: false, endpointReachable: false });
      await expect(waitForRuntimeDaemonOwnerExit(owner, 100)).resolves.toBeUndefined();
      const replacement = acquireRuntimeSessionStorageOwner(sessionsDir, 'replacement-host');
      expect(readRuntimeDaemonLockOwner(replacement.file)?.runtimeId).toBe('replacement-host');
      // Reclamation and exit verification did not depend on reaping.
      expect(stat()).toContain(') Z ');
    } finally {
      parent.stdin.end('\n');
      await exited;
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it.each([
    { status: 'stopping', reachable: true },
    { status: 'stopping', reachable: false },
    { status: 'draining', reachable: false },
  ] as const)('waits for a $status owner (reachable=$reachable) to exit before acquiring a replacement', async ({ status, reachable }) => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'kodax-owner-transition-'));
    const paths = resolveRuntimeDaemonPaths(homeDir, 'transition');
    const endpoint = defaultRuntimeDaemonEndpoint(paths.profile,
      resolveRuntimeDaemonEndpointScope(homeDir, paths.configHome));
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); process.stdin.resume();'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const exited = once(child, 'exit');
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    let lease: Awaited<ReturnType<typeof acquireRuntimeDaemonProcessLease>> | undefined;
    const progress: ClientStartupProgress[] = [];
    try {
      await once(child.stdout, 'data');
      const pid = child.pid;
      if (pid === undefined) throw new Error('Child did not start');
      const processStartIdentity = readRuntimeOwnerProcessStartIdentity(pid);
      if (processStartIdentity === undefined) throw new Error('Child process identity unavailable');
      const owner = { runtimeId: 'exiting-owner', pid, processStartIdentity,
        createdAt: new Date().toISOString(), kind: 'daemon' as const };
      expect(tryAcquireRuntimeDaemonLock(paths, owner)).toBeDefined();
      writeRuntimeDaemonState(paths, { runtimeId: owner.runtimeId, pid, profile: paths.profile,
        startedAt: owner.createdAt, endpoint: endpoint.path, version: '0.0.1', status });
      let observedOldOwner = false;
      lease = await acquireRuntimeDaemonProcessLease({ homeDir, profile: paths.profile,
        startupTimeoutMs: 30_000,
        onStartupProgress: (event) => {
          progress.push(event);
          if (event.stage === 'waiting' && event.reason === 'host_stopping') {
            releaseTimer = setTimeout(() => child.stdin.end(), 50);
          }
        },
        healthCheck: {
          async createTransport(target) {
            if (!observedOldOwner) {
              observedOldOwner = true;
              if (!reachable) throw new Error('Old endpoint has already closed');
              return {
                async request() { return { identity: { runtimeId: owner.runtimeId, profile: paths.profile } }; },
                subscribe() { return { close() {} }; },
              };
            }
            return createRuntimeDaemonSocketClientTransport(target);
          },
        },
      });
      const originalExitedBeforeLease = child.exitCode === 0;
      await lease.transport.request('initialize', { profile: paths.profile, token: readRuntimeDaemonToken(paths) });
      expect(originalExitedBeforeLease).toBe(true);
      expect(progress.some(event => event.stage === 'initializing')).toBe(true);
      expect(progress.filter(event => event.stage !== 'initializing')).toEqual([
        { stage: 'checking' }, { stage: 'waiting', reason: 'host_stopping' }, { stage: 'checking' },
        { stage: 'starting' }, { stage: 'waiting', reason: 'host_starting' }, { stage: 'connecting' },
      ]);
      expect(readRuntimeDaemonState(paths)?.status).toBe('ready');
      expect(readRuntimeDaemonLockOwner(paths.lockFile)?.runtimeId).not.toBe(owner.runtimeId);
    } finally {
      if (releaseTimer) clearTimeout(releaseTimer);
      if (lease) {
        const replacementOwner = readRuntimeDaemonLockOwner(paths.lockFile);
        await lease.shutdown();
        if (replacementOwner) await waitForRuntimeDaemonOwnerExit(replacementOwner, 30_000);
      }
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('waits for actual process exit and does not kill a live owner on timeout or cancellation', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); process.stdin.resume();'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const exited = once(child, 'exit');
    try {
      await once(child.stdout, 'data');
      const pid = child.pid;
      if (pid === undefined) throw new Error('Child did not start');
      const processStartIdentity = readRuntimeOwnerProcessStartIdentity(pid);
      if (processStartIdentity === undefined) throw new Error('Child process identity unavailable');
      const owner = { pid, processStartIdentity };
      await expect(waitForRuntimeDaemonOwnerExit(owner, 30)).rejects.toThrow('still running');
      expect(child.exitCode).toBeNull();
      expect(() => process.kill(pid, 0)).not.toThrow();

      const controller = new AbortController();
      // Exercise cancellation independently of the short deadline above:
      // the real Windows identity probe can itself take more than a second.
      const cancelled = waitForRuntimeDaemonOwnerExit(owner, 30_000, controller.signal);
      controller.abort();
      await expect(cancelled).rejects.toThrow('startup cancelled');
      expect(child.exitCode).toBeNull();
      expect(() => process.kill(pid, 0)).not.toThrow();

      const waiting = waitForRuntimeDaemonOwnerExit(owner, 5_000);
      child.stdin.end();
      await exited;
      await expect(waiting).resolves.toBeUndefined();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
  });

  it('re-observes an unhealthy owner instead of refusing on one failed probe', async () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'kodax-owner-recheck-'));
    const paths = resolveRuntimeDaemonPaths(homeDir, 'recheck');
    const endpoint = defaultRuntimeDaemonEndpoint(paths.profile,
      resolveRuntimeDaemonEndpointScope(homeDir, paths.configHome));
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); process.stdin.resume();'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let probes = 0;
    try {
      await once(child.stdout, 'data');
      const pid = child.pid;
      if (pid === undefined) throw new Error('Child did not start');
      const processStartIdentity = readRuntimeOwnerProcessStartIdentity(pid);
      if (processStartIdentity === undefined) throw new Error('Child process identity unavailable');
      const owner = { runtimeId: 'slow-owner', pid, processStartIdentity,
        createdAt: new Date().toISOString(), kind: 'daemon' as const };
      expect(tryAcquireRuntimeDaemonLock(paths, owner)).toBeDefined();
      writeRuntimeDaemonState(paths, { runtimeId: owner.runtimeId, pid, profile: paths.profile,
        startedAt: owner.createdAt, endpoint: endpoint.path, version: '0.0.1', status: 'ready' });
      // The first probe misses the handshake window (a busy host can do this)
      // and the owner is a stub without a real endpoint, so the attach attempt
      // afterwards fails to connect — the behavior under test is that recovery
      // re-observes and takes the attach path instead of refusing forever.
      await expect(acquireRuntimeDaemonProcessLease({ homeDir, profile: paths.profile,
        startupTimeoutMs: 30_000,
        connectTimeoutMs: 500,
        healthCheck: {
          async createTransport(target) {
            probes += 1;
            if (probes === 1) throw new Error('handshake timed out');
            return {
              async request() { return { identity: { runtimeId: owner.runtimeId, profile: paths.profile } }; },
              subscribe() { return { close() {} }; },
            };
          },
        },
      })).rejects.not.toThrow(/refusing to start a competing owner/);
      expect(probes).toBeGreaterThanOrEqual(2);
      expect(readRuntimeDaemonLockOwner(paths.lockFile)?.runtimeId).toBe(owner.runtimeId);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      rmSync(homeDir, { recursive: true, force: true });
      try { await once(child, 'exit'); } catch { /* already gone */ }
    }
  }, 60_000);

  it('still refuses a persistently unreachable owner after the recheck budget', async () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'kodax-owner-hung-'));
    const paths = resolveRuntimeDaemonPaths(homeDir, 'hung');
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); process.stdin.resume();'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    try {
      await once(child.stdout, 'data');
      const pid = child.pid;
      if (pid === undefined) throw new Error('Child did not start');
      const processStartIdentity = readRuntimeOwnerProcessStartIdentity(pid);
      if (processStartIdentity === undefined) throw new Error('Child process identity unavailable');
      const owner = { runtimeId: 'hung-owner', pid, processStartIdentity,
        createdAt: new Date().toISOString(), kind: 'daemon' as const };
      expect(tryAcquireRuntimeDaemonLock(paths, owner)).toBeDefined();
      writeRuntimeDaemonState(paths, { runtimeId: owner.runtimeId, pid, profile: paths.profile,
        startedAt: owner.createdAt, endpoint: '\\\\.\\pipe\\kodax-owner-hung-missing', version: '0.0.1', status: 'ready' });
      await expect(acquireRuntimeDaemonProcessLease({ homeDir, profile: paths.profile,
        startupTimeoutMs: 30_000,
        healthCheck: {
          async createTransport() { throw new Error('endpoint never answers'); },
        },
      })).rejects.toThrow(/unhealthy; refusing to start a competing owner/);
      expect(child.exitCode).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await once(child, 'exit');
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('reports cancellation while re-observing an unreachable live owner', async () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'kodax-owner-recheck-cancel-'));
    const paths = resolveRuntimeDaemonPaths(homeDir, 'cancel');
    const controller = new AbortController();
    const owner = { runtimeId: 'live-owner', pid: process.pid, createdAt: new Date().toISOString() };
    expect(tryAcquireRuntimeDaemonLock(paths, owner)).toBeDefined();
    writeRuntimeDaemonState(paths, { runtimeId: owner.runtimeId, pid: owner.pid, profile: paths.profile,
      startedAt: owner.createdAt, endpoint: '/missing-owner.sock', version: 'test', status: 'ready' });
    const probe = vi.fn(async () => { throw new Error('Endpoint unavailable'); });
    try {
      const opening = acquireRuntimeDaemonProcessLease({ homeDir, profile: paths.profile,
        startupSignal: controller.signal,
        healthCheck: { isPidAlive: () => true, createTransport: probe },
      });
      const cancelled = expect(opening).rejects.toMatchObject({ reason: 'cancelled' });
      await expect.poll(() => probe.mock.calls.length).toBeGreaterThan(0);
      await new Promise<void>(resolve => setImmediate(resolve));
      controller.abort();
      await cancelled;
      expect(readRuntimeDaemonLockOwner(paths.lockFile)?.runtimeId).toBe(owner.runtimeId);
    } finally {
      controller.abort();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it.each([0, 1])('cancels an in-flight probe after %i failed probes and closes it without replacing the owner', async failedProbes => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'kodax-owner-probe-cancel-'));
    const paths = resolveRuntimeDaemonPaths(homeDir, 'cancel');
    const controller = new AbortController();
    const owner = { runtimeId: 'live-owner', pid: process.pid, createdAt: new Date().toISOString() };
    expect(tryAcquireRuntimeDaemonLock(paths, owner)).toBeDefined();
    writeRuntimeDaemonState(paths, { runtimeId: owner.runtimeId, pid: owner.pid, profile: paths.profile,
      startedAt: owner.createdAt, endpoint: '/missing-owner.sock', version: 'test', status: 'ready' });
    let releaseProbe!: (transport: RuntimeDaemonClientTransport) => void;
    let reachedProbe!: () => void;
    const entered = new Promise<void>(resolve => { reachedProbe = resolve; });
    const lateProbe = new Promise<RuntimeDaemonClientTransport>(resolve => { releaseProbe = resolve; });
    const closeProbe = vi.fn();
    let probes = 0;
    let settled = false;
    let cancellation: unknown;
    const opening = acquireRuntimeDaemonProcessLease({ homeDir, profile: paths.profile,
      startupSignal: controller.signal, healthCheck: { isPidAlive: () => true, createTransport: async () => {
        if (probes++ < failedProbes) throw new Error('Endpoint unavailable');
        reachedProbe();
        return lateProbe;
      } },
    });
    const outcome = opening.then(lease => { settled = true; return lease; },
      error => { settled = true; cancellation = error; return undefined; });
    try {
      await entered;
      controller.abort();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(true);
      expect(cancellation).toMatchObject({ reason: 'cancelled' });
      expect(readRuntimeDaemonLockOwner(paths.lockFile)?.runtimeId).toBe(owner.runtimeId);
    } finally {
      controller.abort();
      releaseProbe({ async request() { return { identity: { runtimeId: owner.runtimeId, profile: paths.profile } }; },
        subscribe() { return { close() {} }; }, close: closeProbe });
      await (await outcome)?.close();
      await expect.poll(() => closeProbe.mock.calls.length).toBe(1);
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
