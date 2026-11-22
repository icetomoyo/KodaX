import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';

// A caller-chosen id names a file and travels to providers as X-Session-Id.
const unsafeIds = ['../escape', 'a/b', 'a.b', 'a:b', 'has space', '', 'x'.repeat(129), 'CON', 'nul', 'Com1', 'archived-chat'];

let homeDir: string;
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-session-id-'));
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
});

afterEach(async () => {
  await runtime.close();
  await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it.each(unsafeIds)('rejects creating a session named %j', async sessionId => {
  await expect(runtime.sessions.create({ sessionId, projectPath: homeDir })).rejects.toMatchObject({ code: 'invalid_params' });
});

it('accepts an opaque caller id', async () => {
  const sessionId = 'Chat_01-' + 'x'.repeat(120);
  await expect(runtime.sessions.create({ sessionId, projectPath: homeDir })).resolves.toMatchObject({ id: sessionId });
});

it.each(['../escape', 'a.b', 'CON'])('rejects forking into a session named %j', async newSessionId => {
  const source = await runtime.sessions.create({ projectPath: homeDir });
  await expect(runtime.sessions.fork({ sessionId: source.id, newSessionId })).rejects.toMatchObject({ code: 'invalid_params' });
});

it('refuses to fork into a Session that already exists, and leaves it as it was', async () => {
  const source = await runtime.sessions.create({ projectPath: homeDir });
  const other = await runtime.sessions.create({ projectPath: homeDir, title: 'Kept' });
  await expect(runtime.sessions.fork({ sessionId: source.id, newSessionId: other.id })).rejects.toMatchObject({ code: 'conflict' });
  expect(await runtime.sessions.load(other.id)).toMatchObject({ title: 'Kept' });
});

it('forks once for a request that is sent again', async () => {
  const source = await runtime.sessions.create({ projectPath: homeDir, requestId: 'create-1' });
  const fork = await runtime.sessions.fork({ sessionId: source.id, requestId: 'fork-1' });
  expect(fork!.id).not.toBe(source.id);
  expect(await runtime.sessions.fork({ sessionId: source.id, requestId: 'fork-1' })).toMatchObject({ id: fork!.id });
  await expect(runtime.sessions.fork({ sessionId: source.id, requestId: 'fork-1', title: 'Another' }))
    .rejects.toMatchObject({ code: 'conflict' });
  // The request chooses the id of the fork, so it cannot name one as well.
  await expect(runtime.sessions.fork({ sessionId: source.id, requestId: 'fork-2', newSessionId: 'chosen' }))
    .rejects.toMatchObject({ code: 'invalid_params' });
  // A fork is not the Session its source's request created.
  expect(await runtime.sessions.create({ projectPath: homeDir, requestId: 'create-1' })).toMatchObject({ id: source.id });
  expect((await runtime.sessions.list()).map(session => session.id).sort()).toEqual([source.id, fork!.id].sort());
});
