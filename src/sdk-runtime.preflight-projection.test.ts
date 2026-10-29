import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FileSessionStorage } from '../packages/repl/src/interactive/storage.js';
import { createKodaXRuntime } from "../tests/runtime-fixture.js";

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

it('lists historical Runs while an admitted live Actor controller is persisting without an active Run', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-preflight-live-admission-'));
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const writing = new Promise<void>(resolve => { entered = resolve; });
  let saving: Promise<void> | undefined;
  let restoreRename: (() => void) | undefined;
  let listing: ReturnType<typeof runtime.runs.list> | undefined;
  try {
    const session = await runtime.sessions.create({ sessionId: 'live-admission', projectPath: homeDir, surface: 'cli' });
    await runtime.agents.tree(session.id);
    // Without a bound Run environment the turn fails before any provider call.
    const worker = await runtime.agents.spawn(session.id, { taskName: 'worker', objective: 'Create an idle mailbox target.' });
    await expect.poll(async () => (await runtime.agents.output(session.id, worker.actorPath)).state).toBe('failed');
    const sessionsDir = path.join(homeDir, '.kodax', 'sessions');
    const relative = (await fs.readdir(sessionsDir, { recursive: true })).find(file => path.basename(file) === `${session.id}.jsonl`);
    if (!relative) throw new Error('Expected the canonical Session file.');
    const sessionFile = path.join(sessionsDir, relative);
    const runDir = path.join(homeDir, '.kodax', 'runtime', 'profiles', 'default', 'runs', 'historical-run');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'status.json'), JSON.stringify({
      runId: 'historical-run', sessionId: session.id, phase: 'completed', provider: 'fixture',
      startedAt: '2026-10-01T00:00:00.000Z', endedAt: '2026-10-01T00:01:00.000Z',
    }));
    const originalRename = fs.rename;
    let held = false;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!held && String(to) === sessionFile) { held = true; entered(); await pending; }
      return originalRename(from, to);
    });
    restoreRename = () => rename.mockRestore();
    saving = runtime.agents.send(session.id, worker.actorPath, 'Persist a mailbox message without executing a Run.');
    await Promise.race([writing, saving.then(() => { throw new Error('Expected a paused Actor save.'); })]);
    let settled = false;
    listing = runtime.runs.list();
    void listing.then(() => { settled = true; }, () => { settled = true; });
    await expect.poll(() => settled, { timeout: 1_000 }).toBe(true);
    await expect(listing).resolves.toMatchObject([{ runId: 'historical-run', phase: 'completed' }]);
    release();
    await saving;
    restoreRename();
    restoreRename = undefined;
    await runtime.sessions.archive(session.id);
    const archived = (await fs.readdir(sessionsDir, { recursive: true })).find(file => path.basename(file) === `${session.id}.jsonl`);
    if (!archived) throw new Error('Expected the archived Session file.');
    await fs.writeFile(path.join(sessionsDir, archived), '{broken\n');
    await expect(runtime.runs.list()).rejects.toMatchObject({ code: 'data_corrupt' });
  } finally {
    release();
    await Promise.allSettled([saving, listing]);
    restoreRename?.();
    await runtime.close();
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

it.each(['completed', 'running'] as const)('checks shared Host safety with a %s Run and an unreadable Session body', async (phase) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-preflight-body-eio-'));
  const sessionsDir = path.join(homeDir, '.kodax', 'sessions');
  const sessionId = 'historical-body-eio';
  const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
  await fs.mkdir(sessionsDir, { recursive: true });
  const content = JSON.stringify({
    _type: 'meta', id: sessionId, title: sessionId, gitRoot: homeDir,
    createdAt: '2026-10-01T00:00:00.000Z', activeMessageCount: 1,
    runtimeInfo: { surface: 'cli' },
    ...(phase === 'running' ? { actorSnapshot: {
      schemaVersion: 1, revision: 1, maxConcurrentThreads: 4,
      actors: [{ path: '/root/worker', currentTurnId: 'active-turn', kind: 'native' }],
      turns: [], mailboxes: {}, events: [],
    } } : {}),
  }) + '\n' + JSON.stringify({ role: 'user', content: 'x'.repeat(600_000) }) + '\n';
  await fs.writeFile(sessionFile, content);
  const runDir = path.join(homeDir, '.kodax', 'runtime', 'profiles', 'coder', 'runs', 'historical-run');
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'status.json'), JSON.stringify({
    runId: 'historical-run', sessionId, phase, provider: 'fixture',
    startedAt: '2026-10-01T00:00:00.000Z',
    ...(phase === 'completed' ? { endedAt: '2026-10-01T00:01:00.000Z' } : {}),
  }));
  const runtime = await createKodaXRuntime({ homeDir, profile: 'coder', sharedDaemonHost: true });
  const readFile = fs.readFile;
  // Windows ERROR_CRC surfaced as EIO on a real historical file after 512 KiB.
  // Metadata reads through a file handle still succeed; a full-body read fails.
  const bodyRead = vi.spyOn(fs, 'readFile').mockImplementation(((...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === sessionFile) {
      return Promise.reject(Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }));
    }
    return readFile(...args);
  }) as typeof fs.readFile);
  try {
    await expect(runtime.runs.list()).resolves.toMatchObject([{
      runId: 'historical-run', phase: phase === 'completed' ? 'completed' : 'unknown',
    }]);
    await expect(runtime.status.preflight()).resolves.toMatchObject(phase === 'completed'
      ? { canStop: true, activeRuns: [], activeAgentTurns: [] }
      : { canStop: false, blockers: expect.arrayContaining(['active_runs', 'active_agent_turns']),
          activeRuns: [{ runId: 'historical-run', phase: 'unknown' }],
          activeAgentTurns: [{ sessionId, actorPath: '/root/worker', turnId: 'active-turn' }],
        });
    const metadataRead = vi.spyOn(FileSessionStorage.prototype, 'readActorMetadata')
      .mockRejectedValueOnce(Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }));
    try {
      await expect(runtime.runs.list()).rejects.toMatchObject({ code: 'EIO' });
    } finally {
      metadataRead.mockRestore();
    }
    await expect(runtime.sessions.load(sessionId)).rejects.toMatchObject({ code: 'EIO' });
  } finally {
    bodyRead.mockRestore();
    await runtime.close();
    expect(await fs.readFile(sessionFile, 'utf8')).toBe(content);
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});
