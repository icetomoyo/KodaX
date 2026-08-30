import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _internalWindowsNativeArtifacts,
  assertWindowsNativeArtifactStoreNotDirectlyWritable,
  assertWindowsSandboxControlStateNotDirectlyAccessible,
  ensureUnixTrustedTextStateRoot,
  provisionWindowsAsrtRunner,
  resolveWindowsAsrtRunnerArtifact,
  resolveWindowsNativeArtifact,
  unixTrustedTextCoordinationRoot,
  windowsNativeArtifactCacheRoot,
  windowsSandboxControlDirectory,
} from './windows-native-artifacts.js';

function windowsManifestText(
  asrtSha256: string,
  shellSha256 = 'b'.repeat(64),
): string {
  return JSON.stringify({
    version: 1,
    platform: 'win32',
    arch: process.arch,
    textTransaction: {
      file: 'kodax_windows_text_transaction.node',
      protocol: 1,
      sha256: 'a'.repeat(64),
    },
    shellSandbox: {
      file: 'kodax_windows_shell_sandbox.exe',
      protocol: 1,
      sha256: shellSha256,
    },
    asrtRunner: { file: 'srt-win.exe', version: '0.0.65', sha256: asrtSha256 },
  });
}

describe('Windows native artifact trust boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects a development artifact source that overlaps an untrusted write root', () => {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

    expect(() => _internalWindowsNativeArtifacts.assertDevelopmentSourceIsOutsideWriteRoots(
      repositoryRoot,
      [repositoryRoot],
    )).toThrow(/native artifact source overlaps a writable Runtime root/);
  });

  it('validates only the requested artifact entry at runtime', () => {
    const parse = _internalWindowsNativeArtifacts.parseManifestEntryText;
    const text = JSON.stringify({
      version: 1,
      platform: 'win32',
      arch: process.arch,
      textTransaction: {
        file: 'kodax_windows_text_transaction.node',
        protocol: 1,
        sha256: 'a'.repeat(64),
      },
      shellSandbox: { file: '../broken.exe' },
    });

    expect(parse(text, 'textTransaction').entry.protocol).toBe(1);
    expect(() => parse(text, 'shellSandbox')).toThrow(/shellSandbox entry is invalid/);
  });

  it('rejects a write root on either side of the fixed artifact store boundary', () => {
    vi.stubEnv('LOCALAPPDATA', path.resolve('C:/kodax-artifact-test-local'));
    const cacheRoot = windowsNativeArtifactCacheRoot();

    expect(() => assertWindowsNativeArtifactStoreNotDirectlyWritable([
      path.dirname(cacheRoot),
    ])).toThrow(/targets protected native state/);
    expect(() => assertWindowsNativeArtifactStoreNotDirectlyWritable([
      path.join(cacheRoot, 'nested'),
    ])).toThrow(/targets protected native state/);
  });

  it('keeps development-source overlap checks bidirectional', () => {
    const source = path.resolve('C:/workspace/dist/native/win32-x64');
    const check = _internalWindowsNativeArtifacts.assertDevelopmentSourceIsOutsideWriteRoots;

    expect(() => check(source, [path.resolve('C:/workspace')])).toThrow(/overlaps/);
    expect(() => check(source, [path.join(source, 'nested')])).toThrow(/overlaps/);
    expect(() => check(source, [path.resolve('C:/other-workspace')])).not.toThrow();
  });

  it('prefers an existing physical app.asar.unpacked artifact without accepting a missing one', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-electron-artifact-path-'));
    try {
      const virtualArtifact = path.join(
        temporary,
        'resources',
        'app.asar',
        'node_modules',
        'fixture',
        'native.exe',
      );
      const physicalArtifact = path.join(
        temporary,
        'resources',
        'app.asar.unpacked',
        'node_modules',
        'fixture',
        'native.exe',
      );
      fs.mkdirSync(path.dirname(physicalArtifact), { recursive: true });
      fs.writeFileSync(physicalArtifact, 'physical');

      expect(_internalWindowsNativeArtifacts.physicalElectronArtifactPath(virtualArtifact))
        .toBe(physicalArtifact);
      const missingPhysicalSibling = path.join(
        temporary,
        'other-resources',
        'app.asar',
        'native.exe',
      );
      expect(_internalWindowsNativeArtifacts.physicalElectronArtifactPath(
        missingPhysicalSibling,
      )).toBe(missingPhysicalSibling);

      const moduleUrl = pathToFileURL(path.join(
        temporary,
        'resources',
        'app.asar',
        'node_modules',
        '@kodax-ai',
        'kodax',
        'dist',
        'sdk-sandbox.js',
      )).href;
      fs.mkdirSync(path.join(
        temporary,
        'resources',
        'app.asar.unpacked',
        'node_modules',
        '@kodax-ai',
        'kodax',
        'dist',
        'native',
        `win32-${process.arch}`,
      ), { recursive: true });
      expect(_internalWindowsNativeArtifacts.artifactDirectories(moduleUrl)[0])
        .toContain(`${path.sep}app.asar${path.sep}`);
      expect(_internalWindowsNativeArtifacts.artifactDirectories(moduleUrl, true)[0])
        .toContain(`${path.sep}app.asar.unpacked${path.sep}`);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')(
    'rejects writable junctions into protected native and development state',
    () => {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-native-alias-boundary-'));
      vi.stubEnv('LOCALAPPDATA', path.join(temporary, 'local'));
      try {
        const cacheRoot = windowsNativeArtifactCacheRoot();
        const developmentSource = path.join(temporary, 'development-source');
        const aliases = path.join(temporary, 'aliases');
        fs.mkdirSync(cacheRoot, { recursive: true });
        fs.mkdirSync(developmentSource, { recursive: true });
        fs.mkdirSync(aliases, { recursive: true });
        const cacheAlias = path.join(aliases, 'cache');
        const developmentAlias = path.join(aliases, 'development');
        fs.symlinkSync(cacheRoot, cacheAlias, 'junction');
        fs.symlinkSync(developmentSource, developmentAlias, 'junction');

        expect(() => assertWindowsNativeArtifactStoreNotDirectlyWritable([
          cacheAlias,
        ])).toThrow(/protected native state/);
        expect(() => assertWindowsSandboxControlStateNotDirectlyAccessible({
          allowRead: [],
          allowWrite: [path.join(cacheAlias, 'control-v1')],
          denyRead: [],
          denyWrite: [],
        })).toThrow(/native shell control state/);
        expect(() => _internalWindowsNativeArtifacts.assertDevelopmentSourceIsOutsideWriteRoots(
          developmentSource,
          [developmentAlias],
        )).toThrow(/native artifact source overlaps/);
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    },
  );

  it('allows readable ancestors but rejects direct grants inside the native artifact boundary', () => {
    vi.stubEnv('LOCALAPPDATA', path.resolve('C:/kodax-control-test-local'));
    const cacheRoot = windowsNativeArtifactCacheRoot();
    const control = windowsSandboxControlDirectory();

    expect(() => assertWindowsSandboxControlStateNotDirectlyAccessible({
      allowRead: [path.dirname(cacheRoot)],
      allowWrite: [],
      denyRead: [],
      denyWrite: [],
    })).not.toThrow();
    expect(() => assertWindowsSandboxControlStateNotDirectlyAccessible({
      allowRead: [cacheRoot],
      allowWrite: [],
      denyRead: [],
      denyWrite: [],
    })).toThrow(/native shell control state/);
    expect(() => assertWindowsSandboxControlStateNotDirectlyAccessible({
      allowRead: [control],
      allowWrite: [],
      denyRead: [],
      denyWrite: [],
    })).toThrow(/native shell control state/);
    expect(() => assertWindowsSandboxControlStateNotDirectlyAccessible({
      allowRead: [],
      allowWrite: [path.join(cacheRoot, 'artifact-sibling')],
      denyRead: [],
      denyWrite: [],
    })).toThrow(/native shell control state/);
    expect(() => assertWindowsSandboxControlStateNotDirectlyAccessible({
      allowRead: [],
      allowWrite: [],
      denyRead: [cacheRoot],
      denyWrite: [],
    })).toThrow(/deny policy targets protected native shell control state/);
    expect(() => assertWindowsSandboxControlStateNotDirectlyAccessible({
      allowRead: [],
      allowWrite: [],
      denyRead: [],
      denyWrite: [control],
    })).toThrow(/deny policy targets protected native shell control state/);
    expect(() => assertWindowsSandboxControlStateNotDirectlyAccessible({
      allowRead: [],
      allowWrite: [],
      denyRead: [path.dirname(cacheRoot)],
      denyWrite: [],
    })).not.toThrow();
    expect(() => assertWindowsSandboxControlStateNotDirectlyAccessible({
      allowRead: [path.resolve('C:/other-readable-root')],
      allowWrite: [path.resolve('C:/other-writable-root')],
      denyRead: [],
      denyWrite: [],
    })).not.toThrow();
  });

  it.runIf(process.platform === 'win32')(
    'imports a hash-pinned package-manager hardlink into a single-link protected cache',
    () => {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-asrt-hardlink-source-'));
      const moduleFile = path.join(temporary, 'package', 'dist', 'sdk-sandbox.js');
      const manifestDirectory = path.join(
        path.dirname(moduleFile),
        'native',
        `win32-${process.arch}`,
      );
      const packageStore = path.join(temporary, 'package-store');
      const sourcePath = path.join(temporary, 'node_modules', 'srt-win.exe');
      const localAppData = path.join(temporary, 'local-app-data');
      vi.stubEnv('LOCALAPPDATA', localAppData);
      try {
        const bytes = Buffer.from('hash-pinned package-manager runner');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        fs.mkdirSync(path.dirname(moduleFile), { recursive: true });
        fs.mkdirSync(manifestDirectory, { recursive: true });
        fs.mkdirSync(packageStore, { recursive: true });
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.mkdirSync(localAppData, { recursive: true });
        const storedRunner = path.join(packageStore, 'srt-win.exe');
        fs.writeFileSync(storedRunner, bytes);
        fs.linkSync(storedRunner, sourcePath);
        const manifestText = windowsManifestText(sha256);
        fs.writeFileSync(path.join(manifestDirectory, 'manifest.json'), manifestText);
        vi.stubGlobal('KODAX_WINDOWS_NATIVE_MANIFEST_JSON', manifestText);

        expect(fs.lstatSync(sourcePath).nlink).toBeGreaterThan(1);
        const runner = resolveWindowsAsrtRunnerArtifact(
          pathToFileURL(moduleFile).href,
          sourcePath,
          '0.0.65',
        );

        expect(fs.readFileSync(runner.path)).toEqual(bytes);
        expect(fs.lstatSync(runner.path).nlink).toBe(1);
        expect(runner.sha256).toBe(sha256);

        fs.writeFileSync(sourcePath, Buffer.from('tampered package-manager runner'));
        expect(() => resolveWindowsAsrtRunnerArtifact(
          pathToFileURL(moduleFile).href,
          sourcePath,
          '0.0.65',
        )).toThrow(/native artifact hash mismatch/);
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'imports an embedded ASRT runner from its physical Electron unpacked path',
    () => {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-electron-asrt-source-'));
      const moduleFile = path.join(
        temporary,
        'resources',
        'app.asar',
        'node_modules',
        '@kodax-ai',
        'kodax',
        'dist',
        'sdk-sandbox.js',
      );
      const sourcePath = path.join(
        temporary,
        'resources',
        'app.asar',
        'node_modules',
        '@anthropic-ai',
        'sandbox-runtime',
        'vendor',
        'srt-win',
        process.arch,
        'srt-win.exe',
      );
      const physicalSourcePath = sourcePath.replace(
        `${path.sep}app.asar${path.sep}`,
        `${path.sep}app.asar.unpacked${path.sep}`,
      );
      vi.stubEnv('LOCALAPPDATA', path.join(temporary, 'local-app-data'));
      try {
        const bytes = Buffer.from('electron unpacked runner');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        fs.mkdirSync(path.join(temporary, 'local-app-data'), { recursive: true });
        fs.mkdirSync(path.dirname(physicalSourcePath), { recursive: true });
        fs.writeFileSync(physicalSourcePath, bytes);
        vi.stubGlobal('KODAX_WINDOWS_NATIVE_MANIFEST_JSON', windowsManifestText(sha256));

        const runner = resolveWindowsAsrtRunnerArtifact(
          pathToFileURL(moduleFile).href,
          sourcePath,
          '0.0.65',
        );

        expect(fs.readFileSync(runner.path)).toEqual(bytes);
        expect(runner.developmentTrustRoots).toEqual([]);
        fs.writeFileSync(physicalSourcePath, 'tampered');
        expect(() => resolveWindowsAsrtRunnerArtifact(
          pathToFileURL(moduleFile).href,
          sourcePath,
          '0.0.65',
        )).toThrow(/native artifact hash mismatch/);
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'imports embedded KodaX native bytes from the physical Electron unpacked directory',
    () => {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-electron-native-source-'));
      const moduleFile = path.join(
        temporary,
        'resources',
        'app.asar',
        'node_modules',
        '@kodax-ai',
        'kodax',
        'dist',
        'sdk-sandbox.js',
      );
      const virtualDirectory = path.join(
        path.dirname(moduleFile),
        'native',
        `win32-${process.arch}`,
      );
      const physicalDirectory = virtualDirectory.replace(
        `${path.sep}app.asar${path.sep}`,
        `${path.sep}app.asar.unpacked${path.sep}`,
      );
      const sourcePath = path.join(physicalDirectory, 'kodax_windows_shell_sandbox.exe');
      const localAppData = path.join(temporary, 'local-app-data');
      vi.stubEnv('LOCALAPPDATA', localAppData);
      try {
        const bytes = Buffer.from('electron unpacked KodaX shell runner');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        fs.mkdirSync(physicalDirectory, { recursive: true });
        fs.mkdirSync(localAppData, { recursive: true });
        fs.writeFileSync(sourcePath, bytes);
        vi.stubGlobal(
          'KODAX_WINDOWS_NATIVE_MANIFEST_JSON',
          windowsManifestText('a'.repeat(64), sha256),
        );

        const runner = resolveWindowsNativeArtifact(
          pathToFileURL(moduleFile).href,
          'shellSandbox',
          1,
        );

        expect(fs.readFileSync(runner.path)).toEqual(bytes);
        fs.writeFileSync(sourcePath, 'tampered');
        expect(() => resolveWindowsNativeArtifact(
          pathToFileURL(moduleFile).href,
          'shellSandbox',
          1,
        )).toThrow(/native artifact hash mismatch/);
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps development manifests and ASRT sources single-link',
    () => {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-asrt-dev-hardlink-'));
      const moduleFile = path.join(temporary, 'package', 'dist', 'sdk-sandbox.js');
      const manifestDirectory = path.join(
        path.dirname(moduleFile),
        'native',
        `win32-${process.arch}`,
      );
      const sourcePath = path.join(temporary, 'node_modules', 'srt-win.exe');
      const localAppData = path.join(temporary, 'local-app-data');
      vi.stubEnv('LOCALAPPDATA', localAppData);
      try {
        const bytes = Buffer.from('development hardlink runner');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        fs.mkdirSync(manifestDirectory, { recursive: true });
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.mkdirSync(localAppData, { recursive: true });
        const writableAlias = path.join(temporary, 'writable-alias.exe');
        fs.writeFileSync(writableAlias, bytes);
        fs.linkSync(writableAlias, sourcePath);
        const manifestText = windowsManifestText(sha256);
        const manifestPath = path.join(manifestDirectory, 'manifest.json');
        const manifestAlias = path.join(temporary, 'writable-manifest-alias.json');
        fs.writeFileSync(manifestAlias, manifestText);
        fs.linkSync(manifestAlias, manifestPath);

        expect(() => resolveWindowsAsrtRunnerArtifact(
          pathToFileURL(moduleFile).href,
          sourcePath,
          '0.0.65',
        )).toThrow(/bounded ordinary file/);

        fs.unlinkSync(manifestPath);
        fs.writeFileSync(manifestPath, manifestText);
        expect(() => resolveWindowsAsrtRunnerArtifact(
          pathToFileURL(moduleFile).href,
          sourcePath,
          '0.0.65',
        )).toThrow(/bounded ordinary file/);
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects a package source that grows beyond the bound after path inspection',
    () => {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-asrt-growing-source-'));
      const moduleFile = path.join(temporary, 'package', 'dist', 'sdk-sandbox.js');
      const sourcePath = path.join(temporary, 'node_modules', 'srt-win.exe');
      vi.stubEnv('LOCALAPPDATA', path.join(temporary, 'local-app-data'));
      try {
        const bytes = Buffer.from('initial bounded runner');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        fs.mkdirSync(path.dirname(moduleFile), { recursive: true });
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, bytes);
        vi.stubGlobal('KODAX_WINDOWS_NATIVE_MANIFEST_JSON', windowsManifestText(sha256));
        const lstat = fs.lstatSync.bind(fs);
        let grew = false;
        vi.spyOn(fs, 'lstatSync').mockImplementation((candidate) => {
          const stat = lstat(candidate);
          if (!grew && path.resolve(String(candidate)) === path.resolve(sourcePath)) {
            grew = true;
            fs.truncateSync(sourcePath, 64 * 1024 * 1024 + 1);
          }
          return stat;
        });

        expect(() => resolveWindowsAsrtRunnerArtifact(
          pathToFileURL(moduleFile).href,
          sourcePath,
          '0.0.65',
        )).toThrow(/bounded ordinary file/);
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'provisions the ASRT runner outside Agent Home with local Users read-execute only',
    () => {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-asrt-runner-artifact-'));
      const agentHome = path.join(temporary, 'private-agent-home');
      const localAppData = path.join(
        temporary,
        'local-app-data-path-length-regression',
      );
      fs.mkdirSync(localAppData, { recursive: true });
      vi.stubEnv('LOCALAPPDATA', localAppData);
      vi.stubEnv('KODAX_HOME', agentHome);
      try {
        const bytes = Buffer.from('bounded test executable');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const runner = provisionWindowsAsrtRunner(bytes, sha256);
        expect(runner.path.toLowerCase()).toContain(
          windowsNativeArtifactCacheRoot().toLowerCase(),
        );
        expect(runner.path.toLowerCase()).not.toContain(agentHome.toLowerCase());
        expect(runner.sha256).toMatch(/^[0-9a-f]{64}$/);

        const script = String.raw`
$acl = [IO.File]::GetAccessControl($env:KODAX_TEST_ARTIFACT)
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
  [pscustomobject]@{
    sid = $_.IdentityReference.Value
    type = [string]$_.AccessControlType
    mask = [int]$_.FileSystemRights
    inherited = $_.IsInherited
  }
})
[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; rules = $rules } | ConvertTo-Json -Compress -Depth 4
`;
        const powershell = path.join(
          process.env.SystemRoot ?? String.raw`C:\Windows`,
          'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
        );
        const result = spawnSync(powershell, [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
        ], {
          env: { ...process.env, KODAX_TEST_ARTIFACT: runner.path },
          encoding: 'utf8',
          windowsHide: true,
        });
        expect(result.status, result.stderr).toBe(0);
        const acl = JSON.parse(result.stdout.trim()) as {
          readonly protected: boolean;
          readonly rules: readonly {
            readonly sid: string;
            readonly type: string;
            readonly mask: number;
            readonly inherited: boolean;
          }[];
        };
        expect(acl.protected).toBe(true);
        expect(acl.rules).toEqual(expect.arrayContaining([
          expect.objectContaining({
            sid: 'S-1-5-32-545',
            type: 'Allow',
            inherited: false,
          }),
        ]));
        expect(acl.rules).toHaveLength(3);

        expect(() => provisionWindowsAsrtRunner(
          Buffer.from('tampered executable with the same package version'),
          sha256,
        )).toThrow(/trusted release digest/);
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'preserves an administrator deny on the protected native cache',
    () => {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-native-admin-deny-'));
      const localAppData = path.join(temporary, 'local-app-data');
      fs.mkdirSync(localAppData, { recursive: true });
      vi.stubEnv('LOCALAPPDATA', localAppData);
      try {
        const bytes = Buffer.from('administrator deny preservation');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        provisionWindowsAsrtRunner(bytes, sha256);
        const cacheRoot = windowsNativeArtifactCacheRoot();
        const script = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:KODAX_TEST_CACHE
$sid = [Security.Principal.SecurityIdentifier]::new('S-1-5-21-11-12-13-14')
$inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$rights = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
$acl = [IO.Directory]::GetAccessControl($path)
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Deny)
[void]$acl.AddAccessRule($rule)
[IO.Directory]::SetAccessControl($path, $acl)
`;
        const powershell = path.join(
          process.env.SystemRoot ?? String.raw`C:\Windows`,
          'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
        );
        const invoke = (source: string) => spawnSync(powershell, [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64'),
        ], {
          env: { ...process.env, KODAX_TEST_CACHE: cacheRoot },
          encoding: 'utf8',
          windowsHide: true,
        });
        const added = invoke(script);
        expect(added.status, added.stderr).toBe(0);

        provisionWindowsAsrtRunner(bytes, sha256);

        const observed = invoke(String.raw`
$acl = [IO.Directory]::GetAccessControl($env:KODAX_TEST_CACHE)
@($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
  $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny -and $_.IdentityReference.Value -eq 'S-1-5-21-11-12-13-14'
}).Count
`);
        expect(observed.status, observed.stderr).toBe(0);
        expect(observed.stdout.trim()).toBe('1');
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    },
  );
});

describe.skipIf(process.platform === 'win32')('Unix native text state boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects a symlinked KODAX_HOME before provisioning protected state', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-state-symlink-'));
    const workspace = path.join(temporary, 'workspace');
    const alias = path.join(temporary, 'agent-home');
    fs.mkdirSync(workspace);
    fs.symlinkSync(workspace, alias, 'dir');
    vi.stubEnv('KODAX_HOME', alias);
    try {
      expect(() => ensureUnixTrustedTextStateRoot()).toThrow(/symbolic-link ancestor/);
      expect(fs.existsSync(path.join(workspace, 'native-text-state-v1'))).toBe(false);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('uses one UID-scoped coordination root across different KODAX_HOME values', () => {
    vi.stubEnv('KODAX_HOME', path.join(os.tmpdir(), 'kodax-home-one'));
    vi.stubEnv('TMPDIR', path.join(os.tmpdir(), 'kodax-tmp-one'));
    const first = unixTrustedTextCoordinationRoot();
    vi.stubEnv('KODAX_HOME', path.join(os.tmpdir(), 'kodax-home-two'));
    vi.stubEnv('TMPDIR', path.join(os.tmpdir(), 'kodax-tmp-two'));
    expect(unixTrustedTextCoordinationRoot()).toBe(first);
  });
});
