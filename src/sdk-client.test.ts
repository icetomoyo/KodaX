import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import {
  resolveRuntimeDaemonPaths,
  tryAcquireRuntimeDaemonLock,
} from './runtime-daemon/state.js';

it('rejects an older Host before exposing an incomplete product contract', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-old-product-'));
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId,
    pid: process.pid, createdAt: runtime.identity.startedAt });
  if (!lock) throw new Error('Isolated old Host lock unavailable');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-old-product-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  const capabilities = { ...runtime.capabilities };
  delete capabilities.productClient;
  const host = await startRuntimeDaemonHost({ runtime: { ...runtime, capabilities }, paths, lock, endpoint });
  let unexpected: Awaited<ReturnType<typeof connectKodaXClient>> | undefined;
  try {
    await expect(connectKodaXClient({ homeDir, endpoint: endpoint.path }).then(client => {
      unexpected = client;
      return client;
    })).rejects.toThrow(/productClient/);
    // Passive rejection leaves the existing owner and its data available.
    expect(await runtime.sessions.list()).toEqual([]);
  } finally {
    await unexpected?.disconnect();
    await host.close();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

it('reads actual Host sessions through the product SDK without owning their lifetime', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-'));
  const profile = 'client-contract';
  const runtime = await createKodaXRuntime({ homeDir, profile });
  try {
    const first = await runtime.sessions.create({ title: 'Fix login', surface: 'repl' });
    await runtime.sessions.create({ title: 'Review parser', surface: 'sdk' });
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error('Test Host could not acquire its isolated directory.');
    const endpoint = process.platform === 'win32'
      ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-client-${randomUUID()}` }
      : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
    const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
    try {
      const client = await connectKodaXClient({ homeDir, profile, endpoint: endpoint.path });
      try {
        const sessions = await client.sessions.list({ surface: 'repl' });
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({ id: first.id, title: 'Fix login', msgCount: 0 });
        expect(await client.sessions.read(first.id)).toMatchObject({ id: first.id, title: 'Fix login' });
        // One Session policy controls both manual and automatic summaries;
        // it must survive the product SDK's read and live-view projections.
        expect(await client.sessions.updateSettings(first.id, {
          effort: 'high', compactionReasoning: { effort: 'low' },
        })).toMatchObject({ effort: 'high', compactionReasoning: { effort: 'low' } });
        expect(await client.sessions.getSettings(first.id)).toMatchObject({
          effort: 'high', compactionReasoning: { effort: 'low' },
        });
        const views: import('@kodax-ai/coding/client-contract').ClientSessionView[] = [];
        const observation = await client.sessions.observe(first.id, (view) => views.push(view));
        try {
          expect(views.at(-1)?.settings).toMatchObject({ compactionReasoning: { effort: 'low' } });
          expect(await client.sessions.updateSettings(first.id, { compactionReasoning: false }))
            .toMatchObject({ effort: 'high', compactionReasoning: false });
          await expect.poll(() => views.at(-1)?.settings.compactionReasoning).toBe(false);
          expect(await client.sessions.updateSettings(first.id, { compactionReasoning: null }))
            .not.toHaveProperty('compactionReasoning');
          await expect.poll(() => views.at(-1)?.settings.compactionReasoning).toBeUndefined();
          expect(await client.sessions.getSettings(first.id)).toMatchObject({ effort: 'high' });
        } finally {
          observation.close();
        }
        // Returned data belongs to the caller; changing it must not change Host facts.
        Object.assign(sessions[0], { title: 'Local display change' });
        expect(await client.sessions.read(first.id)).toMatchObject({ title: 'Fix login' });
      } finally {
        await client.disconnect();
      }
      const reconnected = await connectKodaXClient({ homeDir, profile, endpoint: endpoint.path });
      try {
        expect(await reconnected.sessions.list()).toHaveLength(2);
      } finally {
        await reconnected.disconnect();
      }
    } finally {
      await host.close();
    }
  } finally {
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
