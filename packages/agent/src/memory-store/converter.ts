/**
 * FEATURE_306 — one-time converter from a legacy memdir into a new note store.
 *
 * The legacy directory is only READ, so the old system keeps working until it
 * is removed and the conversion can be re-run safely (existing ids are never
 * overwritten). Legacy facts this relies on: every `*.md` file on disk is a
 * live memory; only `archived` / `forgotten` are tracked per file, in
 * `.governance/lifecycle.json` keyed by HMAC(tombstone.key, `memdir:<file>`).
 * Pending review proposals are not durable memory and are not converted.
 */
import { createHmac } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { parseNote } from './record.js';
import { INDEX_FILE, type NoteStore } from './store.js';

export interface ConversionReport {
  readonly converted: readonly string[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
}

type Tombstones = ReadonlyMap<string, 'archived' | 'forgotten'>;

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readIfExists(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * A malformed lifecycle file throws rather than being ignored: treating a
 * forgotten note as live would resurrect something the user asked to delete.
 */
async function readTombstones(legacyRoot: string): Promise<(filename: string) => 'archived' | 'forgotten' | undefined> {
  const state = await readIfExists(path.join(legacyRoot, '.governance', 'lifecycle.json'));
  if (state === undefined) return () => undefined;
  const key = await readIfExists(path.join(legacyRoot, '.governance', 'tombstone.key'));
  if (key === undefined) throw new Error('legacy lifecycle.json exists but tombstone.key is missing');
  const entries = (JSON.parse(state.toString('utf8')) as { entries: Record<string, { lifecycle: 'archived' | 'forgotten' }> }).entries;
  const byHash: Tombstones = new Map(Object.entries(entries).map(([hash, entry]) => [hash, entry.lifecycle]));
  return (filename) => byHash.get(createHmac('sha256', key).update(`memdir:${filename}`).digest('hex'));
}

function safeId(stem: string): string {
  return stem
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^[-_]+|-+$/g, '')
    .slice(0, 64);
}

export async function convertLegacyMemdir(legacyRoot: string, store: NoteStore): Promise<ConversionReport> {
  let names: string[];
  try {
    names = await fs.readdir(legacyRoot);
  } catch (error) {
    if (isNotFound(error)) return { converted: [], skipped: [] };
    throw error;
  }
  const tombstoneOf = await readTombstones(legacyRoot);
  const converted: string[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const name of names.sort()) {
    if (!name.endsWith('.md') || name.toUpperCase() === INDEX_FILE.toUpperCase()) continue;
    const id = safeId(name.slice(0, -3));
    const tombstone = tombstoneOf(name);
    if (tombstone === 'forgotten') {
      skipped.push({ id, reason: 'forgotten' });
      continue;
    }
    const note = parseNote(id, await fs.readFile(path.join(legacyRoot, name), 'utf8'), store.scope);
    const result = await store.write({
      id,
      type: note.type,
      description: note.description,
      ...(note.why === undefined ? {} : { why: note.why }),
      ...(note.check === undefined ? {} : { check: note.check }),
      status: tombstone === 'archived' ? 'archived' : note.status,
      body: note.body,
    });
    if (result.ok) converted.push(id);
    else skipped.push({ id, reason: result.reason });
  }
  return { converted, skipped };
}
