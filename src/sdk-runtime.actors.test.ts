import fsPromises, {
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSessionStorage, SessionReadError } from '@kodax-ai/repl';

import { createKodaXRuntime } from './sdk-runtime.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-runtime-actors-'));
  tempDirs.push(homeDir);
  return homeDir;
}

async function findSessionFile(homeDir: string, sessionId: string): Promise<string> {
  const sessionsDir = join(homeDir, '.kodax', 'sessions');
  const entries = await readdir(sessionsDir, { recursive: true });
  const relativePath = entries.find((entry) =>
    entry.endsWith(`${sessionId}.jsonl`)
    && !entry.endsWith(`${sessionId}.islands.jsonl`)
    && !entry.endsWith(`${sessionId}.archive.jsonl`)
  );
  if (!relativePath) throw new Error(`Session file not found: ${sessionId}`);
  return join(sessionsDir, relativePath);
}

describe('F270 Runtime Actor facade', () => {
  it('isolates Actor trees by session and restores reusable identities after restart', async () => {
    const homeDir = await makeHome();
    const first = await createKodaXRuntime({ homeDir });
    const alpha = await first.sessions.create({ sessionId: 'alpha', title: 'Alpha' });
    const beta = await first.sessions.create({ sessionId: 'beta', title: 'Beta' });

    expect((await first.agents.tree(alpha.id)).actors.map((actor) => actor.path)).toEqual(['/root']);
    expect((await first.agents.tree(beta.id)).actors.map((actor) => actor.path)).toEqual(['/root']);

    const turn = await first.agents.spawn(alpha.id, {
      taskName: 'worker',
      objective: 'Exercise durable Actor state without an attached run.',
    });
    await expect(first.agents.wait(alpha.id, 2, 1_000)).resolves.toMatchObject({
      kind: 'turn_failed', actorPath: '/root/worker', turnId: turn.turnId,
    });
    expect(await first.agents.output(alpha.id, '/root/worker', turn.turnId)).toMatchObject({
      state: 'failed',
    });
    expect((await first.agents.tree(beta.id)).actors.map((actor) => actor.path)).toEqual(['/root']);
    await first.close();

    const restarted = await createKodaXRuntime({ homeDir });
    await restarted.sessions.load(alpha.id);
    expect(await restarted.agents.detail(alpha.id, '/root/worker')).toMatchObject({
      actor: { path: '/root/worker', state: 'idle' },
      turns: [{ turnId: turn.turnId, state: 'failed' }],
    });

    const followup = await restarted.agents.followup(alpha.id, '/root/worker', 'Resume safely.');
    await expect(restarted.agents.wait(alpha.id, 4, 1_000)).resolves.toMatchObject({
      kind: 'turn_failed', actorPath: '/root/worker', turnId: followup.turn.turnId,
    });
    expect((await restarted.agents.tree(alpha.id)).actors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/root', state: 'running' }),
      expect.objectContaining({ path: '/root/worker', state: 'idle' }),
    ]));
    await restarted.close();
  });

  it('starts a fork with a fresh Actor tree instead of inheriting the source lifecycle', async () => {
    const runtime = await createKodaXRuntime({ homeDir: await makeHome() });
    const source = await runtime.sessions.create({ sessionId: 'source', title: 'Source' });
    await runtime.agents.spawn(source.id, { taskName: 'scout', objective: 'Inspect.' });
    await runtime.agents.wait(source.id, 2, 1_000);

    let forked: Awaited<ReturnType<typeof runtime.sessions.fork>>;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        forked = await runtime.sessions.fork({
          sessionId: source.id,
          newSessionId: 'forked',
          title: 'Forked',
        });
        break;
      } catch (error: unknown) {
        if (
          !(error instanceof SessionReadError)
          || error.code !== 'data_changed'
          || attempt === 19
        ) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!forked) throw new Error('Expected session fork to succeed.');

    expect((await runtime.agents.tree(source.id)).actors.map((actor) => actor.path)).toContain('/root/scout');
    expect((await runtime.agents.tree(forked.id)).actors.map((actor) => actor.path)).toEqual(['/root']);
    await runtime.close();
  });

  it('rejects a distinct stale follow-up submitted against an idle Actor revision', async () => {
    const runtime = await createKodaXRuntime({ homeDir: await makeHome() });
    const session = await runtime.sessions.create({ sessionId: 'revision', title: 'Revision' });
    const initial = await runtime.agents.spawn(session.id, {
      taskName: 'worker',
      objective: 'Create a reusable Actor.',
    });
    await runtime.agents.wait(session.id, 2, 1_000);
    const idleRevision = (await runtime.agents.detail(session.id, initial.actorPath)).actor.revision;

    const accepted = await runtime.agents.followup(
      session.id,
      initial.actorPath,
      'Accepted follow-up.',
      { expectedRevision: idleRevision },
    );
    expect(accepted).toMatchObject({ delivery: 'started_turn' });

    const stale = runtime.agents.followup(
      session.id,
      initial.actorPath,
      'Distinct stale follow-up.',
      { expectedRevision: idleRevision },
    );

    await expect(stale).rejects.toMatchObject({
      code: 'revision_conflict',
      expectedRevision: idleRevision,
    });
    await runtime.close();
  });

  it('fences the same Session Actor tree from a second live Runtime owner', async () => {
    const homeDir = await makeHome();
    const first = await createKodaXRuntime({ homeDir });
    const second = await createKodaXRuntime({ homeDir });
    const session = await first.sessions.create({
      sessionId: 'single-owner',
      title: 'Single Actor Owner',
    });

    await expect(first.agents.tree(session.id)).resolves.toMatchObject({
      revision: 1,
      actors: [expect.objectContaining({ path: '/root' })],
    });
    await expect(second.agents.tree(session.id)).rejects.toMatchObject({
      code: 'actor_owner_conflict',
    });

    await first.close();
    await expect(second.agents.tree(session.id)).resolves.toMatchObject({
      actors: [expect.objectContaining({ path: '/root' })],
    });
    await second.close();
  });

  it('keeps a reachable Runtime owner alive when its PID probe is inconclusive', async () => {
    const homeDir = await makeHome();
    const owner = await createKodaXRuntime({ homeDir });
    const contender = await createKodaXRuntime({ homeDir });
    const session = await owner.sessions.create({
      sessionId: 'conservative-owner-probe',
      title: 'Conservative Owner Probe',
    });
    await owner.agents.tree(session.id);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('transient process probe failure'), {
        code: 'EACCES',
      });
    });

    try {
      await expect(contender.agents.tree(session.id)).rejects.toMatchObject({
        code: 'actor_owner_conflict',
      });
    } finally {
      kill.mockRestore();
      await owner.close();
      await contender.close();
    }
  });

  it('reclaims a crashed Runtime owner even when its PID has been reused', async () => {
    const homeDir = await makeHome();
    const owner = await createKodaXRuntime({ homeDir });
    const contender = await createKodaXRuntime({ homeDir });
    const session = await owner.sessions.create({
      sessionId: 'reused-owner-pid',
      title: 'Reused Owner PID',
    });
    await owner.agents.tree(session.id);

    const storage = new FileSessionStorage({
      sessionsDir: join(homeDir, '.kodax', 'sessions'),
    });
    const owned = await storage.peek(session.id);
    const staleOwner = owned?.actorSnapshot?.schemaVersion === 2
      ? owned.actorSnapshot.owner
      : undefined;
    if (!staleOwner) throw new Error('Expected a persisted Runtime Actor owner.');

    await owner.close();
    const released = await storage.peek(session.id);
    const releasedSnapshot = released?.actorSnapshot;
    if (!releasedSnapshot || releasedSnapshot.schemaVersion !== 2) {
      throw new Error('Expected a released schema-v2 Actor snapshot.');
    }
    await storage.saveActorSnapshot(session.id, {
      ...releasedSnapshot,
      revision: releasedSnapshot.revision + 1,
      owner: staleOwner,
    }, releasedSnapshot.revision);

    await expect(contender.agents.tree(session.id)).resolves.toMatchObject({
      actors: [expect.objectContaining({ path: '/root' })],
    });
    await contender.close();
  });

  it('releases an initialized Actor owner before deleting its Session', async () => {
    const runtime = await createKodaXRuntime({ homeDir: await makeHome() });
    const session = await runtime.sessions.create({
      sessionId: 'deleted-owner',
      title: 'Deleted Actor Owner',
    });
    await runtime.agents.tree(session.id);

    await runtime.sessions.delete(session.id);

    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it('does not let another Runtime delete a Session owned by a live Actor controller', async () => {
    const homeDir = await makeHome();
    const owner = await createKodaXRuntime({ homeDir });
    const contender = await createKodaXRuntime({ homeDir });
    const session = await owner.sessions.create({
      sessionId: 'delete-owner-fence',
      title: 'Delete Owner Fence',
    });
    await owner.agents.tree(session.id);

    await expect(contender.sessions.archive(session.id)).rejects.toMatchObject({
      code: 'actor_owner_conflict',
    });
    await expect(contender.sessions.delete(session.id)).rejects.toMatchObject({
      code: 'actor_owner_conflict',
    });
    await expect(owner.sessions.load(session.id)).resolves.toMatchObject({
      id: session.id,
    });

    await owner.close();
    await expect(contender.sessions.delete(session.id)).resolves.toBeUndefined();
    await contender.close();
  });

  it('keeps daemon preflight read-only instead of claiming unowned Session Actors', async () => {
    const homeDir = await makeHome();
    const owner = await createKodaXRuntime({ homeDir });
    const observer = await createKodaXRuntime({ homeDir });
    const session = await owner.sessions.create({
      sessionId: 'preflight-does-not-claim',
      title: 'Preflight Does Not Claim',
    });
    const storage = new FileSessionStorage({
      sessionsDir: join(homeDir, '.kodax', 'sessions'),
    });
    const data = await storage.load(session.id);
    if (!data) throw new Error('Expected preflight Session data.');
    await storage.save(session.id, {
      ...data,
      messages: [
        { role: 'user', content: 'Run an incomplete tool call.' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_preflight', name: 'test', input: {} },
          ],
        },
      ],
      errorMetadata: {
        lastError: 'interrupted',
        lastErrorTime: Date.now(),
        consecutiveErrors: 1,
      },
    });
    const sessionFile = await findSessionFile(homeDir, session.id);
    const bytesBefore = await fsPromises.readFile(sessionFile);
    const mtimeBefore = (await fsPromises.stat(sessionFile)).mtimeMs;

    await expect(observer.status.preflight()).resolves.toMatchObject({
      activeAgentTurns: [],
    });
    expect(await fsPromises.readFile(sessionFile)).toEqual(bytesBefore);
    expect((await fsPromises.stat(sessionFile)).mtimeMs).toBe(mtimeBefore);
    await expect(owner.agents.tree(session.id)).resolves.toMatchObject({
      actors: [expect.objectContaining({ path: '/root' })],
    });

    await owner.close();
    await observer.close();
  });

  it('retains and later releases the Actor owner when strict Session deletion fails', async () => {
    const homeDir = await makeHome();
    const runtime = await createKodaXRuntime({ homeDir });
    const session = await runtime.sessions.create({
      sessionId: 'delete-failure-retains-owner',
      title: 'Delete Failure Retains Owner',
    });
    await runtime.agents.tree(session.id);
    const mainPath = await findSessionFile(homeDir, session.id);
    const sidecarPath = mainPath.replace(/\.jsonl$/, '.islands.jsonl');
    await writeFile(sidecarPath, '{"_type":"archive_meta"}\n', 'utf-8');
    const renameOriginal = fsPromises.rename.bind(fsPromises);
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(
      async (source, target) => {
        if (String(source) === mainPath) {
          throw Object.assign(new Error('delete denied'), { code: 'EACCES' });
        }
        await renameOriginal(source, target);
      },
    );

    try {
      await expect(runtime.sessions.delete(session.id)).rejects.toMatchObject({
        code: 'session_delete_failed',
      });
    } finally {
      rename.mockRestore();
    }

    await expect(runtime.agents.tree(session.id)).resolves.toMatchObject({
      actors: [expect.objectContaining({ path: '/root' })],
    });
    await runtime.close();

    const restarted = await createKodaXRuntime({ homeDir });
    await expect(restarted.agents.tree(session.id)).resolves.toMatchObject({
      actors: [expect.objectContaining({ path: '/root' })],
    });
    await restarted.close();
  });

  it('shares concurrent close work and retries a failed Actor owner release', async () => {
    const homeDir = await makeHome();
    const runtime = await createKodaXRuntime({ homeDir });
    const session = await runtime.sessions.create({
      sessionId: 'close-owner-release-retry',
      title: 'Close Owner Release Retry',
    });
    await runtime.agents.tree(session.id);
    const mainPath = await findSessionFile(homeDir, session.id);
    const renameOriginal = fsPromises.rename.bind(fsPromises);
    let rejectedOwnerRelease = false;
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(
      async (from, to) => {
        if (!rejectedOwnerRelease && String(to) === mainPath) {
          rejectedOwnerRelease = true;
          throw Object.assign(new Error('owner release write failed'), {
            code: 'EIO',
          });
        }
        await renameOriginal(from, to);
      },
    );

    try {
      const first = runtime.close();
      const concurrent = runtime.close();
      expect(concurrent).toBe(first);
      await expect(first).rejects.toMatchObject({ code: 'EIO' });
    } finally {
      rename.mockRestore();
    }

    const contender = await createKodaXRuntime({ homeDir });
    await expect(contender.agents.tree(session.id)).rejects.toMatchObject({
      code: 'actor_owner_conflict',
    });
    await expect(runtime.close()).resolves.toBeUndefined();
    await expect(contender.agents.tree(session.id)).resolves.toMatchObject({
      actors: [expect.objectContaining({ path: '/root' })],
    });
    await contender.close();
  });

  it('releases the Actor owner only after a Session has been archived', async () => {
    const homeDir = await makeHome();
    const owner = await createKodaXRuntime({ homeDir });
    const contender = await createKodaXRuntime({ homeDir });
    const session = await owner.sessions.create({
      sessionId: 'archived-owner-fence',
      title: 'Archived Owner Fence',
    });
    await owner.agents.tree(session.id);
    await owner.sessions.archive(session.id);

    await expect(contender.sessions.unarchive(session.id)).resolves.toBeUndefined();
    await owner.close();
    await contender.close();
  });

  it('keeps archived Sessions read-only until they are unarchived', async () => {
    const runtime = await createKodaXRuntime({ homeDir: await makeHome() });
    const session = await runtime.sessions.create({
      sessionId: 'archived-read-only',
      title: 'Archived Read Only',
    });
    await runtime.sessions.archive(session.id);

    await expect(runtime.agents.tree(session.id)).rejects.toMatchObject({
      code: 'session_archived',
    });
    await expect(runtime.runs.start({
      sessionId: session.id,
      prompt: 'Must not recreate an active copy.',
      options: { provider: 'mock-provider' },
    })).rejects.toMatchObject({
      code: 'session_archived',
    });
    for (const mutate of [
      () => runtime.sessions.updateSettings(
        session.id,
        { permissionMode: 'auto-in-project' },
      ),
      () => runtime.sessions.appendNotice({
        sessionId: session.id,
        content: 'Must not recreate an active copy.',
      }),
      () => runtime.sessions.rewind({ sessionId: session.id }),
      () => runtime.sessions.setActiveEntry({
        sessionId: session.id,
        entryId: 'missing-entry',
      }),
      () => runtime.sessions.compact({ sessionId: session.id }),
    ]) {
      await expect(mutate()).rejects.toMatchObject({
        code: 'session_archived',
      });
    }
    const archivedCopies = (await runtime.sessions.list({
      includeArchived: true,
    })).filter((candidate) => candidate.id === session.id);
    expect(archivedCopies).toEqual([
      expect.objectContaining({ id: session.id, archived: true }),
    ]);

    await runtime.sessions.unarchive(session.id);
    await expect(runtime.agents.tree(session.id)).resolves.toMatchObject({
      actors: [expect.objectContaining({ path: '/root' })],
    });
    await runtime.close();
  });
});
