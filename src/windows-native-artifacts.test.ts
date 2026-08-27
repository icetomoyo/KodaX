import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _internalWindowsNativeArtifacts,
  assertWindowsNativeArtifactStoreNotDirectlyWritable,
  assertWindowsSandboxControlStateNotDirectlyAccessible,
  ensureUnixTrustedTextStateRoot,
  provisionWindowsAsrtRunner,
  unixTrustedTextCoordinationRoot,
  windowsNativeArtifactCacheRoot,
  windowsSandboxControlDirectory,
} from './windows-native-artifacts.js';

describe('Windows native artifact trust boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
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

  it('rejects read or write grants on either side of the native control boundary', () => {
    vi.stubEnv('LOCALAPPDATA', path.resolve('C:/kodax-control-test-local'));
    const control = windowsSandboxControlDirectory();

    expect(() => assertWindowsSandboxControlStateNotDirectlyAccessible({
      allowRead: [path.dirname(control)],
      allowWrite: [],
      denyRead: [],
      denyWrite: [],
    })).toThrow(/native shell control state/);
    expect(() => assertWindowsSandboxControlStateNotDirectlyAccessible({
      allowRead: [],
      allowWrite: [path.join(control, 'nested')],
      denyRead: [],
      denyWrite: [],
    })).toThrow(/native shell control state/);
    expect(() => assertWindowsSandboxControlStateNotDirectlyAccessible({
      allowRead: [],
      allowWrite: [],
      denyRead: [],
      denyWrite: [control],
    })).toThrow(/deny policy targets protected native shell control state/);
    expect(() => assertWindowsSandboxControlStateNotDirectlyAccessible({
      allowRead: [],
      allowWrite: [],
      denyRead: [path.dirname(control)],
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
