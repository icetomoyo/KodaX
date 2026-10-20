import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CACHE_FILES, CACHE_GOLDEN, CACHE_ORACLE, CACHE_TASK, writeCacheFixture } from './fixture.js';

it('distinguishes the three cross-file defects from a passing public baseline', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-complex-fixture-'));
  const workspace = path.join(root, 'workspace');
  const oracle = path.join(root, 'oracle.mjs');
  try {
    await writeCacheFixture(workspace);
    await fs.writeFile(oracle, CACHE_ORACLE);
    const visible = execFileSync(process.execPath, ['--test'], { cwd: workspace, encoding: 'utf8', windowsHide: true });
    expect(visible).toContain('# fail 0');
    const broken = spawnSync(process.execPath, ['--test', oracle], {
      cwd: root, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, KODAX_COMPLEX_ORACLE_WORKSPACE: workspace },
    });
    expect(broken.status).toBe(1);
    for (const failure of ['opaque tenant keys', 'expiry equality and zero TTL', 'concurrent tenant isolation']) {
      expect(broken.stdout).toMatch(new RegExp(`not ok \\d+ - ${failure}`));
    }
    for (const [file, content] of Object.entries(CACHE_GOLDEN)) await fs.writeFile(path.join(workspace, file), content);
    const fixed = execFileSync(process.execPath, ['--test', oracle], {
      cwd: root, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, KODAX_COMPLEX_ORACLE_WORKSPACE: workspace },
    });
    expect(fixed).toContain('# pass 6');
    expect(fixed).toContain('# fail 0');
    await fs.writeFile(path.join(workspace, 'src/cache.js'), CACHE_GOLDEN['src/cache.js']!.replace('clock() >= entry.expiresAt', 'clock() > entry.expiresAt'));
    const expiryRegression = spawnSync(process.execPath, ['--test', oracle], {
      cwd: root, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, KODAX_COMPLEX_ORACLE_WORKSPACE: workspace },
    });
    expect(expiryRegression.status).toBe(1);
    expect(expiryRegression.stdout).toMatch(/not ok \d+ - expiry equality and zero TTL/);
    expect(Object.keys(CACHE_GOLDEN)).toHaveLength(3);
    expect(CACHE_TASK).not.toMatch(/first.*read|第一轮|严格按/);
    expect(CACHE_FILES['README.md']).toContain('opaque');
  } finally {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('kodax-complex-fixture-')) throw new Error('Unsafe fixture path');
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 30_000);
