/**
 * FEATURE_306 — deterministic store hygiene, no model call.
 *
 *   stale      a note the model inferred and nobody confirmed or used for 90 days
 *              is archived (reversible: the file stays, only the index drops it).
 *              A note the user stated is never archived automatically, because its
 *              one-line index entry may be all the model ever needs, and that is
 *              not a read the host can see.
 *   duplicate  two live notes with the same description (ignoring case and
 *              punctuation) are one note; the better one stays. Notes that say
 *              the same thing in different words are left to the reflection job,
 *              which sees every current note and can rewrite or dispute them.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { MemoryNote, NoteStatus } from './record.js';
import type { NoteStore } from './store.js';

export const STALE_AFTER_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface OrganizeReport {
  readonly stale: readonly string[];
  readonly duplicates: readonly string[];
}

function normalized(description: string): string {
  return description.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
}

const STATUS_RANK: Readonly<Record<NoteStatus, number>> = { active: 0, disputed: 1, candidate: 2, archived: 3 };

/** Lower is better: the user's own note, then the more trusted state, then the more used, then the id. */
function rank(note: MemoryNote): readonly [number, number, number, string] {
  return [note.source === 'inferred' ? 1 : 0, STATUS_RANK[note.status], -note.used, note.id];
}

function better(left: MemoryNote, right: MemoryNote): number {
  const a = rank(left);
  const b = rank(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0);
}

async function lastTouched(store: NoteStore, note: MemoryNote): Promise<number> {
  if (note.lastUsedAt !== undefined) return Date.parse(note.lastUsedAt);
  return (await fs.stat(path.join(store.root, `${note.id}.md`))).mtimeMs;
}

export async function organizeStore(store: NoteStore, now: Date = new Date()): Promise<OrganizeReport> {
  const stale: string[] = [];
  const live: MemoryNote[] = [];
  for (const note of await store.list()) {
    if (note.status === 'archived') continue;
    if (note.source === 'inferred' && now.getTime() - await lastTouched(store, note) > STALE_AFTER_DAYS * DAY_MS) stale.push(note.id);
    else live.push(note);
  }

  const duplicates: string[] = [];
  const groups = new Map<string, MemoryNote[]>();
  for (const note of live) {
    const key = normalized(note.description);
    groups.set(key, [...(groups.get(key) ?? []), note]);
  }
  for (const group of groups.values()) {
    duplicates.push(...[...group].sort(better).slice(1).map((note) => note.id));
  }

  for (const id of [...stale, ...duplicates]) await store.edit(id, { status: 'archived' });
  return { stale, duplicates };
}
