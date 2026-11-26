import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createRequestId, type HostConnectionState, type HostSessionView } from './host-protocol/host-client.js';
import { ensureKodaXHostClient } from './local-host-client.js';
import { waitForRuntimeDaemonOwnerExit } from './runtime-daemon/process.js';
import { readRuntimeDaemonLockOwner, resolveRuntimeDaemonPaths, type RuntimeDaemonPaths } from './runtime-daemon/state.js';

let homeDir: string;
let paths: RuntimeDaemonPaths;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-v2-launcher-'));
  paths = resolveRuntimeDaemonPaths(homeDir);
  fs.mkdirSync(paths.configHome, { recursive: true });
});

afterEach(async () => {
  // The Host runs detached: a failed test must still not leave it running.
  const owner = readRuntimeDaemonLockOwner(paths.lockFile);
  if (owner?.pid && owner.pid !== process.pid) {
    try { process.kill(owner.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
}, 120_000);

it('starts the Host of a home, and starts it again and follows the Session when that Host dies', async () => {
  const onError = vi.fn();
  const client = await ensureKodaXHostClient({
    client: { name: 'v2-launcher-test', version: '1.0.0' }, homeDir, daemonStartupTimeoutMs: 60_000, onError,
  });
  try {
    const states: HostConnectionState['state'][] = [];
    client.onConnectionChange(state => states.push(state.state));
    expect(client.handshake).toMatchObject({ role: 'owner', subject: 'person' });
    // The connection that started the Host is gone; only this client holds it.
    const { clients } = await client.call('host.preflight');
    expect(clients.map(entry => entry.name)).toEqual(['v2-launcher-test']);

    const { session } = await client.call('session.create', { requestId: createRequestId(), projectRoot: homeDir, title: 'kept' });
    const views: Array<HostSessionView<'local'>> = [];
    await client.observeSession(session.id, { onView: view => views.push(view) });
    expect(views).toHaveLength(1);

    const first = client.handshake.host.id;
    const owner = readRuntimeDaemonLockOwner(paths.lockFile);
    process.kill(owner!.pid!, 'SIGKILL');
    await waitForRuntimeDaemonOwnerExit({ pid: owner!.pid!, processStartIdentity: owner!.processStartIdentity }, 30_000);

    await vi.waitFor(() => expect(client.handshake.host.id).not.toBe(first), { timeout: 90_000, interval: 100 });
    // A Session lock the dead Host held can turn a read away for a moment after the restart.
    await vi.waitFor(async () => {
      await expect(client.call('session.get', { sessionId: session.id })).resolves.toMatchObject({ session: { title: 'kept' } });
    }, { timeout: 30_000, interval: 200 });
    await vi.waitFor(() => expect(views.length).toBeGreaterThan(1), { timeout: 30_000, interval: 100 });
    expect(states).toEqual(['connected', 'reconnecting', 'connected']);
    // Starting and following the Host still checks it over v1, which is not product use.
    expect(fs.readFileSync(paths.logFile, 'utf8')).toContain('Runtime daemon ready.');
    expect(fs.readFileSync(paths.logFile, 'utf8')).not.toContain('Host protocol v1');
  } finally {
    client.close();
  }
}, 240_000);

it('lets a Host it starts with exitWhenIdle stop once its last client leaves', async () => {
  const client = await ensureKodaXHostClient({
    client: { name: 'v2-launcher-idle', version: '1.0.0' }, homeDir, daemonStartupTimeoutMs: 60_000, exitWhenIdle: true,
  });
  const owner = readRuntimeDaemonLockOwner(paths.lockFile);
  expect(owner?.pid).toBeDefined();
  client.close();
  await waitForRuntimeDaemonOwnerExit({ pid: owner!.pid!, processStartIdentity: owner!.processStartIdentity }, 90_000);
}, 180_000);
