import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _internalWindowsNativeArtifacts,
  assertWindowsNativeArtifactStoreNotDirectlyWritable,
  ensureUnixTrustedTextStateRoot,
  resolveWindowsNativeArtifact,
  unixTrustedTextCoordinationRoot,
  windowsNativeArtifactCacheRoot,
} from './windows-native-artifacts.js';

describe('Windows native artifact trust boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects a development artifact source that overlaps an untrusted write root', () => {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

    expect(() => resolveWindowsNativeArtifact(
      import.meta.url,
      'textTransaction',
      1,
      { untrustedWriteRoots: [repositoryRoot] },
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
