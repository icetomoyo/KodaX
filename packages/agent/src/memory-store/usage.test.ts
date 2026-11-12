import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { KodaXMessage } from '@kodax-ai/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildIndex } from './index-builder.js';
import { createNoteStore } from './store.js';
import { noteReadsFrom, recordNoteReads } from './usage.js';

const call = (id: string, name: string, input: Record<string, unknown>): KodaXMessage => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name, input }],
});
const result = (id: string, isError = false): KodaXMessage => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...(isError ? { is_error: true } : {}) }],
});

describe('note usage signals', () => {
  let dir: string;
  const roots = (): { project: string; user: string } => ({ project: path.join(dir, 'project'), user: path.join(dir, 'user') });

  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'f306-usage-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('counts a successful read of a note file, once per read', () => {
    const file = path.join(roots().project, 'tests.md');
    const reads = noteReadsFrom([
      call('1', 'read', { path: file }), result('1'),
      call('2', 'read', { file_path: file }), result('2'),
      call('3', 'read', { path: path.join(roots().user, 'style.md') }), result('3'),
    ], roots());
    expect(reads).toEqual({ project: { tests: 2 }, user: { style: 1 } });
  });

  it('ignores the index, nested files, other tools, failed reads and reads outside the roots', () => {
    const project = roots().project;
    const reads = noteReadsFrom([
      call('1', 'read', { path: path.join(project, 'MEMORY.md') }), result('1'),
      call('2', 'read', { path: path.join(project, 'sub', 'deep.md') }), result('2'),
      call('3', 'bash', { path: path.join(project, 'tests.md') }), result('3'),
      call('4', 'read', { path: path.join(project, 'tests.md') }), result('4', true),
      call('5', 'read', { path: path.join(dir, 'elsewhere', 'tests.md') }), result('5'),
      call('6', 'read', { path: path.join(project, '..', 'project-other', 'tests.md') }), result('6'),
    ], roots());
    expect(reads).toEqual({ project: {}, user: {} });
  });

  it('adds reads to the counters without keeping a revision and without changing the note', async () => {
    const stores = { project: createNoteStore(roots().project, 'project'), user: createNoteStore(roots().user, 'user') };
    await stores.project.write({ id: 'tests', type: 'feedback', description: 'Run make check-fast', body: 'Bare npm test skips setup.' });
    const at = new Date('2026-11-12T10:00:00Z');
    const updated = await recordNoteReads({
      stores,
      messages: [call('1', 'read', { path: path.join(roots().project, 'tests.md') }), result('1'), call('2', 'read', { path: path.join(roots().project, 'gone.md') }), result('2')],
      now: () => at,
    });
    expect(updated).toBe(1);
    const [note] = await stores.project.list();
    expect(note).toMatchObject({ id: 'tests', used: 1, lastUsedAt: at.toISOString(), description: 'Run make check-fast', body: 'Bare npm test skips setup.' });
    await expect(fs.readdir(path.join(roots().project, '.revisions'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the index bytes unchanged while the store is far under its budget', async () => {
    const store = createNoteStore(roots().project, 'project');
    await store.write({ id: 'a', type: 'feedback', description: 'First', body: 'x' });
    await store.write({ id: 'b', type: 'feedback', description: 'Second', body: 'x' });
    const before = await fs.readFile(path.join(roots().project, 'MEMORY.md'), 'utf8');
    await store.recordUse({ b: 3 }, new Date());
    expect(await fs.readFile(path.join(roots().project, 'MEMORY.md'), 'utf8')).toBe(before);
    expect(buildIndex(await store.list())).toBe(before);
  });
});
