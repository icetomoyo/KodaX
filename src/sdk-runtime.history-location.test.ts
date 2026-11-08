import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import * as repl from '@kodax-ai/repl';
import { FileSessionStorage } from '@kodax-ai/repl';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';

it('provides both ordinary neighbor cursors when persistent paging falls back to a snapshot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-history-fallback-'));
  const sessionsDir = path.join(root, 'sessions');
  const storage = new FileSessionStorage({ sessionsDir, configHome: root });
  await storage.save('fallback', { title: 'Fallback', gitRoot: root,
    messages: Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `message ${index}` })) });
  const cache = vi.spyOn(FileSessionStorage.prototype, 'readConversationPageCache').mockResolvedValue(null);
  const runtime = await createKodaXRuntime({ homeDir: root, sessionsDir });
  try {
    const newest = await runtime.sessions.readHistory('fallback', { limit: 3 });
    const older = await runtime.sessions.readHistory('fallback', { limit: 3, cursor: newest.nextCursor });
    expect(older.newerCursor).toBeTruthy();
    const returned = await runtime.sessions.readHistory('fallback', { limit: 3, cursor: older.newerCursor });
    expect(returned.items.map(item => item.id)).toEqual(newest.items.map(item => item.id));
  } finally {
    await runtime.close(); cache.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('only computes the full page revision when resolving an item from that page', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-history-revision-'));
  const sessionsDir = path.join(root, 'sessions');
  const storage = new FileSessionStorage({ sessionsDir, configHome: root });
  await storage.save('revision', { title: 'Revision', gitRoot: root, messages: [{ role: 'user', content: 'q' }] });
  const runtime = await createKodaXRuntime({ homeDir: root, sessionsDir });
  const revision = vi.spyOn(repl, 'createSessionConversationHistoryRevision');
  try {
    const page = await runtime.sessions.readHistory('revision');
    revision.mockClear();
    expect(await runtime.sessions.resolveHistoryTurn('revision', { kind: 'latest' })).toMatchObject({ status: 'ready' });
    expect(revision).not.toHaveBeenCalled();
    expect(await runtime.sessions.resolveHistoryTurn('revision', {
      kind: 'item', source: 'history', itemId: page.items[0]!.id, revision: page.revision,
    })).toMatchObject({ status: 'ready' });
    expect(revision).toHaveBeenCalledOnce();
    await runtime.sessions.resolveHistoryTurn('revision', {
      kind: 'item', source: 'history', itemId: page.items[0]!.id, revision: page.revision,
    });
    expect(revision, 'repeat clicks reuse the validated conversation revision').toHaveBeenCalledOnce();
    const projection = vi.spyOn(repl, 'conversationHistoryFromCapture');
    try {
      await runtime.sessions.resolveHistoryTurn('revision', { kind: 'latest' });
      await runtime.sessions.resolveHistoryTurn('revision', { kind: 'latest' });
      expect(projection, 'unchanged source should reuse the validated canonical projection').not.toHaveBeenCalled();
      const saved = (await storage.load('revision'))!;
      saved.messages.push({ role: 'user', content: 'new turn' });
      delete saved.lineage;
      await storage.save('revision', saved);
      expect(await runtime.sessions.resolveHistoryTurn('revision', { kind: 'latest' }))
        .toMatchObject({ status: 'ready', excerpt: 'new turn' });
      expect(projection).toHaveBeenCalledOnce();
    } finally { projection.mockRestore(); }
  } finally {
    revision.mockRestore();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('opens a saved context at the exact search hit and continues forward without skipping a message', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-history-location-'));
  const sessionsDir = path.join(root, 'sessions');
  const storage = new FileSessionStorage({sessionsDir, configHome: root});
  const messages = Array.from({length:100}, (_, i) => ({
    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: i === 8 || i === 10 ? 'identical needle' : 'row ' + i,
  }));
  await storage.save('location', { title:'Location', gitRoot:root, messages });
  const runtime = await createKodaXRuntime({homeDir:root, sessionsDir});
  try {
    const newest = await runtime.sessions.readHistory('location', { limit: 3 });
    const older = await runtime.sessions.readHistory('location', { limit: 3, cursor: newest.nextCursor });
    expect(older.newerCursor).toBeTruthy();
    const returned = await runtime.sessions.readHistory('location', { limit: 3, cursor: older.newerCursor });
    expect(returned.items.map(item => item.id)).toEqual(newest.items.map(item => item.id));
    const search = await runtime.sessions.searchHistory('location', { query:'identical needle' });
    expect(search.hits).toHaveLength(2);
    for (const hit of search.hits) {
      const page = await runtime.sessions.readHistory('location', {limit:3, around:{searchItemId:hit.itemId}});
      expect(page?.locatedBoundaryId).toBeTruthy();
      const focus = page!.items.findIndex(item => item.historyBoundary?.entryId === page!.locatedBoundaryId);
      expect(page!.items[focus]?.text).toBe('identical needle');
      expect(page!.items[focus - 1]?.text).toBe('row ' + (hit.entryIndex - 1));
      expect(page!.items[focus + 1]?.text).toBe(messages[hit.entryIndex + 1]!.content);
      expect(page!.newerCursor).toBeTruthy();
      const next = await runtime.sessions.readHistory('location', {limit:3, cursor:page!.newerCursor});
      expect(next!.items[0]?.text).toBe(messages[hit.entryIndex + 2]!.content);
      const back = await runtime.sessions.readHistory('location', { limit: 3, cursor: next!.nextCursor });
      expect(back.items.map(item => item.id)).toEqual(page!.items.map(item => item.id));
    }
    const first = await runtime.sessions.readHistory('location', { limit: 3, around: { searchItemId: search.hits[0]!.itemId } });
    const largeMessages = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: index === 8 ? 'bounded target needle' : index >= 9 && index <= 13
        ? `large-${index} ` + 'x'.repeat(110 * 1024) : `small-${index}`,
    }));
    await storage.save('large-window', { title: 'Byte window', gitRoot: root, messages: largeMessages });
    const largeSearch = await runtime.sessions.searchHistory('large-window', { query: 'bounded target needle' });
    const bounded = await runtime.sessions.readHistory('large-window', { limit: 10, around: { searchItemId: largeSearch.hits[0]!.itemId } });
    expect(bounded.items.at(-1)?.text).toBe('bounded target needle');
    expect(bounded.locatedBoundaryId).toBe(bounded.items.at(-1)?.historyBoundary?.entryId);
    const boundedNext = await runtime.sessions.readHistory('large-window', { limit: 10, cursor: bounded.newerCursor });
    expect(boundedNext.items[0]?.text.startsWith('large-9 ')).toBe(true);
    await storage.save('other', { title: 'Other', gitRoot: root, messages });
    await expect(runtime.sessions.readHistory('other', { limit: 3, around: { searchItemId: search.hits[0]!.itemId } }))
      .rejects.toMatchObject({ code: 'resync_required' });
    await expect(runtime.sessions.readHistory('other', { limit: 3, cursor: first!.newerCursor }))
      .rejects.toMatchObject({ code: 'resync_required' });
    await expect(runtime.sessions.readHistory('location', { limit: 3, cursor: 'newer.invalid' }))
      .rejects.toMatchObject({ code: 'resync_required' });
    await storage.mutateUiHistory('location', () => [{ type: 'info', text: 'changed snapshot' }]);
    await expect(runtime.sessions.readHistory('location', { limit: 3, cursor: first!.newerCursor }))
      .rejects.toMatchObject({ code: 'resync_required' });
    await expect(runtime.sessions.readHistory('location', { limit: 3, around: { searchItemId: search.hits[0]!.itemId } }))
      .rejects.toMatchObject({ code: 'resync_required' });
  } finally {
    await runtime.close();
    await rm(root,{recursive:true,force:true});
  }
}, 30_000);
