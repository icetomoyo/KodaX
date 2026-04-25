#!/usr/bin/env node
/**
 * KodaX standalone binary build script (Bun --compile).
 *
 * Produces a sidecar layout under `dist/binary/<target>/`:
 *
 *   dist/binary/linux-x64/
 *     kodax              ← Bun-compiled standalone executable
 *     builtin/           ← @kodax/skills built-in skill assets
 *
 * Usage:
 *   node scripts/build-binary.mjs                    # current platform
 *   node scripts/build-binary.mjs --target=linux-x64 # specific platform
 *   node scripts/build-binary.mjs --all              # all 5 supported targets
 *   node scripts/build-binary.mjs --skip-tsc         # reuse existing dist/
 *   node scripts/build-binary.mjs --clean            # wipe dist/binary/ first
 *
 * Build-time defines (baked into the binary):
 *   process.env.NODE_ENV     = 'production'   → React strips dev-only code
 *   process.env.KODAX_BUNDLED= 'true'         → enables sidecar path resolution
 *   process.env.KODAX_VERSION= '<x.y.z>'      → kodax --version source of truth
 *
 * Prerequisites:
 *   - Bun installed and on PATH (`scoop install bun` / `npm i -g bun` /
 *     `curl -fsSL https://bun.sh/install | bash`)
 *   - npm workspaces installed (`npm ci` at repo root)
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'dist', 'kodax_cli.js');
const BUILTIN_SRC = join(ROOT, 'packages', 'skills', 'dist', 'builtin');
const OUT_ROOT = join(ROOT, 'dist', 'binary');

const TARGETS = {
  'win-x64':      { bun: 'bun-windows-x64',     ext: '.exe' },
  'linux-x64':    { bun: 'bun-linux-x64',       ext: ''     },
  'linux-arm64':  { bun: 'bun-linux-arm64',     ext: ''     },
  'darwin-x64':   { bun: 'bun-darwin-x64',      ext: ''     },
  'darwin-arm64': { bun: 'bun-darwin-arm64',    ext: ''     },
};

function parseCliArgs() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      target:     { type: 'string' },
      all:        { type: 'boolean', default: false },
      'skip-tsc': { type: 'boolean', default: false },
      clean:      { type: 'boolean', default: false },
      help:       { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return values;
}

function printHelpAndExit() {
  console.log(`KodaX binary build

Usage:
  node scripts/build-binary.mjs [options]

Options:
  --target=<name>   Build a single target. One of:
                      ${Object.keys(TARGETS).join(', ')}
  --all             Build all supported targets in sequence.
  --skip-tsc        Skip 'npm run build' (assume dist/ already up to date).
  --clean           Remove dist/binary/ before building.
  -h, --help        Show this help.

Default (no --target / --all): build for the current host platform only.
`);
  process.exit(0);
}

function detectCurrentTarget() {
  const key = `${process.platform}-${process.arch}`;
  const map = {
    'win32-x64':   'win-x64',
    'linux-x64':   'linux-x64',
    'linux-arm64': 'linux-arm64',
    'darwin-x64':  'darwin-x64',
    'darwin-arm64':'darwin-arm64',
  };
  const target = map[key];
  if (!target) {
    throw new Error(`Unsupported host platform/arch: ${key}. Pass --target explicitly.`);
  }
  return target;
}

function readVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (!pkg.version) {
    throw new Error('Root package.json has no "version" field');
  }
  return pkg.version;
}

function ensureBunAvailable() {
  const probe = spawnSync('bun', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (probe.status !== 0) {
    console.error('error: `bun` not found on PATH.');
    console.error('Install Bun first:');
    console.error('  Windows:  scoop install bun   (or `npm i -g bun`)');
    console.error('  macOS:    brew install bun    (or `npm i -g bun`)');
    console.error('  Linux:    curl -fsSL https://bun.sh/install | bash');
    process.exit(1);
  }
  return probe.stdout.trim();
}

function runStep(label, cmd, args, opts = {}) {
  console.log(`\n==> ${label}`);
  console.log(`    $ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (res.status !== 0) {
    throw new Error(`Step failed: ${label} (exit ${res.status})`);
  }
}

function buildOne(target, version) {
  const spec = TARGETS[target];
  if (!spec) {
    throw new Error(`Unknown target: ${target}. Valid: ${Object.keys(TARGETS).join(', ')}`);
  }

  const outDir = join(OUT_ROOT, target);
  const binaryName = `kodax${spec.ext}`;
  const binaryPath = join(outDir, binaryName);

  // Reset target dir so each build is hermetic (avoids stale builtin/ across runs).
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 1. Bun --compile
  runStep(
    `bun compile → ${target}`,
    'bun',
    [
      'build',
      ENTRY,
      '--compile',
      `--target=${spec.bun}`,
      '--minify',
      '--sourcemap=none',
      `--define`, `process.env.NODE_ENV="production"`,
      `--define`, `process.env.KODAX_BUNDLED="true"`,
      `--define`, `process.env.KODAX_VERSION="${version}"`,
      '--outfile', binaryPath,
    ],
  );

  // 2. Sidecar builtin/ (skill assets resolved by KODAX_BUNDLED branch at runtime)
  if (!existsSync(BUILTIN_SRC)) {
    throw new Error(
      `Missing ${BUILTIN_SRC}. Did you run 'npm run build' (which runs copy:builtin)?`,
    );
  }
  cpSync(BUILTIN_SRC, join(outDir, 'builtin'), { recursive: true });

  console.log(`    ✓ ${target}: ${binaryPath}`);
}

async function main() {
  const args = parseCliArgs();
  if (args.help) printHelpAndExit();

  // Mutually exclusive: --target and --all.
  if (args.target && args.all) {
    console.error('error: --target and --all are mutually exclusive');
    process.exit(2);
  }

  const targets = args.all
    ? Object.keys(TARGETS)
    : [args.target || detectCurrentTarget()];

  for (const t of targets) {
    if (!TARGETS[t]) {
      console.error(`error: unknown target "${t}". Valid: ${Object.keys(TARGETS).join(', ')}`);
      process.exit(2);
    }
  }

  const bunVersion = ensureBunAvailable();
  const version = readVersion();

  console.log(`KodaX binary build`);
  console.log(`  version : ${version}`);
  console.log(`  bun     : ${bunVersion}`);
  console.log(`  targets : ${targets.join(', ')}`);
  console.log(`  out     : ${OUT_ROOT}`);

  if (args.clean) {
    console.log(`\n==> cleaning ${OUT_ROOT}`);
    rmSync(OUT_ROOT, { recursive: true, force: true });
  }

  // Workspace TS build → produces dist/kodax_cli.js + packages/*/dist + skills/dist/builtin
  if (!args['skip-tsc']) {
    runStep('npm run build (workspaces + root tsc + copy:builtin)', 'npm', ['run', 'build']);
  } else if (!existsSync(ENTRY)) {
    throw new Error(`--skip-tsc set but ${ENTRY} missing. Run 'npm run build' first.`);
  }

  for (const target of targets) {
    buildOne(target, version);
  }

  console.log(`\n✓ build complete → ${OUT_ROOT}`);
  console.log(`  Smoke-test (host platform only):`);
  const hostTarget = (() => { try { return detectCurrentTarget(); } catch { return null; } })();
  if (hostTarget && targets.includes(hostTarget)) {
    const ext = TARGETS[hostTarget].ext;
    console.log(`    ${join(OUT_ROOT, hostTarget, `kodax${ext}`)} --version`);
  }
}

main().catch((err) => {
  console.error(`\nbuild failed: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
