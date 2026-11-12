import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { organizeStore, STALE_AFTER_DAYS } from './organizer.js';
import { createNoteStore, type NoteStore } from './store.js';

const DAY = 24 * 60 * 60 * 1000;

describe('organizeStore', () => {
  let dir: string;
  let store: NoteStore;
  const inDays = (days: number): Date => new Date(Date.now() + days * DAY);

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'f306-organize-'));
    store = createNoteStore(dir, 'project');
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const statuses = async (): Promise<Record<string, string>> =>
    Object.fromEntries((await store.list()).map((note) => [note.id, note.status]));

  it('archives an inferred note nobody used for the stale period, and keeps the file', async () => {
    await store.write({ id: 'guess', type: 'project', description: 'The build is slow', body: 'x', status: 'candidate', source: 'inferred' });
    const report = await organizeStore(store, inDays(STALE_AFTER_DAYS + 1));
    expect(report.stale).toEqual(['guess']);
    expect(await statuses()).toEqual({ guess: 'archived' });
    expect((await store.list())[0]!.body).toBe('x');
  });

  it('keeps an inferred note that is still inside the period, or was read recently', async () => {
    await store.write({ id: 'fresh', type: 'project', description: 'Fresh guess', body: 'x', status: 'candidate', source: 'inferred' });
    await store.write({ id: 'read', type: 'project', description: 'Often read', body: 'x', status: 'active', source: 'inferred' });
    await store.recordUse({ read: 2 }, inDays(STALE_AFTER_DAYS - 1));
    const report = await organizeStore(store, inDays(STALE_AFTER_DAYS + 1));
    expect(report.stale).toEqual(['fresh']);
    expect((await statuses()).read).toBe('active');
  });

  it('never archives a note the user stated, however old', async () => {
    await store.write({ id: 'stated', type: 'feedback', description: 'Run make check-fast', body: 'x', source: 'user' });
    await store.write({ id: 'handwritten', type: 'feedback', description: 'Written by hand', body: 'x' });
    const report = await organizeStore(store, inDays(STALE_AFTER_DAYS * 4));
    expect(report).toEqual({ stale: [], duplicates: [] });
  });

  it('archives the weaker of two notes that carry the same description', async () => {
    await store.write({ id: 'inferred-copy', type: 'feedback', description: 'Run tests with `make check-fast`.', body: 'x', source: 'inferred' });
    await store.write({ id: 'stated', type: 'feedback', description: 'run tests with make check-fast', body: 'x', source: 'user' });
    await store.write({ id: 'other', type: 'feedback', description: 'Something else entirely', body: 'x', source: 'user' });
    const report = await organizeStore(store);
    expect(report.duplicates).toEqual(['inferred-copy']);
    expect(await statuses()).toEqual({ 'inferred-copy': 'archived', stated: 'active', other: 'active' });
  });

  it('breaks a tie between equal notes by use, then by id, so the result is repeatable', async () => {
    await store.write({ id: 'b-note', type: 'feedback', description: 'Same line', body: 'x', source: 'user' });
    await store.write({ id: 'a-note', type: 'feedback', description: 'Same line', body: 'x', source: 'user' });
    await store.recordUse({ 'b-note': 1 }, new Date());
    expect((await organizeStore(store)).duplicates).toEqual(['a-note']);
  });

  it('does nothing, and rewrites nothing, when the store is already tidy', async () => {
    await store.write({ id: 'one', type: 'feedback', description: 'One', body: 'x', source: 'user' });
    await store.write({ id: 'two', type: 'feedback', description: 'Two', body: 'x', source: 'user' });
    const before = await fs.readFile(path.join(dir, 'one.md'), 'utf8');
    expect(await organizeStore(store)).toEqual({ stale: [], duplicates: [] });
    expect(await fs.readFile(path.join(dir, 'one.md'), 'utf8')).toBe(before);
  });

  it('ignores notes that are already archived, so a duplicate is not archived twice', async () => {
    await store.write({ id: 'old', type: 'feedback', description: 'Same', body: 'x', source: 'user', status: 'archived' });
    await store.write({ id: 'new', type: 'feedback', description: 'Same', body: 'x', source: 'user' });
    expect(await organizeStore(store)).toEqual({ stale: [], duplicates: [] });
  });
});
