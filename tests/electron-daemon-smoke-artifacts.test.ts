import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../scripts/test-electron-daemon-smoke.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function verifyPackagedNativeArtifacts()');
const end = source.indexOf('async function verifyIndependentWindowsSandboxPolicySharing()', start);
const guard = source.slice(source.slice(0, start).endsWith('async ') ? start - 6 : start, end);
const windowsPath = path.win32;
const appDir = 'C:\\fixture\\app';
const archive = windowsPath.join(appDir, 'release', 'win-unpacked', 'resources', 'app.asar');
const installed = windowsPath.join(appDir, 'node_modules', '@kodax-ai', 'kodax', 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'package.json');
const topLevel = windowsPath.join('node_modules', '@anthropic-ai', 'sandbox-runtime');
const nested = windowsPath.join('node_modules', '@kodax-ai', 'kodax', topLevel);

function verify(resolvedPackage: string, physicalAsrt: string, missingNative = false) {
  const run = vi.fn(async (_command: string, _args: readonly string[], _cwd: string,
    _timeoutMs: number, _env: NodeJS.ProcessEnv) => JSON.stringify({ asrtPackagePath: resolvedPackage }));
  const native = windowsPath.join(`${archive}.unpacked`, 'node_modules', '@kodax-ai', 'kodax', 'dist', 'native', 'win32-x64');
  const existing = new Set([
    windowsPath.join(`${archive}.unpacked`, physicalAsrt, 'vendor', 'srt-win', 'x64', 'srt-win.exe'),
    ...['manifest.json', 'kodax-windows-sandbox.exe', 'kodax-windows-text-transaction.node']
      .filter((file) => !missingNative || file !== 'kodax-windows-sandbox.exe')
      .map((file) => windowsPath.join(native, file)),
  ]);
  const result = Promise.resolve().then(() => runInNewContext(`${guard}\nverifyPackagedNativeArtifacts()`, {
    appDir, path: windowsPath, assert, process: { env: {} }, run,
    existsSync: (file: string) => existing.has(file),
    createRequire: () => ({ resolve: () => installed }),
  }));
  return { result, run };
}

describe('packaged Electron native artifact guard', () => {
  it.each([topLevel, nested])('checks the ASRT copy actually resolved inside ASAR (%s)', async (layout) => {
    const { result, run } = verify(windowsPath.join(archive, layout, 'package.json'), layout);
    await expect(result).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toBe(windowsPath.join(appDir, 'release', 'win-unpacked', 'kodax-daemon-smoke.exe'));
    expect(run.mock.calls[0]?.[4]).toMatchObject({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('rejects resolution into the pre-packaging installation even when its mapped binary exists', async () => {
    await expect(verify(installed, nested).result).rejects.toThrow(/outside.*app\.asar/i);
  });

  it('rejects a missing resolved native file instead of accepting a different existing copy', async () => {
    await expect(verify(windowsPath.join(archive, nested, 'package.json'), topLevel).result)
      .rejects.toThrow(/not physical/);
  });

  it('retains physical checks for KodaX native helpers', async () => {
    await expect(verify(windowsPath.join(archive, nested, 'package.json'), nested, true).result)
      .rejects.toThrow(/kodax-windows-sandbox\.exe/);
  });
});
