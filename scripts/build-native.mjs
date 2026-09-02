import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shellCrate = path.join(root, 'native', 'windows-sandbox-v2');
const textCrate = path.join(root, 'native', 'windows-text-transaction');
const targetArch = process.env.KODAX_NATIVE_TARGET_ARCH ?? process.arch;
const rustTarget = process.platform === 'linux'
  ? targetArch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
  : process.platform === 'darwin'
    ? targetArch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
    : targetArch === process.arch ? undefined : null;
if (rustTarget === null) {
  throw new Error(`Unsupported Windows native target architecture: ${targetArch}`);
}

function runCargo(crate, args) {
  const cargo = process.env.CARGO || 'cargo';
  const result = spawnSync(cargo, args, {
    cwd: crate,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cargo ${args.join(' ')} failed in ${crate} with exit ${result.status}`);
  }
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function pinnedAsrtRunner(arch) {
  const packageName = '@anthropic-ai/sandbox-runtime';
  const rootPackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const asrtVersion = rootPackage.dependencies?.[packageName];
  if (typeof asrtVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(asrtVersion)) {
    throw new Error(`${packageName} must be pinned to an exact release version`);
  }
  const asrtRoot = path.join(root, 'node_modules', '@anthropic-ai', 'sandbox-runtime');
  const installed = JSON.parse(readFileSync(path.join(asrtRoot, 'package.json'), 'utf8'));
  if (installed.version !== asrtVersion) {
    throw new Error(
      `${packageName} ${String(installed.version)} does not match pinned version ${asrtVersion}`,
    );
  }
  const asrtRunnerPath = path.join(asrtRoot, 'vendor', 'srt-win', arch, 'srt-win.exe');
  if (!existsSync(asrtRunnerPath)) {
    throw new Error(`Missing pinned ASRT runner: ${asrtRunnerPath}`);
  }
  return { asrtRunnerPath, asrtVersion };
}

const targetArgs = rustTarget === undefined ? [] : ['--target', rustTarget];
runCargo(textCrate, ['build', '--release', '--locked', ...targetArgs]);
if (process.platform === 'win32') {
  if (targetArch !== process.arch) {
    throw new Error('Windows shell sandbox artifacts must be built on their target architecture.');
  }
  runCargo(shellCrate, ['build', '--release', '--locked']);
}

const output = path.join(root, 'dist', 'native', `${process.platform}-${targetArch}`);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const textOutput = path.join(
  output,
  process.platform === 'win32'
    ? 'kodax-windows-text-transaction.node'
    : 'kodax-text-transaction.node',
);
const textLibrary = process.platform === 'win32'
  ? 'kodax_windows_text_transaction.dll'
  : process.platform === 'darwin'
    ? 'libkodax_windows_text_transaction.dylib'
    : 'libkodax_windows_text_transaction.so';
copyFileSync(
  path.join(
    textCrate,
    'target',
    ...(rustTarget === undefined ? [] : [rustTarget]),
    'release',
    textLibrary,
  ),
  textOutput,
);
const apacheLicenseOutput = path.join(output, 'LICENSE-APACHE.txt');
copyFileSync(path.join(textCrate, 'LICENSE-APACHE'), apacheLicenseOutput);

const manifest = {
  version: 1,
  platform: process.platform,
  arch: targetArch,
  textTransaction: {
    file: path.basename(textOutput),
    protocol: 4,
    sha256: sha256(textOutput),
  },
  legal: [{
    file: path.basename(apacheLicenseOutput),
    sha256: sha256(apacheLicenseOutput),
  }],
};
if (process.platform === 'win32') {
  const shellOutput = path.join(output, 'kodax-windows-sandbox.exe');
  copyFileSync(
    path.join(shellCrate, 'target', 'release', 'kodax-windows-sandbox.exe'),
    shellOutput,
  );
  manifest.shellSandbox = {
    file: path.basename(shellOutput),
    protocol: 10,
    sha256: sha256(shellOutput),
  };
  const { asrtRunnerPath, asrtVersion } = pinnedAsrtRunner(targetArch);
  manifest.asrtRunner = {
    file: 'srt-win.exe',
    version: asrtVersion,
    sha256: sha256(asrtRunnerPath),
  };
  const noticeOutput = path.join(output, 'NOTICE-windows-sandbox.txt');
  copyFileSync(path.join(shellCrate, 'NOTICE'), noticeOutput);
  manifest.legal.push({
    file: path.basename(noticeOutput),
    sha256: sha256(noticeOutput),
  });
}
writeFileSync(
  path.join(output, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);
process.stdout.write(`[build-native] staged ${path.relative(root, output)}\n`);
