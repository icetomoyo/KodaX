import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

const contention = vi.hoisted(() => ({
  enabled: false, calls: 0, arrivals: [] as Array<() => void>, responses: [] as Array<() => void>, snapshots: [] as unknown[],
}));

vi.mock('./runtime-daemon/transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime-daemon/transport.js')>();
  const rendezvous = (waiting: Array<() => void>): Promise<void> => new Promise(resolve => {
    waiting.push(resolve);
    if (waiting.length === 2) waiting.splice(0).forEach(release => release());
  });
  return { ...actual, createRuntimeDaemonSocketClientTransport: async (
    ...args: Parameters<typeof actual.createRuntimeDaemonSocketClientTransport>
  ) => {
    const transport = await actual.createRuntimeDaemonSocketClientTransport(...args);
    return { ...transport, request: async (...request: Parameters<typeof transport.request>) => {
      if (!contention.enabled || request[0] !== 'daemon.management.get' || contention.calls++ >= 8) {
        return transport.request(...request);
      }
      // Four real overlapping inspections: neither temporary client may
      // disconnect until both Host snapshots have observed the contention.
      await rendezvous(contention.arrivals);
      const result = await transport.request(...request);
      contention.snapshots.push(result);
      await rendezvous(contention.responses);
      return result;
    } };
  } };
});
import { connectKodaXRuntime, ensureKodaXRuntime } from './sdk-runtime.js';
import { observeRuntimeDaemonHealth } from './runtime-daemon/lifecycle.js';
import { waitForRuntimeDaemonOwnerExit } from './runtime-daemon/process.js';
import {
  readRuntimeDaemonLockOwner, readRuntimeDaemonState, readRuntimeDaemonToken,
  resolveRuntimeDaemonPaths, type RuntimeDaemonPaths,
} from './runtime-daemon/state.js';
import { createRuntimeDaemonSocketClientTransport } from './runtime-daemon/transport.js';

it('concurrent launchers refresh a real idle older Host and keep its saved Session available', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-host-refresh-'));
  const profile = 'refresh';
  const paths = resolveRuntimeDaemonPaths(homeDir, profile);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/kodax_cli.ts', 'daemon', 'serve',
    '--home', homeDir, '--config-home', paths.configHome, '--profile', profile,
  ], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, KODAX_HOME: paths.configHome, KODAX_VERSION: '0.0.1', KODAX_INTERNAL_DAEMON_TEST_PARENT_PID: String(process.pid) },
  });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    await waitForHost(paths, () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Old Host startup failed: ${output}`);
    });
    const old = await connectKodaXRuntime({ homeDir, profile });
    const oldId = old.identity.runtimeId;
    const saved = await old.sessions.create({ title: 'Keep across Host refresh' });
    await old.close();
    contention.enabled = true;
    const connections = await Promise.allSettled([
      ensureKodaXRuntime({ homeDir, profile, daemonStartupTimeoutMs: 60_000 }),
      ensureKodaXRuntime({ homeDir, profile, daemonStartupTimeoutMs: 60_000 }),
    ]);
    const clients = connections.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    try {
      expect(contention.snapshots).toHaveLength(8);
      for (const snapshot of contention.snapshots) expect(snapshot).toMatchObject({ preflight: {
        clientCount: 2, blockers: ['connected_clients'], activeRuns: [],
        clients: [expect.objectContaining({ name: 'kodax-host-launcher' }), expect.objectContaining({ name: 'kodax-host-launcher' })],
      } });
      const rejected = connections.filter((result) => result.status === 'rejected');
      expect(rejected, rejected.map(result => String(result.reason)).join('\n')).toEqual([]);
      const current = clients[0]!;
      expect(current.identity.runtimeId).not.toBe(oldId);
      expect(clients[1]!.identity.runtimeId).toBe(current.identity.runtimeId);
      expect(child.exitCode).toBe(0);
      await expect(current.sessions.load(saved.id)).resolves.toMatchObject({ title: 'Keep across Host refresh' });
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
  } finally {
    contention.enabled = false;
    await stopHost(paths);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}, 120_000);

async function waitForHost(paths: RuntimeDaemonPaths, checkChild: () => void): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    checkChild();
    const observed = await observeRuntimeDaemonHealth(paths);
    if (observed.state?.status === 'ready' && observed.identityMatches) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Host did not become ready');
}

async function stopHost(paths: RuntimeDaemonPaths): Promise<void> {
  const state = readRuntimeDaemonState(paths);
  const owner = readRuntimeDaemonLockOwner(paths.lockFile);
  if (!state || !owner) return;
  const transport = await createRuntimeDaemonSocketClientTransport({
    kind: process.platform === 'win32' ? 'pipe' : 'unix', path: state.endpoint,
  });
  try {
    await transport.request('initialize', { profile: paths.profile, token: readRuntimeDaemonToken(paths) });
    await transport.request('runtime.shutdown');
  } finally {
    await transport.close?.();
  }
  await waitForRuntimeDaemonOwnerExit(owner, 30_000);
}
