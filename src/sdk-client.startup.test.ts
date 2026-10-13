import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import * as sdk from './sdk-client.js';
import { readRuntimeDaemonLockOwner, resolveRuntimeDaemonPaths } from './runtime-daemon/state.js';
import { waitForRuntimeDaemonOwnerExit } from './runtime-daemon/process.js';

it('starts one Host through the product SDK and shares its Session with passive clients', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-startup-'));
  const profile = 'product-startup';
  let client: Awaited<ReturnType<typeof sdk.connectKodaXClient>> | undefined;
  try {
    const failedProgress: sdk.ClientStartupProgress[] = [];
    await expect(sdk.connectKodaXClient({ homeDir, profile,
      onStartupProgress: (event) => { failedProgress.push(event); }, })).rejects.toThrow();
    expect(failedProgress).toEqual([{ stage: 'connecting' }]);
    const progress: sdk.ClientStartupProgress[] = [];
    client = await sdk.ensureKodaXClient({ homeDir, profile, daemonStartupTimeoutMs: 60_000,
      onStartupProgress: (event) => { progress.push(event); }, });
    expect(progress).toEqual([
      { stage: 'checking' }, { stage: 'starting' }, { stage: 'waiting', reason: 'host_starting' },
      { stage: 'connecting' }, { stage: 'ready' },
    ]);
    const session = await client.sessions.create({ title: 'Shared product Session', projectPath: homeDir });
    const attachedProgress: sdk.ClientStartupProgress[] = [];
    const observer = await sdk.connectKodaXClient({ homeDir, profile,
      onStartupProgress: (event) => { attachedProgress.push(event); }, });
    try {
      expect(attachedProgress).toEqual([{ stage: 'connecting' }, { stage: 'ready' }]);
      await expect(observer.sessions.read(session.id)).resolves.toMatchObject({ id: session.id, title: session.title });
    } finally { await observer.disconnect(); }
    const ensuredProgress: sdk.ClientStartupProgress[] = [];
    const ensured = await sdk.ensureKodaXClient({ homeDir, profile,
      onStartupProgress: (event) => { ensuredProgress.push(event); }, });
    try {
      expect(ensuredProgress).toEqual([{ stage: 'checking' }, { stage: 'connecting' }, { stage: 'ready' }]);
      await expect(ensured.sessions.read(session.id)).resolves.toMatchObject({ id: session.id });
    } finally { await ensured.disconnect(); }
  } finally {
    if (client) {
      const owner = readRuntimeDaemonLockOwner(resolveRuntimeDaemonPaths(homeDir, profile).lockFile);
      await client.host.shutdown();
      await client.disconnect();
      if (owner) await waitForRuntimeDaemonOwnerExit(owner, 30_000);
    }
    await rm(homeDir, { recursive: true, force: true });
  }
}, 120_000);
