import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CACHE_FILES, CACHE_GOLDEN, CACHE_ORACLE, writeCacheFixture } from './fixture.js';

it('requires repairs behind public re-exports while retaining unrelated same-name examples', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-search-complex-'));
  const workspace = path.join(root, 'workspace');
  const oracle = path.join(root, 'oracle.mjs');
  const runOracle = () => spawnSync(process.execPath, ['--test', oracle], { cwd: root, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, KODAX_COMPLEX_ORACLE_WORKSPACE: workspace } });
  try {
    await writeCacheFixture(workspace);
    await fs.writeFile(oracle, CACHE_ORACLE);
    expect(execFileSync(process.execPath, ['--test'], { cwd: workspace, encoding: 'utf8', windowsHide: true })).toContain('# pass 1');
    const broken = runOracle();
    expect(broken.status).toBe(1);
    for (const name of ['opaque tenant keys', 'expiry equality and zero TTL', 'concurrent tenant isolation']) expect(broken.stdout).toMatch(new RegExp(`not ok \\d+ - ${name}`));
    for (const [file, content] of Object.entries(CACHE_GOLDEN)) await fs.writeFile(path.join(workspace, file), content);
    const fixed = runOracle();
    expect(fixed.status).toBe(0); expect(fixed.stdout).toContain('# pass 6');
    for (const file of ['src/keys.js', 'src/client.js', 'examples/legacy-key.js']) expect(await fs.readFile(path.join(workspace, file), 'utf8')).toBe(CACHE_FILES[file]);
  } finally {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('kodax-search-complex-')) throw new Error('Unsafe fixture path');
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
