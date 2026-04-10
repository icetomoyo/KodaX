import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callPremiumDaemon, isExplicitBinPath } from './premium-client.js';

describe('premium repo-intelligence client', () => {
  let tempDir = '';
  let originalBin: string | undefined;
  let originalEndpoint: string | undefined;
  let originalBuildId: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-premium-client-'));
    const cliDistDir = join(tempDir, 'dist');
    mkdirSync(cliDistDir, { recursive: true });
    writeFileSync(join(cliDistDir, 'index.js'), 'console.log("stub");\n');
    writeFileSync(
      join(cliDistDir, 'build-id.json'),
      `${JSON.stringify({ buildId: 'client-build-1' }, null, 2)}\n`,
      'utf8',
    );

    originalBin = process.env.KODAX_REPOINTEL_BIN;
    originalEndpoint = process.env.KODAX_REPOINTEL_ENDPOINT;
    originalBuildId = process.env.KODAX_REPOINTEL_BUILD_ID;

    process.env.KODAX_REPOINTEL_BIN = join(cliDistDir, 'index.js');
    process.env.KODAX_REPOINTEL_ENDPOINT = 'http://127.0.0.1:47897';
    delete process.env.KODAX_REPOINTEL_BUILD_ID;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalBin === undefined) {
      delete process.env.KODAX_REPOINTEL_BIN;
    } else {
      process.env.KODAX_REPOINTEL_BIN = originalBin;
    }
    if (originalEndpoint === undefined) {
      delete process.env.KODAX_REPOINTEL_ENDPOINT;
    } else {
      process.env.KODAX_REPOINTEL_ENDPOINT = originalEndpoint;
    }
    if (originalBuildId === undefined) {
      delete process.env.KODAX_REPOINTEL_BUILD_ID;
    } else {
      process.env.KODAX_REPOINTEL_BUILD_ID = originalBuildId;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('rejects daemon responses from a stale build when local build metadata is available', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          contractVersion: 1,
          buildId: 'daemon-build-2',
          status: 'unavailable',
          error: 'Build mismatch: daemon=daemon-build-2, client=client-build-1',
        }),
        {
          status: 409,
          headers: {
            'content-type': 'application/json',
          },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await callPremiumDaemon('status', {}, {
      mode: 'premium-native',
    });

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      buildId: 'client-build-1',
      command: 'status',
    });
  });

  it('treats PATH-visible Windows launchers as commands instead of explicit file paths', () => {
    expect(isExplicitBinPath('repointel')).toBe(false);
    expect(isExplicitBinPath('repointel.exe')).toBe(false);
    expect(isExplicitBinPath('repointel.cmd')).toBe(false);
    expect(isExplicitBinPath('.\\bin\\repointel.cmd')).toBe(true);
    expect(isExplicitBinPath('..\\repointel.exe')).toBe(true);
    expect(isExplicitBinPath('C:\\Tools\\repointel\\repointel.exe')).toBe(true);
  });
});
