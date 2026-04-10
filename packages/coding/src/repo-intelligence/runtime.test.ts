import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./premium-client.js', async () => {
  const actual = await vi.importActual<typeof import('./premium-client.js')>('./premium-client.js');
  return {
    ...actual,
    callPremiumDaemon: vi.fn(),
  };
});

import { callPremiumDaemon } from './premium-client.js';
import { getModuleContext, getRepoPreturnBundle, getRepoRoutingSignals } from './runtime.js';
import { getModuleContext as getFallbackModuleContext } from './query.js';

function createWorkspaceFixture(workspaceRoot: string): void {
  mkdirSync(join(workspaceRoot, 'packages', 'app', 'src'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'workspace-root' }, null, 2));
  writeFileSync(join(workspaceRoot, 'packages', 'app', 'package.json'), JSON.stringify({ name: '@demo/app' }, null, 2));
  writeFileSync(
    join(workspaceRoot, 'packages', 'app', 'src', 'index.ts'),
    [
      'export function runApp(name: string): string {',
      '  return name.trim();',
      '}',
      '',
    ].join('\n'),
  );
}

describe('repo-intelligence runtime facade', () => {
  let tempDir = '';
  const mockedCallPremiumDaemon = vi.mocked(callPremiumDaemon);
  let originalEndpoint: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-runtime-ri-'));
    createWorkspaceFixture(tempDir);
    mockedCallPremiumDaemon.mockReset();
    originalEndpoint = process.env.KODAX_REPOINTEL_ENDPOINT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEndpoint === undefined) {
      delete process.env.KODAX_REPOINTEL_ENDPOINT;
    } else {
      process.env.KODAX_REPOINTEL_ENDPOINT = originalEndpoint;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('falls back to the OSS baseline when premium is unavailable', async () => {
    mockedCallPremiumDaemon.mockResolvedValue(null);

    const result = await getModuleContext(
      { executionCwd: tempDir },
      {
        targetPath: '.',
        mode: 'premium-native',
      },
    );

    expect(result.capability).toMatchObject({
      mode: 'oss',
      engine: 'oss',
      level: 'basic',
    });
    expect(result.capability?.warnings.join(' ')).toContain('Premium repo intelligence unavailable');
  });

  it('preserves premium preturn metadata and summaries when the daemon responds', async () => {
    const fallbackModuleContext = await getFallbackModuleContext(
      { executionCwd: tempDir },
      {
        targetPath: '.',
      },
    );

    mockedCallPremiumDaemon.mockResolvedValue({
      response: {
        contractVersion: 1,
        status: 'ok',
        cacheHit: true,
        trace: {
          capsuleEstimatedTokens: 111,
        },
        result: {
          summary: 'premium preturn summary',
          repoContext: 'premium repo context',
          recommendedFiles: ['packages/app/src/index.ts'],
          lowConfidence: false,
          moduleContext: fallbackModuleContext,
        },
      },
      trace: {
        mode: 'premium-native',
        engine: 'premium',
        bridge: 'native',
        triggeredAt: '2026-04-01T00:00:00.000Z',
        source: 'premium',
        daemonLatencyMs: 9,
        cacheHit: true,
        capsuleEstimatedTokens: 111,
      },
    });

    const bundle = await getRepoPreturnBundle(
      { executionCwd: tempDir },
      {
        targetPath: '.',
        mode: 'premium-native',
      },
    );

    expect(bundle.summary).toBe('premium preturn summary');
    expect(bundle.repoContext).toBe('premium repo context');
    expect(bundle.recommendedFiles).toEqual(['packages/app/src/index.ts']);
    expect(bundle.capability).toMatchObject({
      mode: 'premium-native',
      engine: 'premium',
      bridge: 'native',
      level: 'enhanced',
      contractVersion: 1,
    });
    expect(bundle.trace).toMatchObject({
      daemonLatencyMs: 9,
      capsuleEstimatedTokens: 111,
      cacheHit: true,
    });
    expect(bundle.moduleContext?.capability).toMatchObject({
      mode: 'premium-native',
      engine: 'premium',
    });
  });

  it('reuses the same premium preturn response across routing and prompt preturn calls', async () => {
    mockedCallPremiumDaemon.mockResolvedValue({
      response: {
        contractVersion: 1,
        status: 'ok',
        result: {
          summary: 'shared premium preturn',
          repoContext: 'repo context',
          recommendedFiles: ['packages/app/src/index.ts'],
          lowConfidence: false,
          routingSignals: {
            changedFileCount: 1,
            changedLineCount: 3,
            addedLineCount: 3,
            deletedLineCount: 0,
            touchedModuleCount: 1,
            changedModules: ['@demo/app'],
            crossModule: false,
            activeModuleId: '@demo/app',
            plannerBias: false,
            investigationBias: false,
            lowConfidence: false,
            riskHints: [],
          },
        },
      },
      trace: {
        mode: 'premium-native',
        engine: 'premium',
        bridge: 'native',
        triggeredAt: '2026-04-01T00:00:00.000Z',
        source: 'premium',
        daemonLatencyMs: 5,
      },
    });

    const context = { executionCwd: tempDir };
    const routing = await getRepoRoutingSignals(context, {
      targetPath: '.',
      mode: 'premium-native',
    });
    const bundle = await getRepoPreturnBundle(context, {
      targetPath: '.',
      mode: 'premium-native',
    });

    expect(routing.capability).toMatchObject({
      mode: 'premium-native',
      engine: 'premium',
    });
    expect(bundle.summary).toBe('shared premium preturn');
    expect(mockedCallPremiumDaemon).toHaveBeenCalledTimes(1);
  });

  it('falls back to OSS when premium returns malformed preturn payloads', async () => {
    mockedCallPremiumDaemon.mockResolvedValue({
      response: {
        contractVersion: 1,
        status: 'ok',
        result: {
          summary: 'bad payload',
          moduleContext: {
            freshness: 'now',
          },
        },
      },
      trace: {
        mode: 'premium-native',
        engine: 'premium',
        bridge: 'native',
        triggeredAt: '2026-04-01T00:00:00.000Z',
        source: 'premium',
      },
    });

    const bundle = await getRepoPreturnBundle(
      { executionCwd: tempDir },
      {
        targetPath: '.',
        mode: 'premium-native',
      },
    );

    expect(bundle.capability).toMatchObject({
      mode: 'oss',
      engine: 'oss',
      level: 'basic',
    });
    expect(bundle.summary).not.toBe('bad payload');
  });

  it('does not reuse a cached premium preturn after switching the repointel endpoint', async () => {
    mockedCallPremiumDaemon
      .mockResolvedValueOnce({
        response: {
          contractVersion: 1,
          status: 'ok',
          result: {
            summary: 'endpoint-one',
            repoContext: 'repo context one',
            recommendedFiles: ['packages/app/src/index.ts'],
            lowConfidence: false,
          },
        },
        trace: {
          mode: 'premium-native',
          engine: 'premium',
          bridge: 'native',
          triggeredAt: '2026-04-01T00:00:00.000Z',
          source: 'premium',
          daemonLatencyMs: 4,
        },
      })
      .mockResolvedValueOnce({
        response: {
          contractVersion: 1,
          status: 'ok',
          result: {
            summary: 'endpoint-two',
            repoContext: 'repo context two',
            recommendedFiles: ['packages/app/src/index.ts'],
            lowConfidence: false,
          },
        },
        trace: {
          mode: 'premium-native',
          engine: 'premium',
          bridge: 'native',
          triggeredAt: '2026-04-01T00:00:01.000Z',
          source: 'premium',
          daemonLatencyMs: 6,
        },
      });

    process.env.KODAX_REPOINTEL_ENDPOINT = 'http://127.0.0.1:47891';
    const first = await getRepoPreturnBundle(
      { executionCwd: tempDir },
      {
        targetPath: '.',
        mode: 'premium-native',
      },
    );

    process.env.KODAX_REPOINTEL_ENDPOINT = 'http://127.0.0.1:47892';
    const second = await getRepoPreturnBundle(
      { executionCwd: tempDir },
      {
        targetPath: '.',
        mode: 'premium-native',
      },
    );

    expect(first.summary).toBe('endpoint-one');
    expect(second.summary).toBe('endpoint-two');
    expect(mockedCallPremiumDaemon).toHaveBeenCalledTimes(2);
  });
});
