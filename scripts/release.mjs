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
// FEATURE_295 (v0.7.96): the package embeds prebuilt native authorities for
// five platforms, and Rust artifacts must be compiled on their target
// OS/arch — a single machine can never assemble the universal tarball. The
// publishable bytes are therefore built by the Release workflow (tag push →
// five platform runners → npm-package job) and attached to the GitHub
// Release; this script fetches those exact audited bytes for publishing.
//
// Usage:
//   node scripts/release.mjs              # real publish (irreversible):
//                                          # download the CI-built universal tarball
//                                          # from the GitHub Release for v<version>,
//                                          # verify sha256 + sidecar audit, then
//                                          # npm publish those exact bytes. Requires
//                                          # tag v<version> pushed and the Release
//                                          # workflow green.
//   node scripts/release.mjs --dry-run    # same download + verification, publish --dry-run
//   node scripts/release.mjs --otp=123456 # pass OTP for npm 2FA
//   node scripts/release.mjs --pack-only  # local `npm install <path>` SDK consumer
//                                          # testing tarball at repo root (no publish).
//                                          # All five authorities present (CI): the
//                                          # audited universal publish candidate.
//                                          # Host authority only (local machine): a
//                                          # LOCAL TEST TARBALL that keeps private:true,
//                                          # so npm refuses to publish it.
//   node scripts/release.mjs --skip-build --pack-only
//                                         # assume dist/ is already built (advanced)
//
// Publish steps (default mode):
//   1. Verify git is clean (no uncommitted changes).
//   2. Download kodax-ai-kodax-<v>.tgz + kodax-ai-kodax-npm.sha256 from the
//      GitHub Release for tag v<version> (built by the Release workflow).
//      Honors HTTPS_PROXY / https_proxy (Node's global fetch does not).
//   3. Verify the tarball sha256 against the checksum asset, then re-run
//      the sidecar tarball audit on the downloaded bytes.
//   4. `npm publish <tgz> --registry=https://registry.npmjs.org/` — the CI
//      pack already set private:false inside the tarball; no local toggle.
//
// Pack-only steps:
//   1. Build (unless --skip-build) and guard the local dist/ (bundle import,
//      worker sidecar, native authorities — all five on CI, host-only check
//      on a local machine).
//   2. Universal (CI): toggle private:true → false for the publish
//      candidate, `npm pack`, audit the exact candidate bytes, restore
//      package.json via try/finally.
//      Host-only (local): `npm pack` with private still true — the tarball
//      is consumable via `npm install <path>` but npm refuses to publish it.
//
// Idempotent failure mode: pristine bytes are captured BEFORE any mutation;
// restore writes them back verbatim even if npm pack throws.

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

function assertNativeArtifacts(dir, platformFilter = null) {
  const platforms = [
    ['win32', 'x64', 'kodax-windows-text-transaction.node'],
    ['linux', 'x64', 'kodax-text-transaction.node'],
    ['linux', 'arm64', 'kodax-text-transaction.node'],
    ['darwin', 'x64', 'kodax-text-transaction.node'],
    ['darwin', 'arm64', 'kodax-text-transaction.node'],
  ];
  // platformFilter narrows the assertion to the given [platform, arch] pairs —
  // used by the LOCAL TEST TARBALL path where only the host authority can
  // exist. A filter that matches nothing is always a caller bug.
  const selected = platformFilter === null
    ? platforms
    : platforms.filter(([p, a]) => platformFilter.some(([fp, fa]) => fp === p && fa === a));
  if (selected.length === 0) {
    throw new Error('assertNativeArtifacts platform filter matched no supported platform');
  }
  for (const [platform, arch, textFilename] of selected) {
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
        ? [['shellSandbox', 10, 'kodax-windows-sandbox.exe']]
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

const REQUIRED_NATIVE_TARBALL_ENTRIES = [
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
];

const NATIVE_PLATFORM_DIRECTORIES = [
  'win32-x64',
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
];

function universalNativeAuthoritiesPresent() {
  return NATIVE_PLATFORM_DIRECTORIES.every((directory) => existsSync(
    path.join(repoRoot, 'dist', 'native', directory, 'manifest.json'),
  ));
}

function hostNativeTarballEntries() {
  const prefix = `package/dist/native/${process.platform}-${process.arch}/`;
  const entries = REQUIRED_NATIVE_TARBALL_ENTRIES.filter((entry) => entry.startsWith(prefix));
  if (entries.length === 0) {
    throw new Error(`${process.platform}-${process.arch} has no native text authority entries`);
  }
  return entries;
}

function githubRepositorySlug(pkg) {
  const url = typeof pkg.repository?.url === 'string' ? pkg.repository.url : '';
  const match = /^git\+https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url)
    ?? /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (match === null) {
    throw new Error('root package.json#repository.url must point at github.com to publish the CI-built tarball');
  }
  return `${match[1]}/${match[2]}`;
}

// Node's global fetch ignores HTTP(S)_PROXY env vars, so machines that can
// only reach github.com through a local proxy fail with an opaque
// UND_ERR_CONNECT_TIMEOUT. undici's fetch honors a ProxyAgent dispatcher;
// it is imported lazily so proxy-free environments (CI) need nothing extra.
function httpsProxyUrl() {
  return process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '';
}

async function fetchReleaseAsset(url) {
  const proxyUrl = httpsProxyUrl();
  if (proxyUrl === '') {
    return fetch(url);
  }
  const { fetch: fetchWithProxy, ProxyAgent } = await import('undici');
  return fetchWithProxy(url, { dispatcher: new ProxyAgent(proxyUrl) });
}

async function downloadReleaseAsset(slug, version, filename) {
  const url = `https://github.com/${slug}/releases/download/v${version}/${filename}`;
  let response;
  try {
    response = await fetchReleaseAsset(url);
  } catch (err) {
    const cause = err?.cause
      ? ` (${err.cause.code ?? err.cause.message ?? String(err.cause)})`
      : '';
    throw new Error(
      `Downloading ${url} failed at the network layer${cause}. If this machine needs a proxy to reach github.com, set HTTPS_PROXY to it.`,
    );
  }
  if (response.status === 404) {
    throw new Error(
      `GitHub Release v${version} has no asset ${filename}. Push tag v${version} and wait for the Release workflow to complete, then retry.`,
    );
  }
  if (!response.ok) {
    throw new Error(`Downloading ${url} failed with HTTP ${response.status}.`);
  }
  return response;
}

async function main() {
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
  if (packOnly) {
    log('Mode: PACK-ONLY (local tarball for SDK consumer testing)');
  } else {
    log(`Mode: ${isDryRun ? 'DRY RUN' : 'REAL PUBLISH (irreversible)'} — CI-built universal tarball`);
  }
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

  if (packOnly) {
    packLocalTarball(version);
    return;
  }
  await publishCiTarball(pkg, version);
}

function packLocalTarball(version) {
  const dist = path.join(repoRoot, 'dist');
  const tarballPath = path.join(repoRoot, `kodax-ai-kodax-${version}.tgz`);

  // `npm run build` is the single safe entry — it chains build:packages →
  // build:bundle → `tsc --emitDeclarationOnly`. The trailing tsc step adds
  // dist/*.d.ts WITHOUT touching dist/*.js (--emitDeclarationOnly is the
  // critical guard — plain `tsc` would overwrite the esbuild bundle with
  // unbundled tsc output and ship a broken tarball).
  if (!skipBuild) {
    log('-- npm run build (packages + esbuild bundle + .d.ts)');
    runCmd('npm', ['run', 'build']);
  } else {
    log('-- --skip-build: assuming dist/ is already current');
  }
  assertNoRawAgentDynamicImport(dist);
  assertSemanticWorkerSidecar(dist);

  if (universalNativeAuthoritiesPresent()) {
    // CI npm-package job: all five authorities are staged — pack the
    // audited universal publish candidate (the exact bytes the GitHub
    // Release later exposes and `node scripts/release.mjs` publishes).
    assertNativeArtifacts(dist);
    log('-- bundle import, worker sidecar, and cross-platform native artifact guards passed');
    const pristineBytes = toggleRootPackageJsonForPublish();
    try {
      log('-- toggling root package.json#private: true → false (will restore via try/finally)');
      // Consumer flow: `npm install /abs/path/to/kodax-ai-kodax-<version>.tgz`.
      log('-- npm pack (exact candidate bytes)');
      runCmd('npm', ['pack']);
      auditSidecarTarball(tarballPath, {
        requiredEntries: REQUIRED_NATIVE_TARBALL_ENTRIES,
      });
      log('-- ✓ npm pack + Sidecar tarball audit succeeded');
    } finally {
      log('-- restoring root package.json (pristine bytes)');
      restoreRootPackageJson(pristineBytes);
    }
  } else {
    // Local machine: only the host authority exists. Pack a LOCAL TEST
    // TARBALL and keep private:true so npm physically refuses to publish
    // it — consumers can still `npm install <path>` it for SDK testing.
    log('-- LOCAL TEST TARBALL (host native authority only): private stays true, npm publish will refuse it');
    assertNativeArtifacts(dist, [[process.platform, process.arch]]);
    log('-- npm pack (host-only test bytes)');
    runCmd('npm', ['pack']);
    auditSidecarTarball(tarballPath, {
      requiredEntries: hostNativeTarballEntries(),
    });
    log('-- ✓ host-only test tarball + sidecar audit succeeded');
  }

  log('');
  log(`Tarball produced: kodax-ai-kodax-${version}.tgz`);
  log(`Consumer install: npm install ${path.join(repoRoot, `kodax-ai-kodax-${version}.tgz`)}`);
}

async function publishCiTarball(pkg, version) {
  const slug = githubRepositorySlug(pkg);
  const tarballName = `kodax-ai-kodax-${version}.tgz`;
  const tarballPath = path.join(repoRoot, tarballName);

  log(`-- downloading ${tarballName} + checksum from GitHub Release v${version} (${slug})`);
  const checksumResponse = await downloadReleaseAsset(slug, version, 'kodax-ai-kodax-npm.sha256');
  const checksumText = await checksumResponse.text();
  const checksum = /^([0-9a-f]{64})\s+\*?([^\s]+)$/m.exec(checksumText.trim());
  if (checksum === null || checksum[2] !== tarballName) {
    throw new Error(`kodax-ai-kodax-npm.sha256 does not anchor ${tarballName}`);
  }
  const tarballResponse = await downloadReleaseAsset(slug, version, tarballName);
  const bytes = Buffer.from(await tarballResponse.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== checksum[1]) {
    throw new Error(`sha256 checksum mismatch for ${tarballName}: expected ${checksum[1]}, got ${actual}`);
  }
  writeFileSync(tarballPath, bytes);
  auditSidecarTarball(tarballPath, {
    requiredEntries: REQUIRED_NATIVE_TARBALL_ENTRIES,
  });
  log('-- ✓ sha256 + sidecar audit of the CI-built universal tarball passed');

  // Force official npm registry — repo .npmrc pins npmmirror for fast
  // dev installs, but publish must always go to registry.npmjs.org.
  // The CI pack already set private:false inside the tarball, so no local
  // package.json toggle is needed here.
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

  log('');
  if (isDryRun) {
    log('Dry run complete. Nothing was actually published.');
  } else {
    log(`Published @kodax-ai/kodax@${version}.`);
    log(`Verify: npm view @kodax-ai/kodax@${version} version --registry=https://registry.npmjs.org/`);
    log('(Registry propagation can take 30-120s.)');
  }
}

try {
  await main();
} catch (err) {
  logError(err.stack || err.message);
  process.exit(1);
}
