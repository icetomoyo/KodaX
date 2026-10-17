import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FileSessionStorage } from '../packages/repl/src/interactive/storage.js';
import { createKodaXRuntime } from './sdk-runtime.js';

it('passes preflight cancellation into canonical Actor metadata reads', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-preflight-cancel-'));
  const sessionsDir = path.join(homeDir, '.kodax', 'sessions');
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(path.join(sessionsDir, 'cancel.jsonl'), JSON.stringify({
    _type: 'meta', id: 'cancel', title: 'cancel', gitRoot: homeDir,
    createdAt: '2026-10-17T00:00:00.000Z', activeMessageCount: 0,
  }) + '\n');
  const runtime = await createKodaXRuntime({ homeDir });
  const controller = new AbortController();
  let entered!: (signal: AbortSignal | undefined) => void;
  const reading = new Promise<AbortSignal | undefined>(resolve => { entered = resolve; });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const original = FileSessionStorage.prototype.readActorMetadata;
  const metadata = vi.spyOn(FileSessionStorage.prototype, 'readActorMetadata').mockImplementation(async function (this: FileSessionStorage, id, options) {
    entered(options?.signal);
    await pending;
    return original.call(this, id, options);
  });
  const operation = runtime.status.preflight({ signal: controller.signal });
  const outcome = operation.then(() => 'resolved', error => error);
  try {
    expect(await reading).toBe(controller.signal);
    controller.abort();
    release();
    await expect(outcome).resolves.toMatchObject({ code: 'read_cancelled' });
  } finally {
    release();
    await outcome;
    metadata.mockRestore();
    await runtime.close();
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

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
