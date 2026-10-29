import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { FileSessionStorage } from '../packages/repl/src/interactive/storage.js';
import { createKodaXRuntime } from "../tests/runtime-fixture.js";
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

it('exposes the same recent-message facts and pagination through the shared Host Client', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-recency-'));
  const storage = new FileSessionStorage({ sessionsDir: path.join(homeDir, '.kodax', 'sessions'), configHome: path.join(homeDir, '.kodax') });
  const oldMessages = [{ role: 'user' as const, content: 'earlier input', timestamp: '2026-10-01T00:00:00.000Z' }];
  await storage.save('old', { title: 'old', gitRoot: homeDir, messages: oldMessages });
  await storage.save('new', { title: 'new', gitRoot: homeDir, messages: [{ role: 'user', content: 'yesterday', timestamp: '2026-10-14T00:00:00.000Z' }] });
  await storage.save('old', { title: 'old', gitRoot: homeDir, messages: [...oldMessages, { role: 'assistant', content: 'today', timestamp: '2026-10-15T00:00:00.000Z' }] });
  await storage.save('partner', { title: 'excluded', gitRoot: homeDir,
    runtimeInfo: { surface: 'partner', profileId: 'partner' },
    messages: [{ role: 'user', content: 'other profile', timestamp: '2026-10-16T00:00:00.000Z' }],
  });
  const profile = 'recency';
  const runtime = await createKodaXRuntime({ homeDir, profile, sharedDaemonHost: true });
  try {
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt });
    if (!lock) throw new Error('Could not acquire the isolated Host');
    const endpoint = process.platform === 'win32'
      ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-recency-${randomUUID()}` }
      : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
    const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
    try {
      const client = await connectKodaXClient({ homeDir, profile, endpoint: endpoint.path });
      try {
        const first = await client.sessions.list({ limit: 1 });
        expect(first).toMatchObject([{ id: 'old', lastMessageAt: '2026-10-15T00:00:00.000Z' }]);
        expect(await client.sessions.list({ limit: 1, cursor: first[0]!.cursor }))
          .toMatchObject([{ id: 'new', lastMessageAt: '2026-10-14T00:00:00.000Z' }]);
        expect(await runtime.sessions.load('old')).toMatchObject({ lastMessageAt: '2026-10-15T00:00:00.000Z' });
        expect(await client.sessions.list({ scope: 'all' })).toEqual(await runtime.sessions.list({ scope: 'all' }));
      } finally { await client.disconnect(); }
    } finally { await host.close(); }
  } finally {
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
