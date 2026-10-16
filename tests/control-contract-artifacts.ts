import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Use the same canonical paths for both incremental responses and final evidence. */
export async function writeControlEvidence(root: string, file: string, contents: string, exclusive = false): Promise<void> {
  const directory = path.resolve(root);
  const relative = path.relative(path.resolve(os.tmpdir()), directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || path.dirname(path.resolve(file)) !== directory) throw new Error('Smoke evidence escaped revision directory');
  await fs.writeFile(path.resolve(file), contents, { flag: exclusive ? 'wx' : 'w' });
}
