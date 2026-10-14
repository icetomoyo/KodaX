import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Primary under isolated OS TEMP; independent mirrors avoid the old scanner namespace. */
export function editEvidencePaths(file: string): readonly string[] {
  const temporary = path.resolve(os.tmpdir());
  const root = path.join(temporary, 'kodax-eval-dumps', 'first-turn-edit-v2');
  const relative = path.relative(root, path.resolve(file));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Outside v2 evidence root');
  const parent = path.basename(temporary).toLowerCase() === 'ev2' ? path.dirname(temporary) : temporary;
  return [path.resolve(file), ...['a', 'b'].map(lane => path.join(parent, `evidence-backup-${lane}`, 'v2', relative))];
}

export async function writeEditEvidence(file: string, text: string, exclusive = false): Promise<void> {
  for (const target of editEvidencePaths(file)) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (exclusive) await fs.writeFile(target, text, { flag: 'wx' });
    else { await fs.writeFile(`${target}.tmp`, text); await fs.rename(`${target}.tmp`, target); }
  }
}
