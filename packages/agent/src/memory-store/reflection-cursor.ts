/**
 * FEATURE_306 — which sessions the reflection job has already processed, kept
 * in `<root>/.reflected.json` together with how many user turns the session had
 * then, so a session that keeps going can be read again later. A session is
 * marked only AFTER its reflection succeeded, so a failed run is retried;
 * entries expire after 90 days.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const CURSOR_FILE = '.reflected.json';
const CURSOR_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

interface Entry {
  readonly at: number;
  readonly userTurns: number;
}
type Cursor = Record<string, Entry>;

function entryOf(value: unknown): Entry | undefined {
  if (typeof value === 'number') return { at: value, userTurns: 0 };
  if (typeof value !== 'object' || value === null) return undefined;
  const { at, userTurns } = value as Record<string, unknown>;
  return typeof at === 'number' && typeof userTurns === 'number' ? { at, userTurns } : undefined;
}

async function load(root: string): Promise<Cursor> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(root, CURSOR_FILE), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const cursor: Cursor = {};
    for (const [id, value] of Object.entries(parsed)) {
      const entry = entryOf(value);
      if (entry !== undefined) cursor[id] = entry;
    }
    return cursor;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
}

export async function isReflected(root: string, sessionId: string): Promise<boolean> {
  return (await load(root))[sessionId] !== undefined;
}

/** User turns the session had when it was last reflected, or undefined if it never was. */
export async function reflectedUserTurns(root: string, sessionId: string): Promise<number | undefined> {
  return (await load(root))[sessionId]?.userTurns;
}

export async function markReflected(root: string, sessionId: string, now: number = Date.now(), userTurns = 0): Promise<void> {
  const cursor = await load(root);
  cursor[sessionId] = { at: now, userTurns };
  for (const [id, entry] of Object.entries(cursor)) {
    if (now - entry.at > CURSOR_RETENTION_MS) delete cursor[id];
  }
  await fs.mkdir(root, { recursive: true });
  const temp = path.join(root, `${CURSOR_FILE}.tmp-${process.pid}`);
  await fs.writeFile(temp, JSON.stringify(cursor), 'utf8');
  await fs.rename(temp, path.join(root, CURSOR_FILE));
}
