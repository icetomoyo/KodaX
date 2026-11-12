/**
 * FEATURE_306 — which sessions the reflection job has already processed, kept
 * in `<root>/.reflected.json`. A session is marked only AFTER its reflection
 * succeeded, so a failed run is retried; entries expire after 90 days.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const CURSOR_FILE = '.reflected.json';
const CURSOR_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

type Cursor = Record<string, number>;

async function load(root: string): Promise<Cursor> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(root, CURSOR_FILE), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
}

export async function isReflected(root: string, sessionId: string): Promise<boolean> {
  return (await load(root))[sessionId] !== undefined;
}

export async function markReflected(root: string, sessionId: string, now: number = Date.now()): Promise<void> {
  const cursor = await load(root);
  cursor[sessionId] = now;
  for (const [id, at] of Object.entries(cursor)) {
    if (now - at > CURSOR_RETENTION_MS) delete cursor[id];
  }
  await fs.mkdir(root, { recursive: true });
  const temp = path.join(root, `${CURSOR_FILE}.tmp-${process.pid}`);
  await fs.writeFile(temp, JSON.stringify(cursor), 'utf8');
  await fs.rename(temp, path.join(root, CURSOR_FILE));
}
