import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

const contention = vi.hoisted(() => ({
  enabled: false, calls: 0, snapshots: [] as unknown[],
  firstInspected: undefined as (() => void) | undefined,
  peerInspected: undefined as (() => void) | undefined,
  holdFirst: undefined as Promise<void> | undefined,
}));

vi.mock('./runtime-daemon/transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime-daemon/transport.js')>();
  return { ...actual, createRuntimeDaemonSocketClientTransport: async (
    ...args: Parameters<typeof actual.createRuntimeDaemonSocketClientTransport>
  ) => {
    const transport = await actual.createRuntimeDaemonSocketClientTransport(...args);
    return { ...transport, request: async (...request: Parameters<typeof transport.request>) => {
      if (!contention.enabled || request[0] !== 'daemon.management.get') {
        return transport.request(...request);
      }
      const first = contention.calls++ === 0;
      if (!first) contention.peerInspected?.();
      const result = await transport.request(...request);
      contention.snapshots.push(result);
      if (first) {
        contention.firstInspected?.();
        await contention.holdFirst;
      }
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
  const cancellation = new AbortController();
  let releaseFirst!: () => void;
  const inspected = new Promise<void>(resolve => { contention.firstInspected = resolve; });
  const peerInspected = new Promise<string>(resolve => { contention.peerInspected = () => resolve('peer inspected the old Host'); });
  contention.holdFirst = new Promise<void>(resolve => { releaseFirst = resolve; });
  const pending: Array<ReturnType<typeof ensureKodaXRuntime>> = [];
  try {
    await waitForHost(paths, () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Old Host startup failed: ${output}`);
    });
    const old = await connectKodaXRuntime({ homeDir, profile });
    const oldId = old.identity.runtimeId;
    const saved = await old.sessions.create({ title: 'Keep across Host refresh' });
    await old.close();
    contention.enabled = true;
    const startup = { homeDir, profile, daemonStartupTimeoutMs: 60_000, daemonStartupSignal: cancellation.signal };
    pending.push(ensureKodaXRuntime(startup));
    await Promise.race([inspected, pending[0]!.then(() => { throw new Error('Launcher skipped the held inspection'); })]);
    const queued = new Promise<string>(resolve => {
      pending.push(ensureKodaXRuntime({ ...startup, onStartupProgress(progress) {
        if (progress.stage === 'waiting' && progress.reason === 'host_starting') resolve('queued');
      } }));
    });
    // The peer must wait before attaching another management Client, rather
    // than repeatedly counting temporary launchers as real connected work.
    await expect(Promise.race([queued, peerInspected,
      pending[1]!.then(() => 'peer finished without queueing')])).resolves.toBe('queued');
    expect(contention.snapshots).toHaveLength(1);
    expect(contention.snapshots[0]).toMatchObject({ preflight: {
      clientCount: 1, blockers: [], activeRuns: [],
      clients: [expect.objectContaining({ name: 'kodax-host-launcher' })],
    } });
    releaseFirst();
    const connections = await Promise.allSettled(pending);
    const clients = connections.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    try {
      expect(contention.snapshots).toHaveLength(1);
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
    releaseFirst();
    cancellation.abort(new Error('Launcher fixture cleanup'));
    for (const result of await Promise.allSettled(pending)) {
      if (result.status === 'fulfilled') await result.value.close();
    }
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
