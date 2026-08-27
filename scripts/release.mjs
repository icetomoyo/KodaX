#!/usr/bin/env node
// FEATURE_150 (v0.7.37) — single-bundle npm release for @kodax-ai/kodax.
//
// Replaces:
//   - scripts/release-npm.mjs        (multi-package publish — deleted)
//   - scripts/publish-root-cli.mjs   (root-cli structural rewrite — folded in)
//
// Why one script now: ADR-022 — npm distribution is a single bundle. There
// is no longer a multi-package dependency-order publish to orchestrate.
//
// Usage:
//   node scripts/release.mjs --dry-run    # full sweep, no real publish
//   node scripts/release.mjs              # real publish (irreversible)
//   node scripts/release.mjs --otp=123456 # pass OTP for npm 2FA
//   node scripts/release.mjs --skip-build # assume dist/ is already built (advanced)
//   node scripts/release.mjs --pack-only  # produce kodax-ai-kodax-<v>.tgz at repo root
//                                         # for local `npm install <path>` SDK consumer testing
//                                         # (no publish; package.json restored via try/finally)
//
// Steps:
//   1. Verify git is clean (no uncommitted changes).
//   2. Build sub-package dist/ via `npm run build:packages` (esbuild needs them).
//   3. Build root bundle via `npm run build:bundle`.
//   4. Toggle root package.json `private: true` → `private: false` so npm
//      will accept the publish. Capture pristine bytes for restore.
//      Name / exports / bin / publishConfig are NOT rewritten — root
//      package.json is already in published shape (v0.7.43 SDK consumer
//      `npm link` ergonomics: name=@kodax-ai/kodax, all SDK subpath
//      exports baked in, bin path published-clean). See ADR-024.
//   5. Pack and audit the exact candidate archive, then publish that same
//      tarball (or stop after pack / run npm's dry-run).
//   6. Restore pristine package.json bytes — re-asserts `private: true`
//      so the dev tree cannot be accidentally re-published bare.
//
// Idempotent failure mode: pristine bytes are captured BEFORE any mutation;
// restore writes them back verbatim even if npm publish throws.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSidecarTarball } from './audit-sidecar-tarball.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const rootPkgPath = path.join(repoRoot, 'package.json');

// ---- argv ----
const argv = process.argv.slice(2);
const isDryRun = argv.includes('--dry-run');
const skipBuild = argv.includes('--skip-build');
const packOnly = argv.includes('--pack-only');
const otpArg = argv.find((a) => a.startsWith('--otp='));
const otp = otpArg ? otpArg.split('=')[1] : null;

function log(msg) {
  console.log(`[release] ${msg}`);
}

function logError(msg) {
  console.error(`[release] ERROR ${msg}`);
}

function runCmd(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
    ...opts,
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with code ${result.status}`);
  }
}

function listJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

function assertNoRawAgentDynamicImport(dir) {
  const directAgentImportPattern = /\bimport\(\s*(['"])\.\/agent\.js\1\s*\)/;
  const computedAgentImportPattern =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])\.\/agent\.js\2[\s\S]{0,500}?\bimport\(\s*\1\s*\)/;
  const violations = [];

  for (const file of listJsFiles(dir)) {
    const source = readFileSync(file, 'utf8');
    if (directAgentImportPattern.test(source) || computedAgentImportPattern.test(source)) {
      violations.push(path.relative(repoRoot, file));
    }
  }

  if (violations.length > 0) {
    for (const file of violations) {
      logError(`raw ./agent.js dynamic import found in ${file}`);
    }
    throw new Error('dist contains a raw dynamic import of ./agent.js; rebuild before publishing');
  }
}

function assertSemanticWorkerSidecar(dir) {
  if (!existsSync(path.join(dir, 'semantic-worker.js'))) {
    throw new Error('dist/semantic-worker.js missing; repo-intelligence full mode would silently fall back in published builds');
  }
}

function assertNativeArtifacts(dir) {
  const platforms = [
    ['win32', 'x64', 'kodax-windows-text-transaction.node'],
    ['linux', 'x64', 'kodax-text-transaction.node'],
    ['linux', 'arm64', 'kodax-text-transaction.node'],
    ['darwin', 'x64', 'kodax-text-transaction.node'],
    ['darwin', 'arm64', 'kodax-text-transaction.node'],
  ];
  for (const [platform, arch, textFilename] of platforms) {
    const nativeDirectory = path.join(dir, 'native', `${platform}-${arch}`);
    const manifestPath = path.join(nativeDirectory, 'manifest.json');
    if (!existsSync(manifestPath)) {
      throw new Error(`${manifestPath} is missing; npm publish requires every supported native text authority`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== 1 || manifest.platform !== platform || manifest.arch !== arch) {
      throw new Error(`${platform}-${arch} native manifest has an incompatible platform or version`);
    }
    const expectedLegalFiles = [
      'LICENSE-APACHE.txt',
      ...(platform === 'win32' ? ['NOTICE-windows-sandbox.txt'] : []),
    ];
    if (!Array.isArray(manifest.legal) || manifest.legal.length !== expectedLegalFiles.length) {
      throw new Error(`${platform}-${arch} native legal manifest is missing or incompatible`);
    }
    for (const filename of expectedLegalFiles) {
      const entry = manifest.legal.find((candidate) => candidate?.file === filename);
      const legalFile = path.join(nativeDirectory, filename);
      if (
        !entry
        || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')
        || !existsSync(legalFile)
        || createHash('sha256').update(readFileSync(legalFile)).digest('hex') !== entry.sha256
      ) {
        throw new Error(`${platform}-${arch} native legal file ${filename} is missing or invalid`);
      }
    }
    if (platform === 'win32') {
      const packageName = '@anthropic-ai/sandbox-runtime';
      const rootPackage = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
      const pinnedVersion = rootPackage.dependencies?.[packageName];
      const installedRoot = path.join(
        repoRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime',
      );
      const installedPackage = JSON.parse(readFileSync(
        path.join(installedRoot, 'package.json'),
        'utf8',
      ));
      const asrtRunner = manifest.asrtRunner;
      const asrtRunnerPath = path.join(
        installedRoot, 'vendor', 'srt-win', arch, 'srt-win.exe',
      );
      if (
        typeof pinnedVersion !== 'string'
        || !/^\d+\.\d+\.\d+$/.test(pinnedVersion)
        || asrtRunner?.file !== 'srt-win.exe'
        || asrtRunner.version !== pinnedVersion
        || installedPackage.version !== asrtRunner.version
        || !/^[0-9a-f]{64}$/.test(asrtRunner.sha256 ?? '')
        || !existsSync(asrtRunnerPath)
      ) {
        throw new Error('Windows ASRT runner is missing or incompatible with its native manifest');
      }
      const actual = createHash('sha256').update(readFileSync(asrtRunnerPath)).digest('hex');
      if (actual !== asrtRunner.sha256) {
        throw new Error('ASRT runner hash does not match its manifest');
      }
    }
    const expected = [
      ['textTransaction', 4, textFilename],
      ...(platform === 'win32'
        ? [['shellSandbox', 7, 'kodax-windows-sandbox.exe']]
        : []),
    ];
    for (const [kind, protocol, filename] of expected) {
      const entry = manifest[kind];
      const artifact = path.join(nativeDirectory, filename);
      if (
        entry?.file !== filename
        || entry?.protocol !== protocol
        || !/^[0-9a-f]{64}$/.test(entry?.sha256 ?? '')
        || !existsSync(artifact)
      ) {
        throw new Error(`${platform}-${arch} native ${kind} artifact is missing or incompatible`);
      }
      const actual = createHash('sha256').update(readFileSync(artifact)).digest('hex');
      if (actual !== entry.sha256) {
        throw new Error(`${platform}-${arch} native ${kind} artifact hash does not match its manifest`);
      }
    }
  }
}

function gitIsClean() {
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return result.status === 0 && result.stdout.trim() === '';
}

// ---- root package.json toggle for publish -------------------------------

function toggleRootPackageJsonForPublish() {
  const rawBytes = readFileSync(rootPkgPath, 'utf8');
  const pkg = JSON.parse(rawBytes);

  // Sanity: published shape is now the source-of-truth. Catch accidental
  // dev-tree drift before npm sees it.
  if (pkg.name !== '@kodax-ai/kodax') {
    throw new Error(
      `root package.json#name expected "@kodax-ai/kodax" (published shape), got ${JSON.stringify(pkg.name)} — refuse to publish`,
    );
  }
  if (!pkg.exports || typeof pkg.exports !== 'object' || !pkg.exports['./agent']) {
    throw new Error(
      'root package.json#exports is missing SDK subpath entries — refuse to publish (would ship a broken tarball)',
    );
  }
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    throw new Error(
      'root package.json#files is missing or empty — refuse to publish (would tarball the whole monorepo)',
    );
  }

  // The ONLY mutation: flip `private: true → false` so npm accepts the
  // publish. Restore via try/finally guarantees the dev tree returns to
  // `private: true` and cannot be accidentally re-published bare.
  pkg.private = false;

  writeFileSync(rootPkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  return rawBytes; // for restore
}

function restoreRootPackageJson(rawBytes) {
  writeFileSync(rootPkgPath, rawBytes, 'utf8');
}

// ---- package-lock version sync guard -------------------------------------
//
// package-lock.json must agree with package.json on the release version —
// both the root and every workspace entry. A stale lock (e.g. the whole lock
// frozen one version behind) ships a tarball whose recorded version
// disagrees with the package, a low-level defect that has slipped through
// before. Returns the list of mismatches so the caller can decide whether to
// hard-fail (real publish) or warn (dry-run / pack-only).
function findPackageLockVersionMismatches(version) {
  const lockPath = path.join(repoRoot, 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const mismatches = [];
  if (lock.version !== version) {
    mismatches.push(`package-lock.json#version is ${JSON.stringify(lock.version)}`);
  }
  const entries = lock.packages ?? {};
  for (const [key, entry] of Object.entries(entries)) {
    // Only the root ("") and in-repo workspace packages carry a version we
    // own; external deps under node_modules/* are pinned independently.
    const isWorkspace = key === '' || (key.startsWith('packages/') && !key.includes('node_modules'));
    if (!isWorkspace || !entry || typeof entry.version !== 'string') continue;
    if (entry.version !== version) {
      mismatches.push(`package-lock.json#packages[${JSON.stringify(key)}].version is ${JSON.stringify(entry.version)}`);
    }
  }
  return mismatches;
}

// ---- main ----------------------------------------------------------------

function main() {
  // Sanity: git clean (uncommitted changes risk shipping unexpected dist).
  // Hard fail for real publish; warn-only for dry-run / pack-only (so
  // operators can still produce a local tarball or validate the pipeline
  // mid-edit, but get a visible reminder).
  if (!gitIsClean()) {
    if (isDryRun || packOnly) {
      log('WARNING: git working tree is not clean. Operation will proceed but real publish would refuse.');
    } else {
      logError('git working tree is not clean. Commit or stash first, then retry.');
      process.exit(1);
    }
  }

  const pkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
  const version = pkg.version;

  log(`Version: ${version}`);
  log(`Mode: ${packOnly ? 'PACK-ONLY (local tarball for SDK consumer testing)' : isDryRun ? 'DRY RUN' : 'REAL PUBLISH (irreversible)'}`);
  log('');

  // Sanity: package-lock must agree with package.json on the version (root +
  // every workspace entry). Hard fail for real publish; warn-only for
  // dry-run / pack-only so operators can still validate the pipeline mid-edit.
  const lockMismatches = findPackageLockVersionMismatches(version);
  if (lockMismatches.length > 0) {
    const detail = `package-lock.json is out of sync with package.json@${version}: ${lockMismatches.join('; ')}. Run \`npm install --package-lock-only\` and commit the lock.`;
    if (isDryRun || packOnly) {
      log(`WARNING: ${detail} Real publish would refuse.`);
    } else {
      logError(detail);
      process.exit(1);
    }
  }

  // Step 1: build sub-packages, esbuild bundle, and root .d.ts.
  // `npm run build` is the single safe entry — it chains
  // build:packages → build:bundle → `tsc --emitDeclarationOnly`. The
  // trailing tsc step adds dist/*.d.ts WITHOUT touching dist/*.js
  // (--emitDeclarationOnly is the critical guard — plain `tsc` would
  // overwrite the esbuild bundle with unbundled tsc output and ship
  // a broken tarball).
  if (!skipBuild) {
    log('-- npm run build (packages + esbuild bundle + .d.ts)');
    runCmd('npm', ['run', 'build']);
  } else {
    log('-- --skip-build: assuming dist/ is already current');
  }
  assertNoRawAgentDynamicImport(path.join(repoRoot, 'dist'));
  assertSemanticWorkerSidecar(path.join(repoRoot, 'dist'));
  assertNativeArtifacts(path.join(repoRoot, 'dist'));
  log('-- bundle import, worker sidecar, and cross-platform native artifact guards passed');

  // Step 3: toggle private:true → false (root package.json is already in
  // published shape; this is the only mutation needed).
  log('-- toggling root package.json#private: true → false (will restore via try/finally)');
  const pristineBytes = toggleRootPackageJsonForPublish();

  // Step 4: pack and audit the exact publish bytes, then optionally publish
  // that same tarball. Restore package.json in all cases.
  try {
    const tarballPath = path.join(repoRoot, `kodax-ai-kodax-${version}.tgz`);
    // Consumer flow: `npm install /abs/path/to/kodax-ai-kodax-<version>.tgz`.
    // Real publish also uses this exact audited archive, eliminating drift
    // between SDK validation bytes and registry bytes.
    log('-- npm pack (exact candidate bytes)');
    runCmd('npm', ['pack']);
    auditSidecarTarball(tarballPath, {
      requiredEntries: [
        'package/dist/native/win32-x64/manifest.json',
        'package/dist/native/win32-x64/kodax-windows-text-transaction.node',
        'package/dist/native/win32-x64/kodax-windows-sandbox.exe',
        'package/dist/native/linux-x64/manifest.json',
        'package/dist/native/linux-x64/kodax-text-transaction.node',
        'package/dist/native/linux-arm64/manifest.json',
        'package/dist/native/linux-arm64/kodax-text-transaction.node',
        'package/dist/native/darwin-x64/manifest.json',
        'package/dist/native/darwin-x64/kodax-text-transaction.node',
        'package/dist/native/darwin-arm64/manifest.json',
        'package/dist/native/darwin-arm64/kodax-text-transaction.node',
      ],
    });
    log('-- ✓ npm pack + Sidecar tarball audit succeeded');

    if (!packOnly) {
      // Force official npm registry — repo .npmrc pins npmmirror for fast
      // dev installs, but publish must always go to registry.npmjs.org.
      const args = [
        'publish',
        tarballPath,
        '--registry=https://registry.npmjs.org/',
      ];
      if (isDryRun) args.push('--dry-run');
      if (otp) args.push(`--otp=${otp}`);
      log(`-- npm ${args.join(' ')}`);
      runCmd('npm', args);
      log('-- ✓ npm publish succeeded');
    }
  } finally {
    log('-- restoring root package.json (pristine bytes)');
    restoreRootPackageJson(pristineBytes);
  }

  log('');
  if (packOnly) {
    log(`Tarball produced: kodax-ai-kodax-${version}.tgz`);
    log(`Consumer install: npm install ${path.join(repoRoot, `kodax-ai-kodax-${version}.tgz`)}`);
  } else if (isDryRun) {
    log('Dry run complete. Nothing was actually published.');
  } else {
    log(`Published @kodax-ai/kodax@${version}.`);
    log(`Verify: npm view @kodax-ai/kodax@${version} version --registry=https://registry.npmjs.org/`);
    log('(Registry propagation can take 30-120s.)');
  }
}

try {
  main();
} catch (err) {
  logError(err.stack || err.message);
  process.exit(1);
}
