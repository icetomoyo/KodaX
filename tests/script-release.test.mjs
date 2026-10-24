import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

test('Script worker and internal client are included in npm and both release archives', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('dist/script-worker.cjs'));
  const workflow = await readFile(join(root, '.github/workflows/release.yml'), 'utf8');
  for (const name of ['script-cell.js', 'script-worker.cjs']) {
    assert.ok(workflow.match(/sidecars=\(([\s\S]*?)\)/)?.[1].includes(name));
    assert.ok(workflow.match(/Compress-Archive -Path ([^\n]+?) -DestinationPath/)?.[1].split(',').includes(name));
  }
});

test('actual npm tarball runs Script in a clean directory and fails explicitly on a missing worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kodax-script-release-'));
  try {
    // npm's CLI is next to the Node installation on release runners; no install or lifecycle scripts.
    const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    const packed = await exec(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory],
      { cwd: root, windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const [manifest] = JSON.parse(packed.stdout);
    for (const name of ['dist/script-cell.js', 'dist/script-worker.cjs']) assert.ok(manifest.files.some(file => file.path === name));
    await exec('tar', ['-xf', join(directory, manifest.filename), '-C', directory], { windowsHide: true, timeout: 60_000 });
    const cwd = join(directory, 'package');
    await writeFile(join(cwd, 'probe.mjs'), `import {runScriptCell} from './dist/script-cell.js';
      const result=await runScriptCell({code:'const r=await tools.read({});return [Number(r.content)+1,typeof process,typeof fetch];',
        toolNames:['read'],limits:{timeoutMs:5000,memoryBytes:16777216,maxCalls:4,maxTransferBytes:131072},invoke:async()=>({content:'41'})});
      process.stdout.write(JSON.stringify(result));`);
    const run = async () => JSON.parse((await exec(process.execPath, ['probe.mjs'], { cwd,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }, windowsHide: true, timeout: 15_000 })).stdout);
    const result = await run();
    assert.equal(result.status, 'completed', result.error);
    assert.deepEqual(result.value, [42, 'undefined', 'undefined']);
    assert.equal(result.receipts.length, 1);
    await rm(join(cwd, 'dist/script-worker.cjs'));
    const missing = await run();
    assert.equal(missing.status, 'failed');
    assert.match(missing.error, /script-worker\.cjs/);
    assert.deepEqual(missing.receipts, []);
  } finally {
    if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith('kodax-script-release-')) throw new Error('Unsafe release cleanup');
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});
