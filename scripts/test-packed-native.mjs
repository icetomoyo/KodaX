import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tarballs = readdirSync(root).filter((entry) => (
  /^kodax-ai-kodax-.+\.tgz$/.test(entry)
));
if (tarballs.length !== 1) {
  throw new Error(`Expected exactly one packed KodaX tarball, found ${tarballs.length}.`);
}

const installation = mkdtempSync(path.join(os.tmpdir(), 'kodax-packed-native-'));
try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const installed = spawnSync(npm, [
    'install',
    '--prefix', installation,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    path.join(root, tarballs[0]),
  ], {
    cwd: installation,
    encoding: 'utf8',
    env: process.env,
    windowsHide: true,
  });
  if (installed.error) throw installed.error;
  if (installed.status !== 0) {
    throw new Error(`Packed KodaX install failed: ${installed.stderr.trim()}`);
  }

  const bin = path.join(
    installation,
    'node_modules',
    '@kodax-ai',
    'kodax',
    'scripts',
    'kodax-bin.cjs',
  );
  const result = spawnSync(process.execPath, [bin, 'doctor', '--json', '--native-text'], {
    cwd: installation,
    encoding: 'utf8',
    env: {
      ...process.env,
      KODAX_HOME: path.join(installation, 'home'),
      KODAX_TRACING: '0',
    },
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  let report;
  try {
    report = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error('Installed npm native text gate did not emit one JSON doctor report.');
  }
  if (
    result.status !== 0
    || report?.trustedTextNative?.ready !== true
    || report.trustedTextNative.protocol !== 4
  ) {
    throw new Error(
      `Installed npm trusted text native gate failed (exit ${result.status}): `
      + `${result.stderr.trim()}\n${result.stdout.trim()}`,
    );
  }
  process.stdout.write('[test-packed-native] installed tarball loaded protocol 4\n');
} finally {
  rmSync(installation, { recursive: true, force: true });
}
