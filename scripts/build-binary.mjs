#!/usr/bin/env node
/**
 * KodaX standalone binary build script (Bun --compile).
 *
 * Produces a sidecar layout under `dist/binary/<target>/`:
 *
 *   dist/binary/linux-x64/
 *     kodax              ← Bun-compiled standalone executable
 *     builtin/           ← built-in skill assets (post-F194 v0.7.43:
 *                          packages/agent/dist/capabilities/skills/builtin/)
 *     provider-capabilities.json
 *     semantic-worker.js
 *     runtime-worker.js
 *     constructed-handler-worker.js
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

import { execFile, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'dist', 'kodax_bootstrap.js');
const WORKER_SIDECAR = join(ROOT, 'dist', 'semantic-worker.js');
const RUNTIME_WORKER_SIDECAR = join(ROOT, 'dist', 'runtime-worker.js');
const HANDLER_WORKER_SIDECAR = join(ROOT, 'dist', 'constructed-handler-worker.js');
// Post-FEATURE_194 (v0.7.43) — `@kodax-ai/skills` was inlined into
// `packages/agent/src/capabilities/skills/`; `copy:builtin` workspace
// script (run by `npm run build:packages`) emits builtin assets to
// `packages/agent/dist/capabilities/skills/builtin/`.
const BUILTIN_SRC = join(ROOT, 'packages', 'agent', 'dist', 'capabilities', 'skills', 'builtin');
const OUT_ROOT = join(ROOT, 'dist', 'binary');
const REQUIRED_BUNDLED_PROVIDER_PACKAGES = [
  '@anthropic-ai/sdk',
  'standardwebhooks',
  'openai',
];

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

function verifyBundledProviderPackages(metadataPath) {
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  const inputPaths = Object.keys(metadata.inputs ?? {})
    .map((inputPath) => inputPath.replaceAll('\\', '/'));
  const missingPackages = REQUIRED_BUNDLED_PROVIDER_PACKAGES.filter((packageName) => {
    const packagePath = `node_modules/${packageName}/`;
    return !inputPaths.some((inputPath) => (
      inputPath.startsWith(packagePath) || inputPath.includes(`/${packagePath}`)
    ));
  });
  rmSync(metadataPath, { force: true });
  if (missingPackages.length > 0) {
    throw new Error(
      `Standalone binary is missing bundled provider dependencies: ${missingPackages.join(', ')}`,
    );
  }
  process.stdout.write('    ✓ bundled provider SDK dependencies\n');
}

function runCapturedCommand(command, args, options) {
  return new Promise((resolveResult, rejectResult) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error?.killed || error?.signal) {
        rejectResult(error);
        return;
      }
      resolveResult({ status: error?.code ?? 0, stdout, stderr });
    });
  });
}

async function startProviderSmokeServer(requestPaths) {
  const server = createServer((request, response) => {
    requestPaths.push(request.url ?? '');
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: 'binary provider smoke' },
    }));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Standalone provider smoke failed to allocate a loopback port.');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function verifyProviderRuntimeProbe(binaryPath, smokeHome, provider, requestPaths) {
  const requestCountBefore = requestPaths.length;
  const result = await runCapturedCommand(
    binaryPath,
    ['-p', 'ping', '-m', provider.name, '--no-session', '--max-iter', '1'],
    {
      cwd: dirname(binaryPath),
      encoding: 'utf8',
      env: {
        ...process.env,
        KODAX_HOME: smokeHome,
        KODAX_TRACING: '0',
        [provider.apiKeyEnv]: 'binary-smoke-key',
      },
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  if (/Cannot find (?:module|package)/i.test(output)) {
    throw new Error(`Standalone ${provider.protocol} SDK load failed:\n${output.trim()}`);
  }
  if (requestPaths.length === requestCountBefore) {
    throw new Error(
      `Standalone ${provider.protocol} SDK smoke did not reach the loopback server `
      + `(exit ${result.status}):\n${output.trim()}`,
    );
  }
}

async function verifyBundledProviderRuntime(binaryPath, smokeHome) {
  const requestPaths = [];
  const { server, baseUrl } = await startProviderSmokeServer(requestPaths);

  try {
    const providers = [
      {
        name: 'binary-smoke-anthropic',
        protocol: 'anthropic',
        baseUrl,
        apiKeyEnv: 'KODAX_BINARY_SMOKE_ANTHROPIC_KEY',
        model: 'smoke-model',
      },
      {
        name: 'binary-smoke-openai',
        protocol: 'openai',
        baseUrl: `${baseUrl}/v1`,
        apiKeyEnv: 'KODAX_BINARY_SMOKE_OPENAI_KEY',
        model: 'smoke-model',
      },
    ];
    writeFileSync(
      join(smokeHome, 'config.json'),
      JSON.stringify({ customProviders: providers }),
      'utf8',
    );

    for (const provider of providers) {
      await verifyProviderRuntimeProbe(binaryPath, smokeHome, provider, requestPaths);
    }
    process.stdout.write('    ✓ standalone smoke: bundled Anthropic and OpenAI SDK runtime\n');
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
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
  const metadataPath = join(outDir, 'bun-build-metadata.json');

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
      // Single-quoted JS string literals are used for the values because
      // double-quoted strings get their inner `"` stripped when passed
      // through Node's spawnSync → Windows CreateProcess arg pipeline,
      // leaving bun to substitute the bare identifier (e.g. `production`)
      // and producing a runtime "ReferenceError: production is not defined"
      // at first import. Single quotes survive the round-trip intact.
      `--define`, `process.env.NODE_ENV='production'`,
      `--define`, `process.env.KODAX_BUNDLED='true'`,
      `--define`, `process.env.KODAX_MODULE_BUNDLE='true'`,
      `--define`, `process.env.KODAX_VERSION='${version}'`,
      `--metafile=${metadataPath}`,
      '--outfile', binaryPath,
    ],
  );
  verifyBundledProviderPackages(metadataPath);

  // 2. Sidecar builtin/ (skill assets resolved by KODAX_BUNDLED branch at runtime)
  if (!existsSync(BUILTIN_SRC)) {
    throw new Error(
      `Missing ${BUILTIN_SRC}. Did you run 'npm run build' (which runs copy:builtin)?`,
    );
  }
  cpSync(BUILTIN_SRC, join(outDir, 'builtin'), { recursive: true });

  // 3. Sidecar provider-capabilities.json (FEATURE_198 v0.7.44)
  //
  // The capability JSON is read at runtime via fs.readFileSync — under
  // KODAX_BUNDLED='true' the loader resolves to `dirname(process.execPath)
  // + 'provider-capabilities.json'`. Same sidecar pattern as builtin/.
  // Embedders / advanced users can edit this JSON in-place to patch
  // capability metadata without rebuilding the binary.
  const capJsonSrc = join(ROOT, 'packages', 'llm', 'src', 'providers', 'provider-capabilities.json');
  if (!existsSync(capJsonSrc)) {
    throw new Error(`Missing ${capJsonSrc}.`);
  }
  cpSync(capJsonSrc, join(outDir, 'provider-capabilities.json'));

  // 4. Sidecar repo-intelligence worker. The compiled binary cannot load a
  // worker from inside its single executable image; semantic-worker-client
  // resolves this file next to process.execPath when KODAX_BUNDLED=true.
  if (!existsSync(WORKER_SIDECAR)) {
    throw new Error(`Missing ${WORKER_SIDECAR}. Run 'npm run build' first.`);
  }
  cpSync(WORKER_SIDECAR, join(outDir, 'semantic-worker.js'));
  for (const [source, filename] of [
    [RUNTIME_WORKER_SIDECAR, 'runtime-worker.js'],
    [HANDLER_WORKER_SIDECAR, 'constructed-handler-worker.js'],
  ]) {
    if (!existsSync(source)) {
      throw new Error(`Missing ${source}. Run 'npm run build' first.`);
    }
    cpSync(source, join(outDir, filename));
  }

  // 5. Sidecar vendor/srt-win/<arch>/srt-win.exe (Windows only).
  //
  // The ASRT library locates srt-win.exe relative to its module URL; inside a
  // Bun --compile binary that resolves onto the virtual B:\ drive and never
  // exists, so every sandboxed operation (and `sandbox doctor`/`setup`)
  // reports the backend unavailable. resolveSrtWinSourcePath() in
  // src/sandbox-runtime.ts reads this sidecar next to the executable instead.
  if (target.startsWith('win-')) {
    const srtWinArch = target.endsWith('x64') ? 'x64' : 'arm64';
    const srtWinSrc = join(
      ROOT, 'node_modules', '@anthropic-ai', 'sandbox-runtime',
      'vendor', 'srt-win', srtWinArch, 'srt-win.exe',
    );
    if (!existsSync(srtWinSrc)) {
      throw new Error(`Missing ${srtWinSrc}. Run 'npm install' first.`);
    }
    const srtWinDir = join(outDir, 'vendor', 'srt-win', srtWinArch);
    mkdirSync(srtWinDir, { recursive: true });
    cpSync(srtWinSrc, join(srtWinDir, 'srt-win.exe'));
  }

  console.log(`    ✓ ${target}: ${binaryPath}`);
}

async function verifyHostBinary(binaryPath) {
  const smokeHome = mkdtempSync(join(tmpdir(), 'kodax-binary-smoke-'));
  try {
    const packageDir = join(smokeHome, 'package');
    cpSync(dirname(binaryPath), packageDir, { recursive: true });
    const smokeBinaryPath = join(packageDir, basename(binaryPath));
    const result = spawnSync(smokeBinaryPath, ['a2a', 'list'], {
      cwd: packageDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        KODAX_HOME: smokeHome,
        KODAX_TRACING: '0',
      },
      timeout: 60_000,
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `Standalone smoke failed (exit ${result.status}): ${result.stderr.trim()}`,
      );
    }

    let document;
    try {
      document = JSON.parse(result.stdout.trim());
    } catch {
      throw new Error('Standalone smoke must emit exactly one JSON document.');
    }
    if (
      document === null
      || typeof document !== 'object'
      || Array.isArray(document)
      || document.version !== 2
      || document.agents === null
      || typeof document.agents !== 'object'
      || Array.isArray(document.agents)
    ) {
      throw new Error('Standalone smoke emitted an invalid A2A list document.');
    }
    console.log(`    ✓ standalone smoke: one A2A v2 document`);

    const bunChildResult = spawnSync(smokeBinaryPath, [
      '-e',
      'process.stdout.write("kodax-bun-child")',
    ], {
      cwd: packageDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        BUN_BE_BUN: '1',
      },
      timeout: 60_000,
      windowsHide: true,
    });
    if (bunChildResult.error) throw bunChildResult.error;
    if (
      bunChildResult.status !== 0
      || bunChildResult.stdout !== 'kodax-bun-child'
    ) {
      throw new Error(
        `Standalone Bun child smoke failed (exit ${bunChildResult.status}): `
        + `${bunChildResult.stderr.trim()}\n${bunChildResult.stdout.trim()}`,
      );
    }
    console.log(`    ✓ standalone smoke: JavaScript child Bun mode`);

    const skillResult = spawnSync(smokeBinaryPath, [
      'skill',
      'validate',
      join(packageDir, 'builtin', 'skill-creator'),
    ], {
      cwd: packageDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        KODAX_HOME: smokeHome,
        KODAX_TRACING: '0',
      },
      timeout: 60_000,
      windowsHide: true,
    });
    if (skillResult.error) throw skillResult.error;
    if (
      skillResult.status !== 0
      || !skillResult.stdout.includes('Skill is valid.')
    ) {
      throw new Error(
        `Standalone skill dispatcher smoke failed (exit ${skillResult.status}): `
        + `${skillResult.stderr.trim()}\n${skillResult.stdout.trim()}`,
      );
    }
    console.log(`    ✓ standalone smoke: bundled skill dispatcher`);

    const packagePath = join(smokeHome, 'skill-creator.skill');
    const packageResult = spawnSync(smokeBinaryPath, [
      'skill',
      'package',
      join(packageDir, 'builtin', 'skill-creator'),
      '--output',
      packagePath,
    ], {
      cwd: packageDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        KODAX_HOME: smokeHome,
        KODAX_TRACING: '0',
      },
      timeout: 60_000,
      windowsHide: true,
    });
    if (packageResult.error) throw packageResult.error;
    if (
      packageResult.status !== 0
      || !existsSync(packagePath)
      || readFileSync(packagePath).byteLength === 0
    ) {
      throw new Error(
        `Standalone skill package smoke failed (exit ${packageResult.status}): `
        + `${packageResult.stderr.trim()}\n${packageResult.stdout.trim()}`,
      );
    }
    console.log(`    ✓ standalone smoke: bundled YAML and fflate dependencies`);
    await verifyBundledProviderRuntime(smokeBinaryPath, smokeHome);
  } finally {
    rmSync(smokeHome, { recursive: true, force: true });
  }
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

  // Workspace build produces bootstrap/full CLI bundles, package dist, and built-in assets.
  if (!args['skip-tsc']) {
    runStep('npm run build (workspaces + root tsc + copy:builtin)', 'npm', ['run', 'build']);
  } else if (!existsSync(ENTRY)) {
    throw new Error(`--skip-tsc set but ${ENTRY} missing. Run 'npm run build' first.`);
  }

  for (const target of targets) {
    buildOne(target, version);
  }

  const hostTarget = (() => { try { return detectCurrentTarget(); } catch { return null; } })();
  if (hostTarget && targets.includes(hostTarget)) {
    const ext = TARGETS[hostTarget].ext;
    await verifyHostBinary(join(OUT_ROOT, hostTarget, `kodax${ext}`));
  }
  console.log(`\n✓ build complete → ${OUT_ROOT}`);
}

main().catch((err) => {
  console.error(`\nbuild failed: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
