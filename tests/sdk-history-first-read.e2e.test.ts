import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { FileSessionStorage } from '@kodax-ai/repl';
import { ensureKodaXClient, connectKodaXClient } from '../src/sdk-client.js';
import { getKodaXRuntimeOwnerState, waitForRuntimeDaemonShutdown } from '../src/sdk-runtime.js';

it('reads fresh history after cold topology recovery, observation and a second Host generation', async () => {
  const homeDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-cold-history-'));
  const profile = 'cold-history';
  const configHome = path.join(homeDir, '.kodax');
  const sessionsDir = path.join(configHome, 'sessions');
  const storage = new FileSessionStorage({ configHome, sessionsDir });
  const messages = Array.from({ length: 30 }, (_, index) => ({ role: 'user' as const, inputId: `original-${index}`,
    content: `Retained original ${index}` }));
  await storage.save('cold-history', { title: 'Cold history', gitRoot: homeDir, messages });
  const lock = path.join(sessionsDir, '.location-topology.lock');
  const owner = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    'const { acquireLearningFileLock } = await import(process.argv[2]); await acquireLearningFileLock(process.argv[1]); process.exit(1);',
    lock, pathToFileURL(path.resolve('packages/agent/src/learning/store-lock.ts')).href],
  { windowsHide: true });
  expect(owner.status).toBe(1);
  let client = await ensureKodaXClient({ homeDir, profile });
  try {
    for (let generation = 0; generation < 2; generation += 1) {
      const peer = await connectKodaXClient({ homeDir, profile });
      try {
        const observation = await peer.sessions.observe('cold-history', () => undefined);
        try {
          const [a, b] = await Promise.all([client.sessions.readHistory('cold-history', { limit: 5 }),
            peer.sessions.readHistory('cold-history', { limit: 5 })]);
          expect(a).toEqual(b);
          expect(a.items.at(-1)?.text).toBe('Retained original 29');
          expect(a.nextCursor).toBeDefined();
          expect((await peer.sessions.readHistory('cold-history', { cursor: a.nextCursor, limit: 5 })).items).toHaveLength(5);
        } finally { observation.close(); }
      } finally { await peer.disconnect(); }
      if (generation === 0) {
        const previous = getKodaXRuntimeOwnerState({ homeDir, profile }).owner!;
        await client.host.shutdown(); await client.disconnect();
        expect(await waitForRuntimeDaemonShutdown({ configHome, profile, owner: previous })).toMatchObject({ status: 'succeeded' });
        client = await ensureKodaXClient({ homeDir, profile });
      }
    }
    expect((await storage.load('cold-history'))?.messages.map(message => message.content)).toEqual(messages.map(message => message.content));
  } finally {
    const current = getKodaXRuntimeOwnerState({ homeDir, profile }).owner;
    await client.host.shutdown(); await client.disconnect();
    if (current) expect(await waitForRuntimeDaemonShutdown({ configHome, profile, owner: current })).toMatchObject({ status: 'succeeded' });
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);
