import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNoteStore, type NoteStore } from './store.js';

let dir: string;
let store: NoteStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-store-'));
  store = createNoteStore(dir, 'project');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const base = { type: 'feedback' as const, description: 'Run tests with make check-fast', body: 'details\n' };
const read = (name: string): Promise<string> => fs.readFile(path.join(dir, name), 'utf8');

describe('note store', () => {
  it('writes a note file and rebuilds the index', async () => {
    const result = await store.write({ id: 'tests', ...base });
    expect(result.ok).toBe(true);
    expect(await read('tests.md')).toContain('make check-fast');
    expect(await read('MEMORY.md')).toContain('(tests.md)');
  });

  it('stamps the store scope whatever the caller says', async () => {
    const result = await store.write({ id: 'a', ...base, scope: 'user' } as never);
    expect(result.ok && result.note.scope).toBe('project');
  });

  it('defaults to active and starts unused', async () => {
    const result = await store.write({ id: 'a', ...base });
    expect(result.ok && result.note).toMatchObject({ status: 'active', used: 0 });
  });

  it('refuses to overwrite an existing id', async () => {
    await store.write({ id: 'a', ...base });
    expect(await store.write({ id: 'a', ...base })).toMatchObject({ ok: false, reason: 'exists' });
  });

  it.each(['../evil', 'a/b', 'a\\b', '.hidden', 'MEMORY', '', 'x'.repeat(100), 'a.md'])(
    'rejects unsafe id %j',
    async (id) => {
      expect(await store.write({ id, ...base })).toMatchObject({ ok: false, reason: 'invalid-id' });
    },
  );

  it('accepts a Chinese id', async () => {
    expect((await store.write({ id: '测试命令', ...base })).ok).toBe(true);
  });

  it('rejects a secret in any field and writes nothing', async () => {
    const secret = 'sk-live-9f8e7d6c5b4a39281716aabbccdd';
    for (const over of [{ description: `key ${secret}` }, { body: secret }, { why: secret }, { check: secret }]) {
      const result = await store.write({ id: 'a', ...base, ...over });
      expect(result).toMatchObject({ ok: false, reason: 'secret' });
      expect(JSON.stringify(result)).not.toContain('9f8e7d6c');
    }
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('rejects a secret used as the id, because the id becomes a file name and an index line', async () => {
    const result = await store.write({ id: 'sk-live-9f8e7d6c5b4a39281716aabbccdd', ...base });
    expect(result).toMatchObject({ ok: false, reason: 'secret' });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('rejects an empty description', async () => {
    expect(await store.write({ id: 'a', ...base, description: '  ' }))
      .toMatchObject({ ok: false, reason: 'empty-description' });
  });

  it('edits fields in place and keeps the rest', async () => {
    await store.write({ id: 'a', ...base, why: 'user said so' });
    const result = await store.edit('a', { description: 'Run tests with just test-fast' });
    expect(result.ok && result.note).toMatchObject({ why: 'user said so', description: 'Run tests with just test-fast' });
    expect(await read('MEMORY.md')).toContain('just test-fast');
  });

  it('rejects an edit that introduces a secret and leaves the file unchanged', async () => {
    await store.write({ id: 'a', ...base });
    const before = await read('a.md');
    const result = await store.edit('a', { body: 'AKIAIOSFODNN7EXAMPLE' });
    expect(result).toMatchObject({ ok: false, reason: 'secret' });
    expect(await read('a.md')).toBe(before);
  });

  it('reports a missing note on edit and remove', async () => {
    expect(await store.edit('nope', { description: 'x' })).toMatchObject({ ok: false, reason: 'not-found' });
    expect(await store.remove('nope')).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('removes a note and drops it from the index', async () => {
    await store.write({ id: 'a', ...base });
    expect((await store.remove('a')).ok).toBe(true);
    await expect(fs.stat(path.join(dir, 'a.md'))).rejects.toThrow();
    expect(await read('MEMORY.md')).not.toContain('a.md');
  });

  it('keeps a candidate out of the index until it is edited to active', async () => {
    await store.write({ id: 'c', ...base, status: 'candidate' });
    // Nothing listable yet, so no index file is created at all.
    await expect(fs.stat(path.join(dir, 'MEMORY.md'))).rejects.toThrow();
    await store.edit('c', { status: 'active' });
    expect(await read('MEMORY.md')).toContain('(c.md)');
  });

  it('picks up a hand-edited file as active on rebuild', async () => {
    await fs.writeFile(path.join(dir, 'hand.md'), '---\ndescription: use pnpm here\n---\nbody\n');
    expect(await store.rebuildIndex()).toBe(true);
    expect(await read('MEMORY.md')).toContain('use pnpm here');
  });

  it('does not touch MEMORY.md when nothing changed', async () => {
    await store.write({ id: 'a', ...base });
    const before = (await fs.stat(path.join(dir, 'MEMORY.md'))).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await store.rebuildIndex()).toBe(false);
    expect((await fs.stat(path.join(dir, 'MEMORY.md'))).mtimeMs).toBe(before);
  });

  it('lists notes without the index file or non-markdown files', async () => {
    await store.write({ id: 'a', ...base });
    await fs.writeFile(path.join(dir, 'notes.txt'), 'x');
    expect((await store.list()).map((n) => n.id)).toEqual(['a']);
  });

  it('keeps two scopes isolated', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'note-store-user-'));
    try {
      const userStore = createNoteStore(other, 'user');
      await userStore.write({ id: 'a', ...base });
      expect(await store.list()).toEqual([]);
      expect((await userStore.list())[0]?.scope).toBe('user');
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it('leaves no temp files behind', async () => {
    await store.write({ id: 'a', ...base });
    await store.edit('a', { description: 'changed' });
    expect((await fs.readdir(dir)).sort()).toEqual(['.revisions', 'MEMORY.md', 'a.md']); // no *.tmp-* files
  });
});
