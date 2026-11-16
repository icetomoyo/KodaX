import { mkdir } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { physicalSkillRoot } from './types.js';

let root: string;
beforeEach(async () => { root = await createTempDir('kodax-builtin-path-'); });
afterEach(async () => { await removeTempDir(root); });

// Builtin Skill scripts run under a real `node`, which cannot read inside app.asar.
it('points a packaged Electron builtin root at its unpacked copy when one exists', async () => {
  const packed = join(root, 'resources', 'app.asar', 'node_modules', 'kodax', 'dist', 'builtin');
  const unpacked = join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'kodax', 'dist', 'builtin');
  expect(physicalSkillRoot(packed)).toBe(packed);
  await mkdir(unpacked, { recursive: true });
  expect(physicalSkillRoot(packed)).toBe(unpacked);
  expect(physicalSkillRoot(join(root, 'dist', 'builtin'))).toBe(join(root, 'dist', 'builtin'));
});
