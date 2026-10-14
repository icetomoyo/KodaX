import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { editEvidencePaths, writeEditEvidence } from './first-turn-edit-artifacts.js';

it('mirrors exact evidence bytes outside the isolated eval namespace before returning', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-edit-artifact-test-'));
  const isolated = path.join(fixture, 'ev2');
  vi.stubEnv('TEMP', isolated); vi.stubEnv('TMP', isolated); vi.stubEnv('TMPDIR', isolated);
  const file = path.join(isolated, 'kodax-eval-dumps', 'first-turn-edit-v2', 'layer2', 'raw.json');
  const text = '{"text":"中文原始响应","toolCalls":[]}\n';
  try {
    await writeEditEvidence(file, text, true);
    const paths = editEvidencePaths(file);
    expect(paths).toEqual([file, path.join(fixture, 'evidence-backup-a', 'v2', 'layer2', 'raw.json'), path.join(fixture, 'evidence-backup-b', 'v2', 'layer2', 'raw.json')]);
    expect(await Promise.all(paths.map(target => fs.readFile(target, 'utf8')))).toEqual([text, text, text]);
    await expect(writeEditEvidence(file, 'must not overwrite', true)).rejects.toThrow();
    await fs.rm(path.join(isolated, 'kodax-eval-dumps'), { recursive: true });
    expect(await fs.readFile(paths[1]!, 'utf8')).toBe(text);
    expect(await fs.readFile(paths[2]!, 'utf8')).toBe(text);
    expect(() => editEvidencePaths(path.join(fixture, 'outside.json'))).toThrow('Outside v2');
  } finally {
    vi.unstubAllEnvs();
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
