import { createHmac } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { convertLegacyMemdir } from './converter.js';
import { createNoteStore, type NoteStore } from './store.js';

let legacy: string;
let target: string;
let store: NoteStore;

beforeEach(async () => {
  legacy = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-memdir-'));
  target = await fs.mkdtemp(path.join(os.tmpdir(), 'new-store-'));
  store = createNoteStore(target, 'project');
});
afterEach(async () => {
  await fs.rm(legacy, { recursive: true, force: true });
  await fs.rm(target, { recursive: true, force: true });
});

const legacyFile = (name: string, content: string): Promise<void> =>
  fs.writeFile(path.join(legacy, name), content);

/** Same keyed-hash scheme the legacy lifecycle store uses for tombstones. */
async function tombstone(filename: string, lifecycle: 'archived' | 'forgotten'): Promise<void> {
  const key = Buffer.from('k'.repeat(32));
  const id = createHmac('sha256', key).update(`memdir:${filename}`).digest('hex');
  await fs.mkdir(path.join(legacy, '.governance'), { recursive: true });
  await fs.writeFile(path.join(legacy, '.governance', 'tombstone.key'), key);
  await fs.writeFile(
    path.join(legacy, '.governance', 'lifecycle.json'),
    JSON.stringify({ version: 1, entries: { [id]: { lifecycle, updatedAt: '2026-10-01T00:00:00.000Z' } } }),
  );
}

describe('convertLegacyMemdir', () => {
  it('converts a legacy file keeping description, type and body', async () => {
    await legacyFile(
      'feedback_tests.md',
      '---\nname: Test command\ndescription: Run make check-fast\ntype: feedback\n---\n\nNever bare npm test.\n',
    );
    const report = await convertLegacyMemdir(legacy, store);
    expect(report.converted).toEqual(['feedback_tests']);
    expect((await store.list())[0]).toMatchObject({
      id: 'feedback_tests',
      type: 'feedback',
      description: 'Run make check-fast',
      status: 'active',
      body: 'Never bare npm test.\n',
    });
  });

  it('converts a Chinese legacy file', async () => {
    await legacyFile('测试命令.md', '---\ndescription: 运行测试一律使用 just test-fast\ntype: feedback\n---\n正文\n');
    await convertLegacyMemdir(legacy, store);
    expect(await fs.readFile(path.join(target, 'MEMORY.md'), 'utf8')).toContain('运行测试一律使用 just test-fast');
  });

  it('converts a file without frontmatter using its first line', async () => {
    await legacyFile('plain.md', 'Use pnpm in this repo.\n');
    await convertLegacyMemdir(legacy, store);
    expect((await store.list())[0]?.description).toBe('Use pnpm in this repo.');
  });

  it('ignores the old index, non-markdown files and hidden directories', async () => {
    await legacyFile('MEMORY.md', '- [x](x.md) - old index\n');
    await legacyFile('notes.txt', 'x');
    await fs.mkdir(path.join(legacy, '.governance'));
    await legacyFile('real.md', '---\ndescription: real\n---\n');
    expect((await convertLegacyMemdir(legacy, store)).converted).toEqual(['real']);
  });

  it('carries an archived tombstone over as archived and does not list it', async () => {
    await legacyFile('old.md', '---\ndescription: old rule\n---\n');
    await tombstone('old.md', 'archived');
    await convertLegacyMemdir(legacy, store);
    expect((await store.list())[0]?.status).toBe('archived');
    await expect(fs.stat(path.join(target, 'MEMORY.md'))).rejects.toThrow();
  });

  it('skips a note that was forgotten but is still on disk', async () => {
    await legacyFile('gone.md', '---\ndescription: forgotten rule\n---\n');
    await tombstone('gone.md', 'forgotten');
    const report = await convertLegacyMemdir(legacy, store);
    expect(report.converted).toEqual([]);
    expect(report.skipped).toEqual([{ id: 'gone', reason: 'forgotten' }]);
  });

  it('skips a file holding a secret without echoing it', async () => {
    await legacyFile('leak.md', '---\ndescription: deploy\n---\nkey sk-live-9f8e7d6c5b4a39281716aabbccdd\n');
    const report = await convertLegacyMemdir(legacy, store);
    expect(report.skipped).toEqual([{ id: 'leak', reason: 'secret' }]);
    expect(JSON.stringify(report)).not.toContain('9f8e7d6c');
    expect(await store.list()).toEqual([]);
  });

  it('turns an unsafe file name into a safe id', async () => {
    await legacyFile('my notes v2.md', '---\ndescription: spaced name\n---\n');
    expect((await convertLegacyMemdir(legacy, store)).converted).toEqual(['my-notes-v2']);
  });

  it('is idempotent and never overwrites an existing note', async () => {
    await legacyFile('a.md', '---\ndescription: first\n---\n');
    await convertLegacyMemdir(legacy, store);
    await store.edit('a', { description: 'edited after conversion' });
    const second = await convertLegacyMemdir(legacy, store);
    expect(second.converted).toEqual([]);
    expect(second.skipped).toEqual([{ id: 'a', reason: 'exists' }]);
    expect((await store.list())[0]?.description).toBe('edited after conversion');
  });

  it('leaves the legacy directory untouched', async () => {
    await legacyFile('a.md', '---\ndescription: first\n---\n');
    await legacyFile('MEMORY.md', '- [a](a.md) - first\n');
    await convertLegacyMemdir(legacy, store);
    expect((await fs.readdir(legacy)).sort()).toEqual(['MEMORY.md', 'a.md']);
    expect(await fs.readFile(path.join(legacy, 'MEMORY.md'), 'utf8')).toBe('- [a](a.md) - first\n');
  });

  it('returns an empty report for a missing legacy directory', async () => {
    expect(await convertLegacyMemdir(path.join(legacy, 'nope'), store)).toEqual({ converted: [], skipped: [] });
  });
});
