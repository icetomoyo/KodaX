import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);

it('executes the shipped Skill helper chain from an isolated npm pack installation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-packed-builtin-'));
  try {
    const npm = [process.env.npm_execpath,
      path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
      path.join(path.dirname(path.dirname(process.execPath)), 'lib/node_modules/npm/bin/npm-cli.js'),
    ].find(candidate => candidate?.endsWith('npm-cli.js') && existsSync(candidate));
    if (!npm) throw new Error('Cannot locate the npm CLI for the isolated package test.');
    const packed = await run(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', root],
      { cwd: path.resolve('.'), windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 90_000 });
    const entries = JSON.parse(packed.stdout) as Array<{ filename: string }>;
    const consumer = path.join(root, 'consumer');
    await mkdir(consumer);
    await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await run(process.execPath, [npm, 'install', path.join(root, entries[0]!.filename), '--ignore-scripts',
      '--no-audit', '--no-fund', '--package-lock=false', '--prefer-offline'],
    { cwd: consumer, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
    const fixture = await readFile(path.resolve('tests/fixtures/builtin-skill-package/probe.mjs'), 'utf8');
    const probe = path.join(consumer, 'probe.mjs');
    await writeFile(probe, fixture);
    const result = await run(process.execPath, [probe], { cwd: consumer, windowsHide: true,
      maxBuffer: 8 * 1024 * 1024, timeout: 90_000,
      env: { ...process.env, KODAX_HOME: path.join(root, 'isolated-config'), KODAX_PACKED_EVAL_KEY: 'fixture-only' } });
    expect(result.stdout).toContain('PACKED_SKILL_CHAIN_PASSED');
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}, 240_000);
