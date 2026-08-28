import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly id?: string;
  readonly if?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, unknown>>;
}

interface WorkflowJob {
  readonly name?: string;
  readonly 'runs-on'?: string;
  readonly strategy?: {
    readonly matrix?: {
      readonly include?: readonly Readonly<Record<string, unknown>>[];
    };
  };
  readonly steps?: readonly WorkflowStep[];
}

interface ReleaseWorkflow {
  readonly jobs?: Readonly<Record<string, WorkflowJob | undefined>>;
}

describe('GitHub release workflow', () => {
  it('publishes the exact Sidecar-audited npm tarball', () => {
    const source = readFileSync(resolve('scripts/release.mjs'), 'utf8');

    expect(source).toContain("import { auditSidecarTarball } from './audit-sidecar-tarball.mjs'");
    expect(source).toContain('auditSidecarTarball(tarballPath, {');
    expect(source).toContain('package/dist/native/win32-x64/manifest.json');
    expect(source).toContain('package/dist/native/win32-x64/kodax-windows-text-transaction.node');
    expect(source).toContain('package/dist/native/win32-x64/kodax-windows-sandbox.exe');
    for (const platform of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']) {
      expect(source).toContain(`package/dist/native/${platform}/manifest.json`);
      expect(source).toContain(`package/dist/native/${platform}/kodax-text-transaction.node`);
    }
    expect(source).toContain("'publish',");
    expect(source).toContain('tarballPath,');
  });

  it('publishes the CI-built universal tarball fetched from the GitHub Release', () => {
    const source = readFileSync(resolve('scripts/release.mjs'), 'utf8');

    expect(source).toContain('/releases/download/');
    expect(source).toContain('kodax-ai-kodax-npm.sha256');
    expect(source).toContain('sha256 checksum mismatch');
    expect(source).toContain('has no asset');
    expect(source).toContain('REQUIRED_NATIVE_TARBALL_ENTRIES');
  });

  it('packs an unpublishable host-only test tarball when only the host authority exists', () => {
    const source = readFileSync(resolve('scripts/release.mjs'), 'utf8');

    expect(source).toContain('LOCAL TEST TARBALL');
    expect(source).toContain('hostNativeTarballEntries');
    expect(source).toContain('universalNativeAuthoritiesPresent');
    // The host-only branch must keep private:true: the publish toggle lives
    // only in the universal (CI) branch, so npm refuses the local tarball.
    const hostOnlyBranch = source.slice(
      source.indexOf('-- LOCAL TEST TARBALL'),
      source.indexOf('requiredEntries: hostNativeTarballEntries()'),
    );
    expect(hostOnlyBranch).not.toContain('toggleRootPackageJsonForPublish');
  });

  it('packages every runtime sidecar with the standalone binary', () => {
    const source = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const workflow = parse(source) as ReleaseWorkflow;
    const packageScript = workflow.jobs?.build?.steps
      ?.find((step) => step.name === 'Package archive')
      ?.run;

    expect(packageScript).toBeTypeOf('string');
    for (const required of [
      'provider-capabilities.json',
      'semantic-worker.js',
      'runtime-worker.js',
      'constructed-handler-worker.js',
    ]) {
      expect(packageScript).toContain(required);
    }
  });

  it('builds once before the Windows Electron gate and binary packaging', () => {
    const source = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const workflow = parse(source) as ReleaseWorkflow;
    const steps = workflow.jobs?.build?.steps ?? [];
    const buildIndex = steps.findIndex((step) => step.name === 'Build');
    const electronIndex = steps.findIndex(
      (step) => step.name === 'Packaged Electron daemon release gate',
    );
    const binaryIndex = steps.findIndex((step) => step.name?.startsWith('Build binary'));
    const smokeIndex = steps.findIndex((step) => step.name === 'Smoke test');
    const packageIndex = steps.findIndex((step) => step.name === 'Package archive');

    expect(steps.filter((step) => step.name === 'Build')).toHaveLength(1);
    expect(steps.find((step) => step.name === 'Build')?.run).toBe('npm run build');
    expect(steps.find((step) => step.name === 'Packaged Electron daemon release gate')?.run)
      .toBe('npm run test:electron-daemon:built');
    expect(steps.find((step) => step.name === 'Activate Windows v2 sandbox for packaged Electron release gate')?.run)
      .toBe('node scripts/prepare-windows-electron-sandbox.mjs');
    expect(steps.find((step) => step.name === 'Windows v2 native policy concurrency gate'))
      .toMatchObject({
        env: { KODAX_REAL_WINDOWS_SANDBOX_V2: '1' },
        run: expect.stringContaining('feature-295-windows-v2-policy.test.ts'),
      });
    expect(steps.find((step) => step.name?.startsWith('Build binary'))?.run)
      .toContain('--skip-tsc');
    expect(buildIndex).toBeGreaterThan(-1);
    expect(electronIndex).toBeGreaterThan(buildIndex);
    expect(binaryIndex).toBeGreaterThan(buildIndex);
    expect(smokeIndex).toBeGreaterThan(binaryIndex);
    expect(packageIndex).toBeGreaterThan(smokeIndex);
  });

  it('rejects standalone binaries that emit more than one A2A document', () => {
    const source = readFileSync(resolve('scripts/build-binary.mjs'), 'utf8');

    expect(source).toContain("['a2a', 'list']");
    expect(source).toContain('JSON.parse');
    expect(source).toContain('KODAX_HOME');
    expect(source).toContain('mkdtempSync');
    expect(source).toContain('verifyHostBinary(join(OUT_ROOT, hostTarget');
  });

  it('recognizes bundled provider packages in npm and nested node_modules layouts', () => {
    const source = readFileSync(resolve('scripts/build-binary.mjs'), 'utf8');

    expect(source).toContain('inputPath.startsWith(packagePath)');
    expect(source).toContain('inputPath.includes(`/${packagePath}`)');
  });

  it('caches the packaged Electron smoke toolchain in CI and releases', () => {
    const release = parse(
      readFileSync(resolve('.github/workflows/release.yml'), 'utf8'),
    ) as ReleaseWorkflow;
    const ci = parse(
      readFileSync(resolve('.github/workflows/ci.yml'), 'utf8'),
    ) as ReleaseWorkflow;
    for (const steps of [
      release.jobs?.build?.steps ?? [],
      ci.jobs?.['packaged-electron-daemon']?.steps ?? [],
    ]) {
      const cache = steps.find((step) => step.name === 'Cache packaged Electron smoke toolchain');
      const install = steps.find((step) => step.name === 'Install packaged Electron smoke toolchain');
      const ensureBinary = steps.find((step) => step.name === 'Ensure packaged Electron binary');
      const activation = steps.find((step) => step.name?.startsWith('Activate Windows v2 sandbox'));
      expect(cache).toMatchObject({
        uses: 'actions/cache@v5',
        id: 'electron-smoke-cache',
        with: { path: '.electron-smoke/node_modules' },
      });
      expect(install?.if).toContain("steps.electron-smoke-cache.outputs.cache-hit != 'true'");
      expect(ensureBinary?.run).toBe('node .electron-smoke/node_modules/electron/install.js');
      expect(activation?.run).toBe('node scripts/prepare-windows-electron-sandbox.mjs');
    }
  });

  it('keeps packaged Electron native authorities as physical unpacked files', () => {
    const source = readFileSync(resolve('scripts/test-electron-daemon-smoke.mjs'), 'utf8');

    expect(source).toContain('asarUnpack: [');
    expect(source).toContain('node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/**/*');
    expect(source).toContain('node_modules/@kodax-ai/kodax/dist/native/**/*');
    expect(source).toContain('verifyPackagedNativeArtifacts');
    expect(source).toContain("'app.asar.unpacked'");
  });

  it('packages both verified Windows native authorities with standalone binaries', () => {
    const source = readFileSync(resolve('scripts/build-binary.mjs'), 'utf8');

    expect(source).toContain("'vendor', 'kodax-native'");
    expect(source).toContain("'dist', 'native'");
    expect(source).toContain('manifest.json');
    expect(source).toContain("['doctor', '--json', '--native-text']");
    expect(source).toContain('trustedTextNative');
  });

  it('anchors the pinned ASRT runner in every native build and release gate', () => {
    const buildNative = readFileSync(resolve('scripts/build-native.mjs'), 'utf8');
    const buildBinary = readFileSync(resolve('scripts/build-binary.mjs'), 'utf8');
    const testNative = readFileSync(resolve('scripts/test-native.mjs'), 'utf8');
    const release = readFileSync(resolve('scripts/release.mjs'), 'utf8');

    expect(buildNative).toContain('manifest.asrtRunner = {');
    expect(buildNative).toContain('protocol: 7');
    expect(buildNative).toContain("'LICENSE-APACHE.txt'");
    expect(buildNative).toContain("'NOTICE-windows-sandbox.txt'");
    expect(buildNative).toContain("file: 'srt-win.exe'");
    expect(buildNative).toContain('version: asrtVersion');
    expect(buildNative).toContain('sha256: sha256(asrtRunnerPath)');

    for (const source of [buildBinary, testNative, release]) {
      expect(source).toContain('manifest.asrtRunner');
      expect(source).toContain("'@anthropic-ai', 'sandbox-runtime'");
      expect(source).toContain("'srt-win.exe'");
      expect(source).toContain('asrtRunner.sha256');
      expect(source).toContain('asrtRunner.version');
    }
    expect(buildBinary).toContain('copied ASRT runner hash does not match its manifest');
    expect(release).toContain("['shellSandbox', 7, 'kodax-windows-sandbox.exe']");
    expect(release).not.toContain("['shellSandbox', 5, 'kodax-windows-sandbox.exe']");
    expect(release).toContain('ASRT runner hash does not match its manifest');
    expect(release).toContain('expectedLegalFiles');
  });

  it('runs the installed tarball gate through npm JavaScript on Windows', () => {
    const source = readFileSync(resolve('scripts/test-packed-native.mjs'), 'utf8');
    expect(source).toContain('process.env.npm_execpath');
    expect(source).toContain("'npm-cli.js'");
    expect(source).toContain("'lib',");
    expect(source).toContain('spawnSync(process.execPath, [npmCli,');
    expect(source).not.toContain("process.platform === 'win32' ? 'npm.cmd'");
  });

  it('aggregates every platform native authority before auditing the npm package', () => {
    const source = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const workflow = parse(source) as ReleaseWorkflow;
    const steps = workflow.jobs?.['npm-package']?.steps ?? [];

    for (const target of [
      'win-x64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64',
    ]) {
      expect(steps).toContainEqual(expect.objectContaining({
        uses: 'actions/download-artifact@v7',
        with: expect.objectContaining({ name: `native-authority-${target}` }),
      }));
    }
    expect(steps.find((step) => step.name === 'Pack and audit universal npm package')?.run)
      .toBe('node scripts/release.mjs --skip-build --pack-only');
    expect(steps.find((step) => step.name === 'Installed npm trusted text native gate')?.run)
      .toBe('npm run test:packed-native');
  });

  it('executes every release artifact on a matching native architecture', () => {
    const workflow = parse(
      readFileSync(resolve('.github/workflows/release.yml'), 'utf8'),
    ) as ReleaseWorkflow;
    const build = workflow.jobs?.build;
    const include = build?.strategy?.matrix?.include ?? [];

    expect(include).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'win-x64', runner: 'windows-latest', smoke: true }),
      expect.objectContaining({ target: 'linux-x64', runner: 'ubuntu-24.04', smoke: true }),
      expect.objectContaining({ target: 'linux-arm64', runner: 'ubuntu-24.04-arm', smoke: true }),
      expect.objectContaining({ target: 'darwin-x64', runner: 'macos-15-intel', smoke: true }),
      expect.objectContaining({ target: 'darwin-arm64', runner: 'macos-15', smoke: true }),
    ]));
    expect(build?.steps?.some((step) => step.name === 'Install Linux ARM64 linker')).toBe(false);
    expect(build?.steps?.find(
      (step) => step.name === 'Real POSIX per-command sandbox concurrency gate',
    )).toMatchObject({
      if: expect.stringContaining("matrix.target != 'win-x64'"),
      env: { KODAX_REAL_POSIX_SANDBOX: '1' },
      run: expect.stringContaining('feature-295-posix-shell-policy.test.ts'),
    });
  });

  it('uses native Linux ARM64 and both macOS architectures in CI', () => {
    const workflow = parse(
      readFileSync(resolve('.github/workflows/ci.yml'), 'utf8'),
    ) as ReleaseWorkflow;
    const nativePlatforms = workflow.jobs?.['trusted-text-native-platforms'];
    const include = nativePlatforms?.strategy?.matrix?.include ?? [];

    expect(include).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'linux-arm64', runner: 'ubuntu-24.04-arm' }),
      expect.objectContaining({ target: 'darwin-x64', runner: 'macos-15-intel' }),
      expect.objectContaining({ target: 'darwin-arm64', runner: 'macos-15' }),
    ]));
    const realPosix = nativePlatforms?.steps?.find(
      (step) => step.name === 'Real POSIX per-command sandbox concurrency gate',
    );
    expect(realPosix).toMatchObject({
      env: { KODAX_REAL_POSIX_SANDBOX: '1' },
      run: expect.stringContaining('feature-295-posix-shell-policy.test.ts'),
    });
    const linuxX64 = workflow.jobs?.test;
    expect(linuxX64?.['runs-on']).toBe('ubuntu-24.04');
    expect(linuxX64?.steps?.find(
      (step) => step.name === 'Real POSIX per-command sandbox concurrency gate',
    )).toMatchObject({
      if: "matrix.node == '22'",
      env: { KODAX_REAL_POSIX_SANDBOX: '1' },
    });
  });

});
