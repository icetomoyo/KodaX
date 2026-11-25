import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rustToolchain = '1.98.0';
/** The crates built at the glibc 2.17 floor; the first is the default. */
const crates = ['windows-text-transaction', 'repo-intel'];
const builders = {
  x64: {
    image: 'quay.io/pypa/manylinux2014_x86_64@sha256:62eeff30ef134a85ec0f97109e008a319b0315ca5e8a6d754ee771556c02622a',
    target: 'x86_64-unknown-linux-gnu',
  },
  arm64: {
    image: 'quay.io/pypa/manylinux2014_aarch64@sha256:101d2292840109c9d329fcfcd7b89b46f59e19ca23cbfdcf059fb389994665fc',
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
    throw new Error('The glibc 2.17 native builder must run on Linux.');
  }
  const crate = process.argv[2] ?? crates[0];
  if (!crates.includes(crate)) {
    throw new Error(`Unknown native crate: ${crate}. Expected one of ${crates.join(', ')}.`);
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
    `CARGO_TARGET_DIR=/work/native/${crate}/target-manylinux-2.17 `
      + `/cargo/bin/cargo +${rustToolchain} build --release --locked `
      + `--manifest-path native/${crate}/Cargo.toml `
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
