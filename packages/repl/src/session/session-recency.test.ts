import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionManager } from './public-api.js';
import { listCliResumeSessions } from '../cli-resume.js';
import { applySessionCompaction, createSessionLineage, getSessionMessagesFromLineage } from '@kodax-ai/agent';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

it('carries prepared-tail activity through index rebuilds and metadata-only saves', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-tail-recency-'));
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  const manager = createSessionManager({ sessionsDir, configHome: path.join(root, 'config') });
  const messages = [{ role: 'user' as const, content: 'first', timestamp: '2026-10-01T00:00:00.000Z' }];
  await manager.storage.save('tail', { title: 'tail', gitRoot: root, messages });
  const loaded = await manager.storage.load('tail');
  const baseline = await manager.storage.prepareSessionAppend('tail');
  if (!loaded || !baseline) throw new Error('Expected a prepared tail');
  const lineage = createSessionLineage([...messages, { role: 'assistant', content: 'latest', timestamp: '2026-10-15T00:00:00.000Z' }], loaded.lineage);
  await manager.storage.appendPreparedSessionTail('tail', { baseline, title: 'tail', activeEntryId: lineage.activeEntryId, lineageEntries: lineage.entries.slice(baseline.lineageCount) });
  const files = await fs.readdir(sessionsDir, { withFileTypes: true });
  const project = files.find(entry => entry.isDirectory() && !entry.name.startsWith('.'));
  if (!project) throw new Error('Expected a project bucket');
  await fs.rm(path.join(sessionsDir, project.name, '.resume-index'), { recursive: true, force: true });
  expect((await listCliResumeSessions({ projectRoot: root, sessionsDir }))[0]).toMatchObject({ lastMessageAt: '2026-10-15T00:00:00.000Z', msgCount: 2 });
  expect((await manager.listSessions({ scope: 'all' }))[0]).toMatchObject({ lastMessageAt: '2026-10-15T00:00:00.000Z', msgCount: 2 });
  const current = await manager.storage.peek('tail');
  if (!current) throw new Error('Expected the appended Session');
  await manager.storage.save('tail', { ...current, title: 'renamed' });
  expect((await manager.listSessions())[0]).toMatchObject({ lastMessageAt: '2026-10-15T00:00:00.000Z', title: 'renamed' });
});

it('uses reliable legacy message time without writing, with deterministic ties and creation fallback', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-legacy-recency-'));
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  await fs.mkdir(sessionsDir);
  for (const [id, createdAt, timestamp] of [
    ['old', '2026-10-01T00:00:00.000Z', '2026-10-15T00:00:00.000Z'],
    ['z', '2026-10-14T00:00:00.000Z', undefined],
    ['a', '2026-10-14T00:00:00.000Z', undefined],
  ] as const) {
    await fs.writeFile(path.join(sessionsDir, `${id}.jsonl`), [
      JSON.stringify({ _type: 'meta', title: id, gitRoot: root, createdAt, activeMessageCount: 1 }),
      JSON.stringify({ role: 'user', content: 'legacy', timestamp }),
    ].join('\n') + '\n');
  }
  await fs.writeFile(path.join(sessionsDir, 'copied.jsonl'), [
    JSON.stringify({ _type: 'meta', title: 'copied', gitRoot: root, createdAt: '2026-10-02T00:00:00.000Z', activeMessageCount: 1, activeEntryId: 'copy' }),
    JSON.stringify({ _type: 'lineage_entry', entry: { type: 'message', id: 'copy', parentId: null, sourceEntryId: 'original', timestamp: '2026-10-20T00:00:00.000Z', message: { role: 'user', content: 'old compacted message' } } }),
  ].join('\n') + '\n');
  const before = await fs.readdir(sessionsDir);
  expect((await listCliResumeSessions({ projectRoot: root, sessionsDir })).map(row => row.id)).toEqual(['old', 'z', 'a', 'copied']);
  expect(await fs.readdir(sessionsDir)).toEqual(before);
  const manager = createSessionManager({ sessionsDir });
  const copy = await manager.storage.peek('copied');
  if (!copy) throw new Error('Expected legacy copy');
  await manager.storage.save('copied', { ...copy, title: 'renamed legacy copy' });
  expect((await manager.listSessions()).at(-1)).toMatchObject({ id: 'copied', createdAt: '2026-10-02T00:00:00.000Z' });
  expect((await manager.listSessions()).at(-1)?.lastMessageAt).toBeUndefined();
});

it('preserves activity when compaction rematerializes unstamped messages and a fork copies history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-compaction-recency-'));
  roots.push(root);
  const manager = createSessionManager({ sessionsDir: path.join(root, 'sessions') });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
  await manager.storage.save('source', { title: 'source', gitRoot: root, messages: [{ role: 'user', content: 'retain me' }] });
  const data = await manager.storage.load('source');
  if (!data?.lineage) throw new Error('Expected source lineage');
  vi.setSystemTime(new Date('2026-10-15T00:00:00.000Z'));
  const lineage = applySessionCompaction(data.lineage, [
    { role: 'system', content: '[summary]' }, ...data.messages,
  ], { summary: 'checkpoint' });
  await manager.storage.save('source', { ...data, lineage, messages: getSessionMessagesFromLineage(lineage) });
  expect((await manager.listSessions())[0]).toMatchObject({ lastMessageAt: '2026-10-01T00:00:00.000Z' });
  await manager.storage.fork('source', undefined, { sessionId: 'fork' });
  expect(await manager.listSessions()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'fork', lastMessageAt: '2026-10-01T00:00:00.000Z' }),
  ]));
});

it('orders every list path by genuine conversation activity while preserving creation and metadata-only saves', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-session-recency-'));
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  const manager = createSessionManager({ sessionsDir, configHome: path.join(root, 'config') });
  vi.useFakeTimers({ toFake: ['Date'] });
  const old = { title: 'old', gitRoot: root, messages: [{ role: 'user' as const, content: 'old input', timestamp: '2026-10-01T00:00:00.000Z' }] };
  vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
  await manager.storage.save('old', old);
  vi.setSystemTime(new Date('2026-10-14T00:00:00.000Z'));
  await manager.storage.save('new', { title: 'new', gitRoot: root, messages: [{ role: 'user', content: 'new input', timestamp: '2026-10-14T00:00:00.000Z' }] });
  vi.setSystemTime(new Date('2026-10-15T00:00:00.000Z'));
  await manager.storage.save('old', { ...old, messages: [...old.messages, { role: 'assistant', content: 'recent reply', timestamp: '2026-10-15T00:00:00.000Z' }] });
  vi.setSystemTime(new Date('2026-10-16T00:00:00.000Z'));
  const newer = await manager.storage.peek('new');
  if (!newer) throw new Error('Expected fixture Session');
  await manager.storage.save('new', { ...newer, title: 'renamed', messages: [...newer.messages, { role: 'user', content: 'system wake', _synthetic: true, timestamp: '2026-10-16T00:00:00.000Z' }] });
  const lists = [
    await listCliResumeSessions({ projectRoot: root, sessionsDir }),
    await manager.storage.list(root, { limit: 10 }),
    await manager.listSessions({ projectRoot: root }),
    await manager.listSessions({ projectRoot: root, scope: 'all' }),
  ];
  for (const rows of lists) {
    expect(rows.map(row => row.id)).toEqual(['old', 'new']);
    expect(rows[0]).toMatchObject({ createdAt: '2026-10-01T00:00:00.000Z', lastMessageAt: '2026-10-15T00:00:00.000Z' });
    expect(rows[1]).toMatchObject({ lastMessageAt: '2026-10-14T00:00:00.000Z' });
  }
  const firstPage = await manager.listSessions({ projectRoot: root, limit: 1 });
  expect((await manager.listSessions({ projectRoot: root, limit: 1, cursor: firstPage[0]!.cursor })).map(row => row.id)).toEqual(['new']);
  expect((await manager.listSessions({ projectRoot: root, before: '2026-10-10T00:00:00.000Z' })).map(row => row.id)).toEqual(['old']);
  await manager.deleteSession('old');
  expect((await manager.listSessions({ projectRoot: root, limit: 1, cursor: firstPage[0]!.cursor })).map(row => row.id)).toEqual(['new']);
});
