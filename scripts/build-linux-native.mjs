import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rustToolchain = '1.98.0';
const builders = {
  x64: {
    image: 'quay.io/pypa/manylinux_2_28_x86_64@sha256:443eabd378e140996780a772e12c1a1ef10551da933fe76d74a1bab61f68a7b7',
    target: 'x86_64-unknown-linux-gnu',
  },
  arm64: {
    image: 'quay.io/pypa/manylinux_2_28_aarch64@sha256:a435288af93def166dc59b5d052fa20ce59d76c6f38e8ad105767262d36843f0',
    target: 'aarch64-unknown-linux-gnu',
  },
};

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`);
  }
}

function main() {
  if (process.platform !== 'linux') {
    throw new Error('The glibc 2.28 native builder must run on Linux.');
  }
  const targetArch = process.env.KODAX_NATIVE_TARGET_ARCH ?? process.arch;
  const builder = builders[targetArch];
  if (builder === undefined) {
    throw new Error(`Unsupported Linux native target architecture: ${targetArch}`);
  }

  run('rustup', [
    'toolchain', 'install', rustToolchain,
    '--profile', 'minimal',
    '--target', builder.target,
  ]);

  const cargoHome = process.env.CARGO_HOME ?? path.join(homedir(), '.cargo');
  const rustupHome = process.env.RUSTUP_HOME ?? path.join(homedir(), '.rustup');
  const user = `${process.getuid()}:${process.getgid()}`;
  run('docker', [
    'run', '--rm', '--pull=always',
    '--user', user,
    '--env', 'HOME=/tmp/kodax-builder',
    '--env', 'CARGO_HOME=/cargo',
    '--env', 'RUSTUP_HOME=/rustup',
    '--volume', `${root}:/work`,
    '--volume', `${cargoHome}:/cargo`,
    '--volume', `${rustupHome}:/rustup:ro`,
    '--workdir', '/work',
    builder.image,
    '/bin/bash', '-lc',
    'CARGO_TARGET_DIR=/work/native/windows-text-transaction/target-manylinux-2.28 '
      + `/cargo/bin/cargo +${rustToolchain} build --release --locked `
      + '--manifest-path native/windows-text-transaction/Cargo.toml '
      + `--target ${builder.target}`,
  ]);
  process.stdout.write(
    `[build-linux-native] built ${builder.target} with ${builder.image}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `[build-linux-native] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
