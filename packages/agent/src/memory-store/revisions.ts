/**
 * FEATURE_308 — previous revisions of a note, kept so a wrong rewrite or an
 * unwanted delete can be undone by hand. Files live in `<root>/.revisions/` as
 * `<id>.<epoch-ms>-<n>.md`; the notes listing ignores the directory.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { isNotFound } from './fs-util.js';

export const REVISIONS_DIR = '.revisions';
export const REVISION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

let counter = 0;

export async function keepRevision(root: string, id: string, raw: string, now: number = Date.now()): Promise<void> {
  const dir = path.join(root, REVISIONS_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.${now}-${counter++}.md`), raw, 'utf8');
}

/** Deletes revisions older than `maxAgeMs`; returns how many were removed. */
export async function pruneRevisions(
  root: string,
  maxAgeMs: number = REVISION_RETENTION_MS,
  now: number = Date.now(),
): Promise<number> {
  const dir = path.join(root, REVISIONS_DIR);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (isNotFound(error)) return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    const stamp = /\.(\d+)-\d+\.md$/.exec(name)?.[1];
    if (stamp !== undefined && now - Number(stamp) > maxAgeMs) {
      await fs.rm(path.join(dir, name), { force: true });
      removed += 1;
    }
  }
  return removed;
}
