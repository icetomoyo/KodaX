import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionLineage, type KodaXSessionUiHistoryItem } from '@kodax-ai/agent';
import { FileSessionStorage } from './storage.js';
import { deriveProjectKeyFromRoot } from './project-key.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function setup(id: string): Promise<{ storage: FileSessionStorage; sessionsDir: string; mainPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-ui-history-append-'));
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  const storage = new FileSessionStorage({ sessionsDir });
  const messages = [{ role: 'user' as const, content: 'hello' }];
  await storage.save(id, { gitRoot: root, title: 'Display', messages, lineage: createSessionLineage(messages) });
  const mainPath = path.join(sessionsDir, deriveProjectKeyFromRoot(root).key, `${id}.jsonl`);
  return { storage, sessionsDir, mainPath };
}

const text = (id: string, value: string, extra: Partial<KodaXSessionUiHistoryItem> = {}): KodaXSessionUiHistoryItem =>
  ({ id, type: 'assistant', text: value, ...extra }) as KodaXSessionUiHistoryItem;

async function lastRecord(mainPath: string): Promise<Record<string, unknown>> {
  const lines = (await fs.readFile(mainPath, 'utf8')).trim().split('\n');
  return JSON.parse(lines.at(-1)!) as Record<string, unknown>;
}

it('appends mid-Run display history without rewriting the Session file', async () => {
  const { storage, sessionsDir, mainPath } = await setup('append');
  const first = [text('a', 'one'), text('b', 'two', { outputId: 'output_1' })];
  await storage.mutateUiHistory('append', () => first, { append: true });
  const before = await fs.readFile(mainPath, 'utf8');
  const rename = vi.spyOn(fs, 'rename');

  const second = [first[0]!, text('b', 'two and more', { outputId: 'output_1' }), text('c', 'three')];
  await storage.mutateUiHistory('append', () => second, { append: true });

  expect(rename.mock.calls.some(([, target]) => path.resolve(String(target)) === path.resolve(mainPath))).toBe(false);
  const after = await fs.readFile(mainPath, 'utf8');
  expect(after.startsWith(before)).toBe(true);
  expect(await lastRecord(mainPath)).toMatchObject({
    _type: 'meta_update', title: 'Display', activeMessageCount: 1,
    uiHistorySkip: 0, uiHistoryKeep: 1, uiHistoryTail: second.slice(1),
  });
  const reader = new FileSessionStorage({ sessionsDir });
  expect((await reader.load('append'))?.uiHistory).toEqual(second);
});

it('records a history that dropped its oldest items as a short delta', async () => {
  const { storage, sessionsDir, mainPath } = await setup('capped');
  const first = [text('a', 'one'), text('b', 'two'), text('c', 'three')];
  await storage.mutateUiHistory('capped', () => first, { append: true });
  const next = [first[1]!, first[2]!, text('d', 'four')];
  await storage.mutateUiHistory('capped', () => next, { append: true });

  expect(await lastRecord(mainPath)).toMatchObject({ uiHistorySkip: 1, uiHistoryKeep: 2, uiHistoryTail: [next[2]] });
  expect((await new FileSessionStorage({ sessionsDir }).load('capped'))?.uiHistory).toEqual(next);
});

it('rewrites the file when the caller does not ask to append', async () => {
  const { storage, sessionsDir, mainPath } = await setup('rewrite');
  await storage.mutateUiHistory('rewrite', () => [text('a', 'one')], { append: true });
  await storage.mutateUiHistory('rewrite', () => [text('a', 'one'), text('b', 'two')], { append: true });
  await storage.mutateUiHistory('rewrite', () => [text('a', 'one'), text('b', 'two'), text('c', 'three')]);

  expect(await fs.readFile(mainPath, 'utf8')).not.toContain('uiHistoryTail');
  expect((await new FileSessionStorage({ sessionsDir }).load('rewrite'))?.uiHistory?.map(item => item.id))
    .toEqual(['a', 'b', 'c']);
});

it('rewrites instead of appending after another writer changed the file', async () => {
  const { storage, sessionsDir, mainPath } = await setup('foreign');
  await storage.mutateUiHistory('foreign', () => [text('a', 'one')], { append: true });
  await new FileSessionStorage({ sessionsDir }).mutateUiHistory('foreign', () => [text('x', 'other process')]);

  await storage.mutateUiHistory('foreign', history => [...history, text('b', 'two')], { append: true });

  expect(await fs.readFile(mainPath, 'utf8')).not.toContain('uiHistoryTail');
  expect((await new FileSessionStorage({ sessionsDir }).load('foreign'))?.uiHistory?.map(item => item.id))
    .toEqual(['x', 'b']);
});

it('keeps a prepared append baseline valid across a display-history append', async () => {
  const { storage, sessionsDir } = await setup('prepared');
  await storage.mutateUiHistory('prepared', () => [text('a', 'one')], { append: true });
  const loaded = await storage.load('prepared');
  const baseline = await storage.prepareSessionAppend('prepared');
  if (baseline === null) throw new Error('expected a prepared append boundary');

  await storage.mutateUiHistory('prepared', () => [text('a', 'one'), text('b', 'two')], { append: true });
  const next = createSessionLineage([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'reply' },
  ], loaded!.lineage);
  await expect(storage.appendPreparedSessionTail('prepared', {
    baseline, title: 'Display', activeEntryId: next.activeEntryId,
    lineageEntries: next.entries.slice(baseline.lineageCount),
  })).resolves.not.toBeNull();

  const reread = await new FileSessionStorage({ sessionsDir }).load('prepared');
  expect(reread?.messages.map(message => message.content)).toEqual(['hello', 'reply']);
  expect(reread?.uiHistory?.map(item => item.id)).toEqual(['a', 'b']);
});

it('folds pending deltas into the next full save', async () => {
  const { storage, sessionsDir, mainPath } = await setup('fold');
  await storage.mutateUiHistory('fold', () => [text('a', 'one')], { append: true });
  await storage.mutateUiHistory('fold', () => [text('a', 'one'), text('b', 'two')], { append: true });
  const loaded = await storage.load('fold');
  await storage.save('fold', { ...loaded!, uiHistory: undefined });

  expect(await fs.readFile(mainPath, 'utf8')).not.toContain('uiHistoryTail');
  expect((await new FileSessionStorage({ sessionsDir }).load('fold'))?.uiHistory?.map(item => item.id))
    .toEqual(['a', 'b']);
});

it('rewrites once the appended display history grows past its limit', async () => {
  const { storage, mainPath } = await setup('limit');
  const long = 'x'.repeat(600 * 1024);
  await storage.mutateUiHistory('limit', () => [text('a', long)], { append: true });
  expect(await fs.readFile(mainPath, 'utf8')).toContain('uiHistoryTail');

  await storage.mutateUiHistory('limit', () => [text('a', long), text('b', long)], { append: true });

  expect(await fs.readFile(mainPath, 'utf8')).not.toContain('uiHistoryTail');
  expect((await storage.load('limit'))?.uiHistory?.map(item => item.id)).toEqual(['a', 'b']);
});
