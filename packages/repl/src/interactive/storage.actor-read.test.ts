import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentActorSnapshot } from '@kodax-ai/agent';
import { FileSessionStorage } from './storage.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

it.each(['main', 'islands', 'archive', 'writer', 'topology'] as const)(
  'rejects %s changes during the Actor metadata read', async change => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-actor-boundary-'));
    roots.push(root);
    const sessionsDir = path.join(root, 'sessions');
    const storage = new FileSessionStorage({ sessionsDir });
    await storage.save('guard', { gitRoot: root, messages: [] });
    const open = fs.open.bind(fs);
    let changed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode);
      if (!changed && String(file).endsWith('guard.jsonl')) {
        changed = true;
        if (change === 'main') await fs.appendFile(file, '\n');
        else if (change === 'islands' || change === 'archive') {
          await fs.writeFile(path.join(path.dirname(String(file)), `guard.${change}.jsonl`), '{}\n');
        } else if (change === 'writer') {
          const key = createHash('sha256').update('guard').digest('hex');
          await fs.mkdir(path.join(sessionsDir, '.write-locks'), { recursive: true });
          await fs.writeFile(path.join(sessionsDir, '.write-locks', `${key}.lock`), 'writer');
        } else await fs.writeFile(path.join(sessionsDir, '.location-topology'), 'changed\n');
      }
      return handle;
    });
    await expect(storage.readActorMetadata('guard')).rejects.toMatchObject({ code: 'data_changed' });
    expect(changed).toBe(true);
  },
);

it('reads an isolated Actor projection across a large header without loading the transcript', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-actor-projection-'));
  roots.push(root);
  const storage = new FileSessionStorage({ sessionsDir: path.join(root, 'sessions') });
  const snapshot: AgentActorSnapshot = {
    schemaVersion: 1, revision: 3, maxConcurrentThreads: 4,
    actors: [], turns: [], mailboxes: {}, events: [],
  };
  await storage.save('projection', {
    title: 'large metadata', gitRoot: root,
    messages: [{ role: 'user', content: 'x'.repeat(2_000_000) }],
    actorSnapshot: snapshot,
    uiHistory: [{ type: 'assistant', text: '界'.repeat(100_000) }],
  });
  const fullRead = vi.spyOn(fs, 'readFile');
  const result = await storage.readActorSnapshot('projection');
  expect(result).toEqual(snapshot);
  expect(fullRead.mock.calls.some(([file]) => String(file).endsWith('projection.jsonl'))).toBe(false);
  if (!result) throw new Error('Expected an Actor snapshot');
  (result as { revision: number }).revision = 99;
  expect(await storage.readActorSnapshot('projection')).toEqual(snapshot);
});

it.each([
  ['{broken', 'data_corrupt'],
  [JSON.stringify({ _type: 'meta', lineageVersion: 99 }), 'version_incompatible'],
  [JSON.stringify({ _type: 'meta', actorSnapshot: { schemaVersion: 3 } }), 'version_incompatible'],
  [JSON.stringify({ _type: 'meta', actorSnapshot: { schemaVersion: 2, actors: [{}] } }), 'data_corrupt'],
  [JSON.stringify({ _type: 'meta', actorSnapshot: { schemaVersion: 2, actors: [], owner: 'unknown' } }), 'data_corrupt'],
])('rejects untrusted Actor metadata instead of returning idle: %s', async (header, code) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-actor-projection-'));
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  await fs.mkdir(sessionsDir);
  await fs.writeFile(path.join(sessionsDir, 'invalid.jsonl'), `${header}\n`);
  await expect(new FileSessionStorage({ sessionsDir }).readActorSnapshot('invalid'))
    .rejects.toMatchObject({ code });
});

it.each(['writer', 'flat-write', 'topology'] as const)('distinguishes content writer churn from inventory topology changes: %s', async change => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-actor-inventory-'));
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  const storage = new FileSessionStorage({ sessionsDir });
  await storage.save('inventory', { gitRoot: root, messages: [{ role: 'user', content: 'fixture' }] });
  await fs.mkdir(path.join(sessionsDir, '.write-locks'), { recursive: true });
  const readdir = fs.readdir.bind(fs);
  let changed = false;
  vi.spyOn(fs, 'readdir').mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
    const entries = await readdir(...args);
    if (!changed && String(args[0]) === sessionsDir) {
      changed = true;
      if (change === 'writer') await fs.mkdir(path.join(sessionsDir, '.write-locks', 'fixture.lock.queue'));
      else if (change === 'flat-write') {
        const temporary = path.join(sessionsDir, '.inventory.tmp');
        await fs.writeFile(temporary, 'ordinary content rewrite');
        await fs.unlink(temporary);
      } else await fs.writeFile(path.join(sessionsDir, '.location-topology'), 'changed\n');
    }
    return entries;
  }) as typeof fs.readdir);
  if (change !== 'topology') await expect(storage.listActiveSessionIds()).resolves.toContain('inventory');
  else await expect(storage.listActiveSessionIds()).rejects.toMatchObject({ code: 'data_changed' });
  expect(changed).toBe(true);
});

it('excludes archived legacy flat Sessions from the active inventory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-actor-inventory-'));
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  await fs.mkdir(path.join(sessionsDir, 'archived'), { recursive: true });
  await fs.writeFile(path.join(sessionsDir, 'archived', 'old.jsonl'), '{broken archived record\n');
  await expect(new FileSessionStorage({ sessionsDir }).listActiveSessionIds()).resolves.toEqual([]);
});

it.each(['.migration-lock', '.migration-journal.jsonl'])('rejects an incomplete inventory during migration: %s', async marker => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-actor-inventory-'));
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  await fs.mkdir(sessionsDir);
  await fs.writeFile(path.join(sessionsDir, marker), 'migration in progress');
  await expect(new FileSessionStorage({ sessionsDir }).listActiveSessionIds()).rejects.toMatchObject({ code: 'data_changed' });
});
