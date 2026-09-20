import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { acquireRuntimeDaemonProcessLease, waitForRuntimeDaemonOwnerExit } from './process.js';
import {
  readRuntimeDaemonLockOwner, readRuntimeDaemonState, readRuntimeDaemonToken,
  readRuntimeOwnerProcessStartIdentity, resolveRuntimeDaemonEndpointScope,
  resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock, writeRuntimeDaemonState,
} from './state.js';
import { createRuntimeDaemonSocketClientTransport, defaultRuntimeDaemonEndpoint } from './transport.js';

describe('Host launcher waits for the original process', () => {
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
        healthCheck: {
          async createTransport(target) {
            if (!observedOldOwner) {
              observedOldOwner = true;
              releaseTimer = setTimeout(() => child.stdin.end(), 200);
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
      expect(child.exitCode).toBe(0);
      expect(readRuntimeDaemonState(paths)?.status).toBe('ready');
      expect(readRuntimeDaemonLockOwner(paths.lockFile)?.runtimeId).not.toBe(owner.runtimeId);
      await lease.transport.request('initialize', { profile: paths.profile, token: readRuntimeDaemonToken(paths) });
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
});
