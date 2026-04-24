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

  it('short-circuits to OSS cleanly when the initial fetch fails and the bin cannot revive the daemon', async () => {
    // When fetch throws (daemon offline) and the bin subcommands fail or
    // the readiness poll times out, callPremiumDaemon must return null
    // instead of leaking the TypeError. The stub bin exits cleanly, so
    // warm+daemon invocations succeed but the probe/poll never see the
    // endpoint come alive — exercise the "both subcommands ran, daemon
    // still unreachable" branch of ensurePremiumDaemonReady.
    //
    // Use an isolated endpoint so the module-level premiumFailureCache
    // from the previous test doesn't short-circuit this call before fetch.
    process.env.KODAX_REPOINTEL_ENDPOINT = 'http://127.0.0.1:47898';

    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callPremiumDaemon('status', {}, {
      mode: 'premium-native',
    });

    expect(result).toBeNull();
    // Initial fetch + at least one readiness probe (from
    // ensurePremiumDaemonReady's probes). Upper bound is loose because
    // waitForDaemonReady polls until the 2s deadline.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it('does not poison the failure cache on transient AbortError / timeout (refresh:true slow preturn)', async () => {
    // Use an isolated endpoint so the module-level premiumFailureCache
    // from prior tests does not short-circuit this call.
    process.env.KODAX_REPOINTEL_ENDPOINT = 'http://127.0.0.1:47899';

    // Phase 1 — every fetch aborts. Exercises the outer catch branch
    // where `isTransientTimeoutError` must suppress the cache write.
    const abortingFetch = vi.fn(async () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    });
    vi.stubGlobal('fetch', abortingFetch);

    const first = await callPremiumDaemon('preturn', { refresh: true }, {
      mode: 'premium-native',
    });
    expect(first).toBeNull();
    const abortingCalls = abortingFetch.mock.calls.length;
    expect(abortingCalls).toBeGreaterThanOrEqual(1);

    // Phase 2 — immediately swap in a succeeding fetch. Under v0.7.26
    // the failure cache would have `canRetryPremium` → false for the
    // full 2s TTL, and this call would return null without ever
    // invoking fetch. Under v0.7.27 the cache stays empty (transient
    // AbortError is not remembered) and the next call reaches fetch.
    const successFetch = vi.fn(async () => new Response(
      JSON.stringify({
        contractVersion: 1,
        buildId: 'client-build-1',
        status: 'ok',
        result: { ok: true },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', successFetch);

    const second = await callPremiumDaemon('preturn', { refresh: false }, {
      mode: 'premium-native',
    });
    expect(second).not.toBeNull();
    expect(second?.response.status).toBe('ok');
    // The second call DID reach fetch (>=1 invocation), proving the
    // failure cache did not swallow it.
    expect(successFetch.mock.calls.length).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it('treats PATH-visible Windows launchers as commands instead of explicit file paths', () => {
    expect(isExplicitBinPath('repointel')).toBe(false);
    expect(isExplicitBinPath('repointel.exe')).toBe(false);
    expect(isExplicitBinPath('repointel.cmd')).toBe(false);
    expect(isExplicitBinPath('.\\bin\\repointel.cmd')).toBe(true);
    expect(isExplicitBinPath('..\\repointel.exe')).toBe(true);
    expect(isExplicitBinPath('C:\\Tools\\repointel\\repointel.exe')).toBe(true);
  });
});
