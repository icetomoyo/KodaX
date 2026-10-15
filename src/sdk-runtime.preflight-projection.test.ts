import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FileSessionStorage } from '../packages/repl/src/interactive/storage.js';
import { createKodaXRuntime } from './sdk-runtime.js';

it('checks an old active Actor beyond the first list page and outside the current project without loading transcripts', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-preflight-projection-'));
  const sessionsDir = path.join(homeDir, '.kodax', 'sessions');
  await fs.mkdir(sessionsDir, { recursive: true });
  for (let index = 0; index < 60; index += 1) {
    const active = index === 0;
    const id = `session-${String(index).padStart(3, '0')}`;
    await fs.writeFile(path.join(sessionsDir, `${id}.jsonl`), [JSON.stringify({
      _type: 'meta', id, title: id, scope: 'user', gitRoot: path.join(homeDir, active ? 'other-project' : 'current-project'),
      createdAt: active ? '2026-10-01T00:00:00.000Z' : '2026-10-15T00:00:00.000Z', activeMessageCount: 1,
      ...(active ? { actorSnapshot: { schemaVersion: 1, revision: 1, maxConcurrentThreads: 4,
        actors: [{ path: '/root/worker', currentTurnId: 'active-turn', kind: 'native' }], turns: [], mailboxes: {}, events: [],
      } } : {}),
    }), JSON.stringify({ role: 'user', content: 'fixture conversation' })].join('\n') + '\n');
  }
  const runtime = await createKodaXRuntime({ homeDir });
  const peek = vi.spyOn(FileSessionStorage.prototype, 'peek');
  try {
    await expect(runtime.status.preflight()).resolves.toMatchObject({
      canStop: false, activeAgentTurns: [{ sessionId: 'session-000', actorPath: '/root/worker', turnId: 'active-turn' }],
    });
    expect(peek).not.toHaveBeenCalled();
  } finally {
    peek.mockRestore();
    await runtime.close();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it('rejects unreadable canonical metadata instead of inheriting presentation-list skip behavior', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-preflight-corrupt-'));
  const sessionsDir = path.join(homeDir, '.kodax', 'sessions');
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(path.join(sessionsDir, 'corrupt.jsonl'), '{broken\n');
  const runtime = await createKodaXRuntime({ homeDir });
  try {
    await expect(runtime.status.preflight()).rejects.toMatchObject({ code: 'data_corrupt' });
  } finally {
    await runtime.close();
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});
