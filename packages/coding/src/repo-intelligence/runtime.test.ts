import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRepoIntelligenceStorageRoot } from './internal.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getModuleContext,
  getRepoPreturnBundle,
  getRepoRoutingSignals,
  inspectRepoIntelligenceRuntime,
  prewarmRepoIntelligenceCaches,
  resolveKodaXHotPathRepoMode,
  _getRepoIntelligenceCacheSizesForTesting,
  _resetRepoIntelligenceCachesForTesting,
} from './runtime.js';
import {
  isRepoIntelligenceWorkerRunningForTest,
  shutdownRepoIntelligenceWorkerForTest,
} from './semantic-worker-client.js';

function createWorkspaceFixture(workspaceRoot: string): void {
  mkdirSync(join(workspaceRoot, 'packages', 'app', 'src'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'workspace-root' }, null, 2));
  writeFileSync(join(workspaceRoot, 'packages', 'app', 'package.json'), JSON.stringify({ name: '@demo/app' }, null, 2));
  writeFileSync(
    join(workspaceRoot, 'packages', 'app', 'src', 'index.ts'),
    [
      'export function trimName(name: string): string {',
      '  return name.trim();',
      '}',
      '',
      'export function runApp(name: string): string {',
      '  return trimName(name).toUpperCase();',
      '}',
      '',
    ].join('\n'),
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function removeTempDirWithRetries(dir: string): Promise<void> {
  const delaysMs = [0, 100, 250, 500, 1_000] as const;
  let lastError: unknown;
  for (const delayMs of delaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error(String(lastError));
}

describe('repo-intelligence runtime facade', () => {
  let tempDir = '';
  const originalEnv = {
    intelligence: process.env.KODAX_REPO_INTELLIGENCE,
    legacyMode: process.env.KODAX_REPO_INTELLIGENCE_MODE,
    legacyEndpoint: process.env.KODAX_REPOINTEL_ENDPOINT,
    legacyBin: process.env.KODAX_REPOINTEL_BIN,
    legacyBuildId: process.env.KODAX_REPOINTEL_BUILD_ID,
    prewarm: process.env.KODAX_PREWARM_REPO_INTELLIGENCE,
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-runtime-ri-'));
    createWorkspaceFixture(tempDir);
    _resetRepoIntelligenceCachesForTesting();
    delete process.env.KODAX_REPO_INTELLIGENCE;
    delete process.env.KODAX_REPO_INTELLIGENCE_MODE;
    delete process.env.KODAX_REPOINTEL_ENDPOINT;
    delete process.env.KODAX_REPOINTEL_BIN;
    delete process.env.KODAX_REPOINTEL_BUILD_ID;
    delete process.env.KODAX_PREWARM_REPO_INTELLIGENCE;
  });

  afterEach(async () => {
    vi.useRealTimers();
    _resetRepoIntelligenceCachesForTesting();
    restoreEnv('KODAX_REPO_INTELLIGENCE', originalEnv.intelligence);
    restoreEnv('KODAX_REPO_INTELLIGENCE_MODE', originalEnv.legacyMode);
    restoreEnv('KODAX_REPOINTEL_ENDPOINT', originalEnv.legacyEndpoint);
    restoreEnv('KODAX_REPOINTEL_BIN', originalEnv.legacyBin);
    restoreEnv('KODAX_REPOINTEL_BUILD_ID', originalEnv.legacyBuildId);
    restoreEnv('KODAX_PREWARM_REPO_INTELLIGENCE', originalEnv.prewarm);
    await shutdownRepoIntelligenceWorkerForTest();
    if (tempDir) {
      await removeTempDirWithRetries(tempDir);
      tempDir = '';
    }
  });

  it('uses the built-in full engine by default', async () => {
    const result = await getModuleContext(
      { executionCwd: tempDir },
      {
        targetPath: 'packages/app/src/index.ts',
        mode: 'full',
      },
    );

    expect(result.capability).toMatchObject({
      mode: 'full',
      engine: 'full',
      level: 'enhanced',
      status: 'ok',
    });
    expect(result.module.sourceFileCount).toBeGreaterThan(0);
  });

  it('keeps the repo-intelligence worker warm across the first prompt window', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await getModuleContext(
      { executionCwd: tempDir },
      {
        targetPath: 'packages/app/src/index.ts',
        mode: 'full',
      },
    );
    expect(isRepoIntelligenceWorkerRunningForTest()).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(isRepoIntelligenceWorkerRunningForTest()).toBe(true);

    await getModuleContext(
      { executionCwd: tempDir },
      {
        targetPath: 'packages/app/src/index.ts',
        mode: 'full',
      },
    );
    await vi.advanceTimersByTimeAsync(60_000);

    expect(isRepoIntelligenceWorkerRunningForTest()).toBe(false);
  });

  it('keeps the shared light profile available', async () => {
    const result = await getModuleContext(
      { executionCwd: tempDir },
      {
        targetPath: 'packages/app/src/index.ts',
        mode: 'light',
      },
    );

    expect(result.capability).toMatchObject({
      mode: 'light',
      engine: 'light',
      level: 'basic',
    });
  });

  it('builds preturn bundles from the built-in full engine', async () => {
    const bundle = await getRepoPreturnBundle(
      { executionCwd: tempDir },
      {
        targetPath: 'packages/app/src/index.ts',
        mode: 'full',
      },
    );

    expect(bundle.capability).toMatchObject({
      mode: 'full',
      engine: 'full',
      level: 'enhanced',
    });
    expect(bundle.moduleContext?.capability).toMatchObject({
      mode: 'full',
      engine: 'full',
    });
    expect(bundle.routingSignals?.capability).toMatchObject({
      mode: 'full',
      engine: 'full',
    });
    expect(bundle.summary).toContain('active module:');
    expect(bundle.recommendedFiles?.some((file) => file.endsWith('index.ts'))).toBe(true);
  });

  it('does not key the built-in full cache by legacy repointel endpoint', async () => {
    process.env.KODAX_REPOINTEL_ENDPOINT = 'http://127.0.0.1:47891';
    const first = await getRepoPreturnBundle(
      { executionCwd: tempDir },
      {
        targetPath: 'packages/app/src/index.ts',
        mode: 'full',
      },
    );

    process.env.KODAX_REPOINTEL_ENDPOINT = 'http://127.0.0.1:47892';
    const second = await getRepoPreturnBundle(
      { executionCwd: tempDir },
      {
        targetPath: 'packages/app/src/index.ts',
        mode: 'full',
      },
    );

    expect(second.summary).toBe(first.summary);
  });

  it('ignores legacy mode and bridge env vars during runtime inspection', async () => {
    process.env.KODAX_REPO_INTELLIGENCE_MODE = 'premium-native';
    process.env.KODAX_REPOINTEL_ENDPOINT = 'http://127.0.0.1:47891';
    process.env.KODAX_REPOINTEL_BIN = 'C:/tmp/repointel.exe';
    process.env.KODAX_REPOINTEL_BUILD_ID = 'old';

    const inspection = await inspectRepoIntelligenceRuntime();

    // Auto keeps the semantic engine off; only an explicit full or light opts in.
    expect(inspection.requestedMode).toBe('off');
    expect(inspection.effectiveEngine).toBe('off');
    expect(inspection.warnings.join(' ')).toContain('The semantic index is off by default');
    expect(inspection.warnings.join(' ')).toContain('Ignoring deprecated KODAX_REPO_INTELLIGENCE_MODE');
    expect(inspection.warnings.join(' ')).toContain('Ignoring legacy KODAX_REPOINTEL_ENDPOINT');
    expect(inspection.warnings.join(' ')).toContain('Ignoring legacy KODAX_REPOINTEL_BIN');
    expect(inspection.warnings.join(' ')).toContain('Ignoring legacy KODAX_REPOINTEL_BUILD_ID');
  });

  it('probes built-in worker sidecar and cache writability during runtime inspection', async () => {
    const inspection = await inspectRepoIntelligenceRuntime({
      mode: 'full',
      probe: true,
      workspaceRoot: tempDir,
    });

    expect(inspection.status).toBe('ok');
    expect(inspection.workerPath).toContain('semantic-worker');
    expect(inspection.storageRoot).toBe(resolveRepoIntelligenceStorageRoot(tempDir));
  });

  it('keeps automatic hot paths on the resolved full engine', () => {
    expect(resolveKodaXHotPathRepoMode()).toBe('full');
    expect(resolveKodaXHotPathRepoMode('auto')).toBe('full');
    expect(resolveKodaXHotPathRepoMode('light')).toBe('light');
    expect(resolveKodaXHotPathRepoMode('full')).toBe('full');
    expect(resolveKodaXHotPathRepoMode('off')).toBe('off');
  });

  it('does not prewarm repo intelligence when startup prewarm is disabled', async () => {
    process.env.KODAX_PREWARM_REPO_INTELLIGENCE = '0';
    prewarmRepoIntelligenceCaches({ executionCwd: tempDir }, { mode: 'auto' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(resolveRepoIntelligenceStorageRoot(tempDir))).toBe(false);
  });

  it('does not schedule startup prewarm outside full mode', async () => {
    vi.useFakeTimers();
    process.env.KODAX_REPO_INTELLIGENCE = 'light';

    prewarmRepoIntelligenceCaches({ executionCwd: tempDir }, { mode: 'auto' });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(existsSync(resolveRepoIntelligenceStorageRoot(tempDir))).toBe(false);
  });

  it('coalesces concurrent routing and preturn requests on the full engine', async () => {
    const context = { executionCwd: tempDir };
    const options = {
      targetPath: 'packages/app/src/index.ts',
      mode: 'full' as const,
    };

    const [routing, bundle] = await Promise.all([
      getRepoRoutingSignals(context, options),
      getRepoPreturnBundle(context, options),
    ]);

    expect(routing.capability).toMatchObject({
      mode: 'full',
      engine: 'full',
    });
    expect(bundle.capability).toMatchObject({
      mode: 'full',
      engine: 'full',
    });
  });

  it('bounds routing and preturn session caches on write', async () => {
    for (let i = 0; i < 70; i += 1) {
      const context = { executionCwd: `${tempDir}-${i}` };
      await getRepoRoutingSignals(context, { mode: 'off' });
      await getRepoPreturnBundle(context, { mode: 'off' });
    }

    expect(_getRepoIntelligenceCacheSizesForTesting()).toMatchObject({
      routingSignals: 64,
      preturnBundle: 64,
    });
  });
});
