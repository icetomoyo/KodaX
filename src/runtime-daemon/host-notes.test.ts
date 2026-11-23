import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createNoteStore } from '@kodax-ai/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNote, forgetNote, getNote, listNotes, updateNote, type HostNoteStores } from './host-notes.js';

let home: string;
let stores: HostNoteStores;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kodax-host-notes-'));
  stores = { user: createNoteStore(path.join(home, 'user'), 'user'), project: createNoteStore(path.join(home, 'project'), 'project') };
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const fields = { type: 'feedback' as const, description: 'Run the fast tests first', body: 'They take a minute.\n' };

describe('the notes a Host keeps for its Runs', () => {
  it('writes a note of the person, reads it back with its body, and lists it without', async () => {
    const { note } = await createNote(stores, 'project', 'fast-tests', fields);
    expect(note).toMatchObject({
      id: 'fast-tests', scope: 'project', status: 'active', source: 'user', used: 0, body: 'They take a minute.\n',
      path: path.join(home, 'project', 'fast-tests.md'),
    });
    expect(note.revision).toMatch(/^[a-f0-9]{16}$/);
    expect(await getNote(stores, 'project', 'fast-tests')).toEqual({ note });
    await createNote(stores, 'user', 'tone', { type: 'user', description: 'Answer in Chinese' });

    const { items } = await listNotes(stores);
    expect(items.map(item => [item.scope, item.id])).toEqual([['user', 'tone'], ['project', 'fast-tests']]);
    expect(items[1]).not.toHaveProperty('body');
    expect(items[1]?.revision).toBe(note.revision);
  });

  it('answers a create sent again with the note, and refuses another note under the same id', async () => {
    const first = await createNote(stores, 'project', 'fast-tests', { ...fields, description: '  Run the fast tests first ' });
    expect(await createNote(stores, 'project', 'fast-tests', { ...fields, description: '  Run the fast tests first ' })).toEqual(first);
    await expect(createNote(stores, 'project', 'fast-tests', { ...fields, description: 'Something else' }))
      .rejects.toMatchObject({ kodaxCode: 'conflict', reason: 'note_exists' });
  });

  it('changes a note only at the revision the client read, and answers a change sent again with the note', async () => {
    const { note } = await createNote(stores, 'project', 'fast-tests', { ...fields, why: 'CI is slow' });
    const changed = await updateNote(stores, 'project', 'fast-tests', { description: 'Run make check-fast first', why: undefined }, note.revision);
    expect(changed.note).toMatchObject({ description: 'Run make check-fast first', why: 'CI is slow', body: fields.body });
    expect(changed.note.revision).not.toBe(note.revision);

    expect(await updateNote(stores, 'project', 'fast-tests', { description: 'Run make check-fast first' }, note.revision)).toEqual(changed);
    await expect(updateNote(stores, 'project', 'fast-tests', { description: 'Run all tests' }, note.revision))
      .rejects.toMatchObject({ kodaxCode: 'conflict', reason: 'revision_mismatch' });
    expect((await getNote(stores, 'project', 'fast-tests')).note).toEqual(changed.note);
  });

  it('approves a candidate the agent wrote, so it is the person’s own', async () => {
    await stores.project.write({ id: 'guess', ...fields, status: 'candidate', source: 'inferred' });
    const { note } = await getNote(stores, 'project', 'guess');
    const approved = await updateNote(stores, 'project', 'guess', { status: 'active', source: 'user' }, note.revision);
    expect(approved.note).toMatchObject({ status: 'active', source: 'user' });
    expect(await updateNote(stores, 'project', 'guess', { status: 'active', source: 'user' }, note.revision)).toEqual(approved);
  });

  it('forgets a note once, and finds it forgotten when told again', async () => {
    const { note } = await createNote(stores, 'project', 'fast-tests', fields);
    await updateNote(stores, 'project', 'fast-tests', { description: 'Changed meanwhile' });
    await expect(forgetNote(stores, 'project', 'fast-tests', note.revision))
      .rejects.toMatchObject({ kodaxCode: 'conflict', reason: 'revision_mismatch' });

    expect(await forgetNote(stores, 'project', 'fast-tests')).toEqual({});
    expect(await forgetNote(stores, 'project', 'fast-tests', note.revision)).toEqual({});
    await expect(getNote(stores, 'project', 'fast-tests')).rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'note_not_found' });
  });

  it('refuses a secret, an id that cannot name a file, and a note that is not there', async () => {
    await expect(createNote(stores, 'project', 'key', { ...fields, body: 'sk-live-9f8e7d6c5b4a39281716aabbccdd' }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params', reason: 'secret_in_note' });
    await expect(createNote(stores, 'project', '../escape', fields))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params', reason: 'invalid_note_id' });
    await expect(updateNote(stores, 'project', 'missing', { description: 'x' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'note_not_found' });
    await expect(getNote(stores, 'user', 'missing')).rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'note_not_found' });
    expect((await listNotes(stores)).items).toEqual([]);
  });
});
