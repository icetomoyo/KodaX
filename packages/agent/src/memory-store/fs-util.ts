/** FEATURE_306 — the small fs helpers every note-store file uses. */
import * as fs from 'node:fs/promises';

export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export async function readOrUndefined(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

let tempCounter = 0;

/** Temp file + rename, so a reader never sees a torn file. */
export async function atomicWrite(file: string, content: string): Promise<void> {
  const temp = `${file}.tmp-${process.pid}-${tempCounter++}`;
  try {
    await fs.writeFile(temp, content, 'utf8');
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}
