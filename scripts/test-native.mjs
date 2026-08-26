import { spawnSync } from 'node:child_process';
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
