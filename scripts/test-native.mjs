import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeTestBase = path.join(
  root,
  'native',
  'windows-text-transaction',
  'target',
  'test-runtime',
);
mkdirSync(nativeTestBase, { recursive: true });
const nativeTestEnvironment = {
  ...process.env,
  KODAX_NATIVE_TEST_TEMP: nativeTestBase,
};

const crates = [
  'windows-text-transaction',
  ...(process.platform === 'win32' ? ['windows-sandbox-v2'] : []),
];
for (const crate of crates) {
  const manifest = path.join(root, 'native', crate, 'Cargo.toml');
  const result = spawnSync(process.env.CARGO ?? 'cargo', [
    'test',
    '--manifest-path',
    manifest,
    '--locked',
    '--no-default-features',
  ], {
    cwd: root,
    env: nativeTestEnvironment,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Native test suite failed for ${crate} with exit ${result.status}`);
  }
}

const nativeDirectory = path.join(root, 'dist', 'native', `${process.platform}-${process.arch}`);
const manifest = JSON.parse(readFileSync(path.join(nativeDirectory, 'manifest.json'), 'utf8'));
if (manifest.textTransaction?.protocol !== 4) {
  throw new Error('Staged native text transaction protocol is not 4');
}
const expectedLegalFiles = [
  'LICENSE-APACHE.txt',
  ...(process.platform === 'win32' ? ['NOTICE-windows-sandbox.txt'] : []),
];
if (!Array.isArray(manifest.legal) || manifest.legal.length !== expectedLegalFiles.length) {
  throw new Error('Staged native legal manifest is missing or incompatible');
}
for (const filename of expectedLegalFiles) {
  const entry = manifest.legal.find((candidate) => candidate?.file === filename);
  const legalFile = path.join(nativeDirectory, filename);
  const actualSha256 = createHash('sha256').update(readFileSync(legalFile)).digest('hex');
  if (!entry || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '') || entry.sha256 !== actualSha256) {
    throw new Error(`Staged native legal file ${filename} is missing or invalid`);
  }
}
if (process.platform === 'win32') {
  const packageName = '@anthropic-ai/sandbox-runtime';
  const rootPackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const installedRoot = path.join(root, 'node_modules', '@anthropic-ai', 'sandbox-runtime');
  const installedPackage = JSON.parse(readFileSync(path.join(installedRoot, 'package.json'), 'utf8'));
  const pinnedVersion = rootPackage.dependencies?.[packageName];
  const asrtRunner = manifest.asrtRunner;
  const asrtRunnerPath = path.join(
    installedRoot,
    'vendor',
    'srt-win',
    process.arch,
    'srt-win.exe',
  );
  const actualSha256 = createHash('sha256')
    .update(readFileSync(asrtRunnerPath))
    .digest('hex');
  if (
    typeof pinnedVersion !== 'string'
    || !/^\d+\.\d+\.\d+$/.test(pinnedVersion)
    || asrtRunner?.file !== 'srt-win.exe'
    || asrtRunner.version !== pinnedVersion
    || asrtRunner.version !== installedPackage.version
    || !/^[0-9a-f]{64}$/.test(asrtRunner.sha256 ?? '')
    || actualSha256 !== asrtRunner.sha256
  ) {
    throw new Error('Staged ASRT runner does not match its pinned native manifest');
  }
}
const smokeDirectory = mkdtempSync(path.join(nativeTestBase, 'binding-smoke-'));
try {
  const nodeDirectory = path.join(root, 'native', 'windows-text-transaction', 'node');
  copyFileSync(path.join(nodeDirectory, 'index.mjs'), path.join(smokeDirectory, 'index.mjs'));
  copyFileSync(
    path.join(nodeDirectory, 'binding.test.mjs'),
    path.join(smokeDirectory, 'binding.test.mjs'),
  );
  copyFileSync(
    path.join(nativeDirectory, manifest.textTransaction.file),
    path.join(smokeDirectory, manifest.textTransaction.file),
  );
  const smoke = spawnSync(process.execPath, [path.join(smokeDirectory, 'binding.test.mjs')], {
    cwd: smokeDirectory,
    env: nativeTestEnvironment,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (smoke.error) throw smoke.error;
  if (smoke.status !== 0) {
    throw new Error(`Native N-API binding smoke failed with exit ${smoke.status}`);
  }
} finally {
  rmSync(smokeDirectory, { recursive: true, force: true });
}
