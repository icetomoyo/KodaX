import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { writeControlEvidence } from './control-contract-artifacts.js';

it('persists incremental and final evidence with mixed Windows separators', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-control-writer-test-'));
  try {
    const configuredRoot = root.replaceAll('\\', '/');
    const calls = path.join(root, 'smoke.json.calls.json');
    await writeControlEvidence(configuredRoot, calls, 'first response');
    await writeControlEvidence(configuredRoot, calls, 'all responses');
    await writeControlEvidence(configuredRoot, path.join(root, 'smoke.json'), 'final evidence', true);
    expect(await fs.readFile(calls, 'utf8')).toBe('all responses');
    expect(await fs.readFile(path.join(root, 'smoke.json'), 'utf8')).toBe('final evidence');
    await expect(writeControlEvidence(configuredRoot, path.join(root, 'smoke.json'), 'overwrite', true)).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(writeControlEvidence(configuredRoot, path.join(root, '..', 'outside.json'), 'outside')).rejects.toThrow('escaped');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
