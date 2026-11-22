import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { FileSessionStorage } from '@kodax-ai/repl';

import { createKodaXRuntime } from '../tests/runtime-fixture.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-create-request-'));
  tempDirs.push(homeDir);
  return homeDir;
}

describe('creating a Session under a requestId', () => {
  it('creates one Session however often the request is sent, across a Host restart', async () => {
    const homeDir = await makeHome();
    const request = { requestId: 'create-1', title: 'Report', projectPath: homeDir };

    const first = await createKodaXRuntime({ homeDir });
    const created = await first.sessions.create(request);
    expect(await first.sessions.create(request)).toMatchObject({ id: created.id, title: 'Report' });
    await first.close();

    const restarted = await createKodaXRuntime({ homeDir });
    try {
      expect(await restarted.sessions.create(request)).toMatchObject({ id: created.id, title: 'Report' });
      expect((await restarted.sessions.list()).map(session => session.id)).toEqual([created.id]);
    } finally {
      await restarted.close();
    }
  });

  it('creates one Session when the same request arrives twice at once', async () => {
    const homeDir = await makeHome();
    const runtime = await createKodaXRuntime({ homeDir });
    try {
      const request = { requestId: 'create-twice', title: 'Once', projectPath: homeDir };
      const [left, right] = await Promise.all([runtime.sessions.create(request), runtime.sessions.create(request)]);
      expect(left.id).toBe(right.id);
      expect(await runtime.sessions.list()).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it('refuses a different request under a requestId that already created a Session', async () => {
    const homeDir = await makeHome();
    const runtime = await createKodaXRuntime({ homeDir });
    try {
      await runtime.sessions.create({ requestId: 'create-2', title: 'First', projectPath: homeDir });
      await expect(runtime.sessions.create({ requestId: 'create-2', title: 'Second', projectPath: homeDir }))
        .rejects.toMatchObject({ code: 'conflict' });
      expect(await runtime.sessions.list()).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it('gives different requests different Sessions', async () => {
    const homeDir = await makeHome();
    const runtime = await createKodaXRuntime({ homeDir });
    try {
      const left = await runtime.sessions.create({ requestId: 'create-a', projectPath: homeDir });
      const right = await runtime.sessions.create({ requestId: 'create-b', projectPath: homeDir });
      expect(left.id).not.toBe(right.id);
      expect(left.id).toMatch(/^[a-f0-9]{32}$/);
    } finally {
      await runtime.close();
    }
  });

  it('refuses a requestId together with a caller-chosen Session id', async () => {
    const homeDir = await makeHome();
    const runtime = await createKodaXRuntime({ homeDir });
    try {
      await expect(runtime.sessions.create({ requestId: 'create-3', sessionId: 'mine', projectPath: homeDir }))
        .rejects.toMatchObject({ code: 'invalid_params' });
      await expect(runtime.sessions.create({ requestId: '', projectPath: homeDir }))
        .rejects.toMatchObject({ code: 'invalid_params' });
    } finally {
      await runtime.close();
    }
  });

  it('still recognises the request after later writes replace the Session runtime facts', async () => {
    const homeDir = await makeHome();
    const request = { requestId: 'create-4', title: 'Kept', projectPath: homeDir };
    const first = await createKodaXRuntime({ homeDir });
    const created = await first.sessions.create(request);
    await first.close();

    // What an execution snapshot does: it writes the runtime facts it knows about.
    const configHome = join(homeDir, '.kodax');
    const storage = new FileSessionStorage({ sessionsDir: join(configHome, 'sessions'), configHome });
    const stored = await storage.load(created.id);
    await storage.save(created.id, {
      ...stored!,
      runtimeInfo: { workspaceRoot: homeDir, executionCwd: homeDir, workspaceKind: 'managed' },
    });

    const restarted = await createKodaXRuntime({ homeDir });
    try {
      expect(await restarted.sessions.create(request)).toMatchObject({ id: created.id, title: 'Kept' });
    } finally {
      await restarted.close();
    }
  });
});
