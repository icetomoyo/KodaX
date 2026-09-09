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
    await expect(sdk.connectKodaXClient({ homeDir, profile })).rejects.toThrow();
    client = await sdk.ensureKodaXClient({ homeDir, profile, daemonStartupTimeoutMs: 60_000 });
    const session = await client.sessions.create({ title: 'Shared product Session', projectPath: homeDir });
    const observer = await sdk.connectKodaXClient({ homeDir, profile });
    try {
      await expect(observer.sessions.read(session.id)).resolves.toMatchObject({ id: session.id, title: session.title });
    } finally { await observer.disconnect(); }
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
