/**
 * The v2 memory methods, over the note stores the Host's Runs read. A command
 * sent again finds what it asked for already there and answers with the note
 * as it is; a note that changed in some other way is a conflict.
 *
 * A note's revision is a hash of what it says as the store holds it, so a
 * value the store tidies, such as spaces around a description, compares as
 * the store keeps it. How often Runs read the note is not part of it.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  parseNote, serializeNote, type MemoryNote, type NewNote, type NotePatch, type NoteResult, type NoteScope, type NoteStore,
} from '@kodax-ai/agent';

import { HostProtocolError } from '../host-protocol/codec.js';

export type HostNoteStores = Readonly<Record<NoteScope, NoteStore>>;

export type HostNoteFields = Pick<NewNote, 'type' | 'description' | 'why' | 'check'> & { readonly body?: string };

export interface HostNoteSummary {
  readonly id: string;
  readonly scope: NoteScope;
  readonly type: MemoryNote['type'];
  readonly status: MemoryNote['status'];
  readonly source?: MemoryNote['source'];
  readonly description: string;
  readonly why?: string;
  readonly check?: string;
  readonly used: number;
  readonly lastUsedAt?: number;
  readonly revision: string;
}

/** `path` is on the Host's machine; the connection cuts it for any other client. */
export interface HostNote extends HostNoteSummary {
  readonly body: string;
  readonly path: string;
}

export async function listNotes(stores: HostNoteStores): Promise<{ items: HostNoteSummary[] }> {
  const notes = [...await stores.user.list(), ...await stores.project.list()];
  return { items: notes.map(summary) };
}

export async function getNote(stores: HostNoteStores, scope: NoteScope, id: string): Promise<{ note: HostNote }> {
  const store = stores[scope];
  const note = await find(store, id);
  if (note === undefined) throw noteNotFound();
  return { note: full(store, note) };
}

/** A new active note of the person. */
export async function createNote(stores: HostNoteStores, scope: NoteScope, id: string, fields: HostNoteFields): Promise<{ note: HostNote }> {
  const store = stores[scope];
  const wanted: NewNote = { ...fields, id, body: fields.body ?? '', status: 'active', source: 'user' };
  const result = await store.write(wanted);
  if (result.ok) return { note: full(store, held(result.note)) };
  if (result.reason !== 'exists') throw refusal(result);
  const current = await find(store, id);
  const asked = held({ ...wanted, scope, status: 'active', used: 0 });
  if (current !== undefined && revisionOf(current) === revisionOf(asked)) return { note: full(store, current) };
  throw new HostProtocolError('conflict', 'Another note has this id.', { reason: 'note_exists' });
}

/** Changes the fields in `patch`, only while the note is at `ifRevision` when one is named. */
export async function updateNote(
  stores: HostNoteStores, scope: NoteScope, id: string, patch: NotePatch, ifRevision?: string,
): Promise<{ note: HostNote }> {
  const store = stores[scope];
  const change = given(patch);
  const result = await store.edit(id, change, atRevision(ifRevision));
  if (result.ok) return { note: full(store, held(result.note)) };
  if (result.reason !== 'changed') throw refusal(result);
  const current = await find(store, id);
  if (current !== undefined && revisionOf(held({ ...current, ...change })) === revisionOf(current)) {
    return { note: full(store, current) };
  }
  throw revisionMismatch();
}

/** A note that is not there is forgotten already. */
export async function forgetNote(stores: HostNoteStores, scope: NoteScope, id: string, ifRevision?: string): Promise<Record<string, never>> {
  const result = await stores[scope].remove(id, atRevision(ifRevision));
  if (result.ok || result.reason === 'not-found') return {};
  if (result.reason === 'changed') throw revisionMismatch();
  throw refusal(result);
}

/** A field given as undefined keeps its value, as an absent one does. */
function given(patch: NotePatch): NotePatch {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as NotePatch;
}

function atRevision(ifRevision: string | undefined): ((note: MemoryNote) => boolean) | undefined {
  return ifRevision === undefined ? undefined : note => revisionOf(note) === ifRevision;
}

async function find(store: NoteStore, id: string): Promise<MemoryNote | undefined> {
  return (await store.list()).find(note => note.id === id);
}

/** The note as the store reads it back. */
function held(note: MemoryNote): MemoryNote {
  return parseNote(note.id, serializeNote(note), note.scope);
}

function revisionOf(note: MemoryNote): string {
  const { lastUsedAt: _lastUsedAt, ...said } = note;
  return createHash('sha256').update(serializeNote({ ...said, used: 0 })).digest('hex').slice(0, 16);
}

function summary(note: MemoryNote): HostNoteSummary {
  const lastUsedAt = note.lastUsedAt === undefined ? undefined : Date.parse(note.lastUsedAt);
  return {
    id: note.id,
    scope: note.scope,
    type: note.type,
    status: note.status,
    ...(note.source !== undefined ? { source: note.source } : {}),
    description: note.description,
    ...(note.why !== undefined ? { why: note.why } : {}),
    ...(note.check !== undefined ? { check: note.check } : {}),
    used: note.used,
    ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
    revision: revisionOf(note),
  };
}

function full(store: NoteStore, note: MemoryNote): HostNote {
  return { ...summary(note), body: note.body, path: path.join(store.root, `${note.id}.md`) };
}

function noteNotFound(): HostProtocolError {
  return new HostProtocolError('not_found', 'There is no note by this id.', { reason: 'note_not_found' });
}

function revisionMismatch(): HostProtocolError {
  return new HostProtocolError('conflict', 'The note changed since it was read; read it again.', { reason: 'revision_mismatch' });
}

function refusal(result: Extract<NoteResult, { ok: false }>): HostProtocolError {
  switch (result.reason) {
    case 'not-found': return noteNotFound();
    case 'changed': return revisionMismatch();
    case 'exists': return new HostProtocolError('conflict', 'Another note has this id.', { reason: 'note_exists' });
    case 'invalid-id':
      return new HostProtocolError('invalid_params', 'A note id is letters, digits, "-" and "_", starting with a letter or digit.', {
        reason: 'invalid_note_id',
      });
    case 'secret':
      return new HostProtocolError('invalid_params', result.detail ?? 'A note holds no secrets.', { reason: 'secret_in_note' });
    case 'empty-description':
      return new HostProtocolError('invalid_params', 'A note needs a description.', { reason: 'empty_description' });
  }
}
