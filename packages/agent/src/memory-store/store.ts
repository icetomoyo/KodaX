/**
 * FEATURE_306 — file-backed note store for ONE scope root (a directory the
 * caller resolves). Pure fs: no dependency on the legacy memory-control
 * package, so the new store and the old system coexist until the old code is
 * removed.
 *
 * Guarantees: secrets are rejected before anything is written; every file
 * write is temp-file + rename (never a torn file); MEMORY.md is rewritten only
 * when its bytes change. Operations on one store are serialized in-process.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { buildIndex } from './index-builder.js';
import { parseNote, serializeNote, type MemoryNote, type NoteScope, type NoteSource, type NoteStatus, type NoteType } from './record.js';
import { keepRevision } from './revisions.js';
import { findSecret } from './secrets.js';

export const INDEX_FILE = 'MEMORY.md';

export interface NewNote {
  readonly id: string;
  readonly type: NoteType;
  readonly description: string;
  readonly why?: string;
  readonly check?: string;
  readonly status?: NoteStatus;
  readonly source?: NoteSource;
  readonly session?: string;
  readonly body: string;
}

export type NotePatch = Partial<Pick<NewNote, 'type' | 'description' | 'why' | 'check' | 'status' | 'source' | 'body'>>;

export type NoteResult =
  | { readonly ok: true; readonly note: MemoryNote }
  | {
      readonly ok: false;
      readonly reason: 'invalid-id' | 'exists' | 'not-found' | 'secret' | 'empty-description';
      readonly detail?: string;
    };

export interface NoteStore {
  readonly root: string;
  readonly scope: NoteScope;
  list(): Promise<readonly MemoryNote[]>;
  write(input: NewNote): Promise<NoteResult>;
  edit(id: string, patch: NotePatch): Promise<NoteResult>;
  remove(id: string): Promise<NoteResult>;
  /** Adds observed reads to the usage counters of existing notes; no revision is kept. Returns how many notes were updated. */
  recordUse(uses: Readonly<Record<string, number>>, at: Date): Promise<number>;
  /** Returns true when MEMORY.md changed. */
  rebuildIndex(): Promise<boolean>;
}

const ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u;

function validId(id: string): boolean {
  return ID_PATTERN.test(id) && id.toUpperCase() !== 'MEMORY';
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readOrUndefined(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

let tempCounter = 0;

async function atomicWrite(file: string, content: string): Promise<void> {
  const temp = `${file}.tmp-${process.pid}-${tempCounter++}`;
  try {
    await fs.writeFile(temp, content, 'utf8');
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

function secretIn(fields: Readonly<Record<string, string | undefined>>): NoteResult | undefined {
  for (const [name, value] of Object.entries(fields)) {
    const hit = value === undefined ? undefined : findSecret(value);
    if (hit !== undefined) {
      return { ok: false, reason: 'secret', detail: `${name} looks like a ${hit.kind}; secrets are never stored in memory` };
    }
  }
  return undefined;
}

export function createNoteStore(root: string, scope: NoteScope): NoteStore {
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const fileOf = (id: string): string => path.join(root, `${id}.md`);

  async function listNotes(): Promise<readonly MemoryNote[]> {
    let names: string[];
    try {
      names = await fs.readdir(root);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const notes: MemoryNote[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.md') || name.toUpperCase() === INDEX_FILE.toUpperCase()) continue;
      notes.push(parseNote(name.slice(0, -3), await fs.readFile(path.join(root, name), 'utf8'), scope));
    }
    return notes;
  }

  async function rebuild(): Promise<boolean> {
    const index = buildIndex(await listNotes());
    const file = path.join(root, INDEX_FILE);
    if ((await readOrUndefined(file) ?? '') === index) return false;
    await fs.mkdir(root, { recursive: true });
    await atomicWrite(file, index);
    return true;
  }

  async function save(note: MemoryNote): Promise<NoteResult> {
    await fs.mkdir(root, { recursive: true });
    const previous = await readOrUndefined(fileOf(note.id));
    const next = serializeNote(note);
    if (previous !== undefined && previous !== next) await keepRevision(root, note.id, previous);
    await atomicWrite(fileOf(note.id), next);
    await rebuild();
    return { ok: true, note };
  }

  return {
    root,
    scope,
    list: listNotes,
    rebuildIndex: () => serialized(rebuild),

    write: (input) => serialized(async () => {
      if (!validId(input.id)) return { ok: false, reason: 'invalid-id' };
      if (input.description.trim().length === 0) return { ok: false, reason: 'empty-description' };
      const rejected = secretIn({ description: input.description, why: input.why, check: input.check, body: input.body });
      if (rejected !== undefined) return rejected;
      if ((await readOrUndefined(fileOf(input.id))) !== undefined) return { ok: false, reason: 'exists' };
      return save({
        id: input.id,
        type: input.type,
        scope,
        description: input.description,
        ...(input.why === undefined ? {} : { why: input.why }),
        ...(input.check === undefined ? {} : { check: input.check }),
        status: input.status ?? 'active',
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.session === undefined ? {} : { session: input.session }),
        used: 0,
        body: input.body,
      });
    }),

    edit: (id, patch) => serialized(async () => {
      if (!validId(id)) return { ok: false, reason: 'invalid-id' };
      const raw = await readOrUndefined(fileOf(id));
      if (raw === undefined) return { ok: false, reason: 'not-found' };
      if (patch.description !== undefined && patch.description.trim().length === 0) {
        return { ok: false, reason: 'empty-description' };
      }
      const rejected = secretIn({ description: patch.description, why: patch.why, check: patch.check, body: patch.body });
      if (rejected !== undefined) return rejected;
      return save({ ...parseNote(id, raw, scope), ...patch, scope });
    }),

    recordUse: (uses, at) => serialized(async () => {
      let updated = 0;
      for (const [id, count] of Object.entries(uses)) {
        if (!validId(id) || !Number.isInteger(count) || count <= 0) continue;
        const raw = await readOrUndefined(fileOf(id));
        if (raw === undefined) continue;
        const note = parseNote(id, raw, scope);
        await atomicWrite(fileOf(id), serializeNote({ ...note, used: note.used + count, lastUsedAt: at.toISOString() }));
        updated += 1;
      }
      if (updated > 0) await rebuild();
      return updated;
    }),

    remove: (id) => serialized(async () => {
      if (!validId(id)) return { ok: false, reason: 'invalid-id' };
      const raw = await readOrUndefined(fileOf(id));
      if (raw === undefined) return { ok: false, reason: 'not-found' };
      await keepRevision(root, id, raw);
      await fs.rm(fileOf(id));
      await rebuild();
      return { ok: true, note: parseNote(id, raw, scope) };
    }),
  };
}
