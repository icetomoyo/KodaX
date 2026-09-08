import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const sourcePath = 'dist/sandbox/windows-sandbox-utils.js';
const patched = readFileSync(path.join(path.dirname(
  require.resolve('@anthropic-ai/sandbox-runtime/package.json'),
), sourcePath), 'utf8');

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'kodax-asrt-build-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dependency = path.join(directory, 'node_modules/@anthropic-ai/sandbox-runtime');
  for (const entry of ['scripts', 'docs/patches', 'node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox']) {
    mkdirSync(path.join(directory, entry), { recursive: true });
  }
  writeFileSync(path.join(directory, 'package.json'), '{}');
  writeFileSync(path.join(dependency, 'package.json'), '{"version":"0.0.65"}');
  writeFileSync(path.join(dependency, sourcePath), patched);
  for (const entry of ['scripts/prepare-asrt-wfp.mjs', 'docs/patches/asrt-0.0.65-wfp-probe.patch']) {
    copyFileSync(path.join(root, entry), path.join(directory, entry));
  }
  return { directory, dependency, target: path.join(dependency, sourcePath) };
}

function runBuild(f, env = process.env) {
  return spawnSync(process.execPath, [path.join(f.directory, 'scripts/prepare-asrt-wfp.mjs')], {
    cwd: f.directory, encoding: 'utf8', windowsHide: true, env, timeout: 10_000,
  });
}

function restoreOriginal(f) {
  execFileSync('git', ['apply', '--reverse', '--ignore-whitespace', path.join(
    f.directory, 'docs/patches/asrt-0.0.65-wfp-probe.patch',
  )], { cwd: f.dependency, windowsHide: true });
}

test('ASRT build patch preserves cache hardlinks and is idempotent without Git', (t) => {
  const f = fixture(t);
  restoreOriginal(f);
  const original = readFileSync(f.target, 'utf8');
  const cache = path.join(f.directory, 'cache-original.js');
  linkSync(f.target, cache);
  const result = runBuild(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(cache, 'utf8'), original);
  assert.equal(readFileSync(f.target, 'utf8'), patched);
  assert.equal(runBuild(f, { ...process.env, PATH: '' }).status, 0);
});

test('ASRT build rejects an unexpected source or release before changing it', (t) => {
  const f = fixture(t);
  writeFileSync(f.target, 'unexpected dependency source');
  assert.match(runBuild(f).stderr, /differs from the audited release/);
  assert.equal(readFileSync(f.target, 'utf8'), 'unexpected dependency source');
  writeFileSync(path.join(f.dependency, 'package.json'), '{"version":"0.0.75"}');
  assert.match(runBuild(f).stderr, /requires the audited 0.0.65 release/);
});

test('ASRT build verifies patch output before replacing dependency source', (t) => {
  const f = fixture(t);
  restoreOriginal(f);
  const original = readFileSync(f.target, 'utf8');
  const patch = path.join(f.directory, 'docs/patches/asrt-0.0.65-wfp-probe.patch');
  writeFileSync(patch, readFileSync(patch, 'utf8').replace('Modified by KodaX:', 'Changed by KodaX:'));
  assert.match(runBuild(f).stderr, /patch output does not match the audited source/);
  assert.equal(readFileSync(f.target, 'utf8'), original);
});

test('ASRT build CLI patches dependencies through a linked directory', (t) => {
  const f = fixture(t);
  restoreOriginal(f);
  const alias = path.join(f.directory, 'linked-root');
  symlinkSync(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const result = runBuild({ ...f, directory: alias });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(f.target, 'utf8'), patched);
  } finally {
    unlinkSync(alias);
  }
});
