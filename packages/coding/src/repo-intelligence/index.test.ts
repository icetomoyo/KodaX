import fsPromises from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRepoIntelligenceContext, getRepoOverview } from './index.js';
import { getImpactEstimate, getRepoRoutingSignals } from './query.js';
import { commitAll, initGitRepo } from '../tools/test-helpers.js';

function createWorkspaceFixture(workspaceRoot: string): void {
  mkdirSync(join(workspaceRoot, 'packages', 'app', 'src'), { recursive: true });
  mkdirSync(join(workspaceRoot, 'docs'), { recursive: true });

  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'workspace-root' }, null, 2));
  writeFileSync(join(workspaceRoot, 'packages', 'app', 'package.json'), JSON.stringify({ name: '@demo/app' }, null, 2));
  writeFileSync(join(workspaceRoot, 'packages', 'app', 'src', 'index.ts'), [
    'export function startServer(name: string): string {',
    '  return name.trim();',
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(workspaceRoot, 'docs', 'PRD.md'), '# PRD\n');
}

function getStorageRoot(workspaceRoot: string): string {
  return join(workspaceRoot, '.agent', 'repo-intelligence');
}

function forceDirtyOverviewArtifacts(workspaceRoot: string): void {
  const storageRoot = getStorageRoot(workspaceRoot);
  for (const fileName of [
    'manifest.json',
    'repo-overview.json',
    'repo-overview-inventory.json',
  ]) {
    rmSync(join(storageRoot, fileName), { force: true });
  }
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function writeJson(filePath: string, payload: unknown): void {
  writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function collectOverviewWritePaths(calls: Array<unknown[]>, workspaceRoot: string): string[] {
  return calls
    .map(([filePath]) => typeof filePath === 'string' ? filePath : null)
    .filter((filePath): filePath is string => filePath !== null && filePath.startsWith(getStorageRoot(workspaceRoot)))
    .map((filePath) => filePath.replace(/\\/g, '/'))
    .filter((filePath) =>
      filePath.endsWith('/manifest.json')
      || filePath.endsWith('/repo-overview.json')
      || filePath.endsWith('/repo-overview-inventory.json'),
    )
    .sort((left, right) => left.localeCompare(right));
}

describe('repo overview baseline cache', () => {
  let tempDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('rebuilds filesystem overviews when cached overview artifacts are on an older schema', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-overview-filesystem-schema-'));
    createWorkspaceFixture(tempDir);

    const initial = await getRepoOverview({ executionCwd: tempDir }, { refresh: true });
    const storageRoot = getStorageRoot(tempDir);
    const overviewPath = join(storageRoot, 'repo-overview.json');
    const inventoryPath = join(storageRoot, 'repo-overview-inventory.json');

    writeJson(overviewPath, {
      ...readJson<Record<string, unknown>>(overviewPath),
      schemaVersion: 0,
    });
    writeJson(inventoryPath, {
      ...readJson<Record<string, unknown>>(inventoryPath),
      schemaVersion: 0,
    });

    const rebuilt = await getRepoOverview({ executionCwd: tempDir }, { refresh: false });
    const rebuiltInventory = readJson<{ schemaVersion: number; overviewGeneratedAt: string }>(inventoryPath);

    expect(rebuilt.source).toBe('filesystem');
    expect(rebuilt.schemaVersion).toBe(initial.schemaVersion);
    expect(rebuilt.generatedAt).not.toBe(initial.generatedAt);
    expect(rebuiltInventory.schemaVersion).toBe(initial.schemaVersion);
    expect(rebuiltInventory.overviewGeneratedAt).toBe(rebuilt.generatedAt);
  }, 15000);

  it('does not write clean baseline artifacts for filesystem workspaces', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-overview-filesystem-no-baseline-'));
    createWorkspaceFixture(tempDir);

    const storageRoot = getStorageRoot(tempDir);
    await getRepoOverview({ executionCwd: tempDir }, { refresh: true });

    expect(existsSync(join(storageRoot, 'repo-overview-baseline.json'))).toBe(false);
    expect(existsSync(join(storageRoot, 'repo-overview-inventory-baseline.json'))).toBe(false);

    writeFileSync(join(tempDir, 'docs', 'NOTES.md'), '# Notes\n');
    await getRepoOverview({ executionCwd: tempDir }, { refresh: false });

    expect(existsSync(join(storageRoot, 'repo-overview-baseline.json'))).toBe(false);
    expect(existsSync(join(storageRoot, 'repo-overview-inventory-baseline.json'))).toBe(false);
  }, 15000);

  it('rebuilds filesystem overviews when the file set changes under refresh=false', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-overview-filesystem-file-set-'));
    createWorkspaceFixture(tempDir);

    const initial = await getRepoOverview({ executionCwd: tempDir }, { refresh: true });
    writeFileSync(join(tempDir, 'packages', 'app', 'src', 'stop-server.ts'), [
      'export function stopServer(name: string): string {',
      '  return name.trim();',
      '}',
      '',
    ].join('\n'));

    const updated = await getRepoOverview({ executionCwd: tempDir }, { refresh: false });
    const currentInventory = readJson<{ allFiles: string[] }>(join(getStorageRoot(tempDir), 'repo-overview-inventory.json'));

    expect(updated.generatedAt).not.toBe(initial.generatedAt);
    expect(currentInventory.allFiles).toContain('packages/app/src/stop-server.ts');
  }, 15000);

  it('rebuilds filesystem overviews when area-label manifests change under refresh=false', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-overview-filesystem-manifest-'));
    createWorkspaceFixture(tempDir);

    await getRepoOverview({ executionCwd: tempDir }, { refresh: true });
    writeFileSync(join(tempDir, 'packages', 'app', 'package.json'), JSON.stringify({ name: '@demo/app-v2' }, null, 2));

    const updated = await getRepoOverview({ executionCwd: tempDir }, { refresh: false });

    expect(updated.areas.some((area) => area.root === 'packages/app' && area.label === '@demo/app-v2')).toBe(true);
  }, 15000);

  it('builds dirty overviews from the clean baseline without overwriting the baseline files', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-overview-baseline-'));
    initGitRepo(tempDir);
    createWorkspaceFixture(tempDir);
    commitAll(tempDir, 'initial');

    const clean = await getRepoOverview({ executionCwd: tempDir }, { refresh: true });
    const storageRoot = getStorageRoot(tempDir);
    const baselineOverview = readJson<{ generatedAt: string }>(join(storageRoot, 'repo-overview-baseline.json'));

    writeFileSync(join(tempDir, 'docs', 'NOTES.md'), '# Notes\n');

    const dirty = await getRepoOverview({ executionCwd: tempDir }, { refresh: false });
    const currentInventory = readJson<{ allFiles: string[] }>(join(storageRoot, 'repo-overview-inventory.json'));
    const baselineInventory = readJson<{ allFiles: string[] }>(join(storageRoot, 'repo-overview-inventory-baseline.json'));
    const baselineOverviewAfter = readJson<{ generatedAt: string }>(join(storageRoot, 'repo-overview-baseline.json'));

    expect(dirty.git?.hasUncommittedChanges).toBe(true);
    expect(dirty.generatedAt).not.toBe(clean.generatedAt);
    expect(currentInventory.allFiles).toContain('docs/NOTES.md');
    expect(baselineInventory.allFiles).not.toContain('docs/NOTES.md');
    expect(baselineOverviewAfter.generatedAt).toBe(baselineOverview.generatedAt);
  }, 15000);

  it('directly reuses identical dirty snapshots without rewriting overview artifacts', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-overview-direct-hit-'));
    initGitRepo(tempDir);
    createWorkspaceFixture(tempDir);
    commitAll(tempDir, 'initial');

    await getRepoOverview({ executionCwd: tempDir }, { refresh: true });
    writeFileSync(join(tempDir, 'docs', 'PRD.md'), '# PRD\n\nUpdated details.\n');

    const firstDirty = await getRepoOverview({ executionCwd: tempDir }, { refresh: false });
    const writeSpy = vi.spyOn(fsPromises, 'writeFile');
    const secondDirty = await getRepoOverview({ executionCwd: tempDir }, { refresh: false });

    expect(secondDirty.generatedAt).toBe(firstDirty.generatedAt);
    expect(collectOverviewWritePaths(writeSpy.mock.calls as Array<unknown[]>, tempDir)).toEqual([]);
  }, 15000);

  it('rebuilds dirty overview when a tracked dirty path changes from present to missing under the same path set', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-overview-present-missing-'));
    initGitRepo(tempDir);
    createWorkspaceFixture(tempDir);
    commitAll(tempDir, 'initial');

    await getRepoOverview({ executionCwd: tempDir }, { refresh: true });

    writeFileSync(join(tempDir, 'docs', 'PRD.md'), '# PRD\n\nChanged while present.\n');
    const firstDirty = await getRepoOverview({ executionCwd: tempDir }, { refresh: false });

    rmSync(join(tempDir, 'docs', 'PRD.md'));
    const secondDirty = await getRepoOverview({ executionCwd: tempDir }, { refresh: false });
    const currentInventory = readJson<{ allFiles: string[] }>(join(getStorageRoot(tempDir), 'repo-overview-inventory.json'));

    expect(secondDirty.generatedAt).not.toBe(firstDirty.generatedAt);
    expect(currentInventory.allFiles).not.toContain('docs/PRD.md');
  }, 15000);

  it('rebuilds dirty overview when a tracked dirty path changes from missing to present under the same path set', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-overview-missing-present-'));
    initGitRepo(tempDir);
    createWorkspaceFixture(tempDir);
    commitAll(tempDir, 'initial');

    await getRepoOverview({ executionCwd: tempDir }, { refresh: true });

    rmSync(join(tempDir, 'docs', 'PRD.md'));
    const firstDirty = await getRepoOverview({ executionCwd: tempDir }, { refresh: false });

    writeFileSync(join(tempDir, 'docs', 'PRD.md'), '# PRD\n\nRestored but still dirty.\n');
    const secondDirty = await getRepoOverview({ executionCwd: tempDir }, { refresh: false });
    const currentInventory = readJson<{ allFiles: string[] }>(join(getStorageRoot(tempDir), 'repo-overview-inventory.json'));

    expect(secondDirty.generatedAt).not.toBe(firstDirty.generatedAt);
    expect(currentInventory.allFiles).toContain('docs/PRD.md');
  }, 15000);

  it('refreshes dirty overview when semantic manifest content changes under the same dirty path set', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-overview-dirty-semantic-'));
    initGitRepo(tempDir);
    createWorkspaceFixture(tempDir);
    commitAll(tempDir, 'initial');

    await getRepoOverview({ executionCwd: tempDir }, { refresh: true });

    writeFileSync(join(tempDir, 'packages', 'app', 'package.json'), JSON.stringify({ name: '@demo/app-v2' }, null, 2));
    const firstDirty = await getRepoOverview({ executionCwd: tempDir }, { refresh: false });

    writeFileSync(join(tempDir, 'packages', 'app', 'package.json'), JSON.stringify({ name: '@demo/app-v3' }, null, 2));
    const secondDirty = await getRepoOverview({ executionCwd: tempDir }, { refresh: false });

    expect(secondDirty.generatedAt).not.toBe(firstDirty.generatedAt);
    expect(secondDirty.areas.some((area) => area.root === 'packages/app' && area.label === '@demo/app-v3')).toBe(true);
  }, 15000);

  it('rebuilds dirty inventories from the clean baseline after a revert instead of rolling the previous dirty snapshot', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-overview-revert-'));
    initGitRepo(tempDir);
    createWorkspaceFixture(tempDir);
    commitAll(tempDir, 'initial');

    await getRepoOverview({ executionCwd: tempDir }, { refresh: true });
    const storageRoot = getStorageRoot(tempDir);

    renameSync(
      join(tempDir, 'packages', 'app', 'src', 'index.ts'),
      join(tempDir, 'packages', 'app', 'src', 'server.ts'),
    );
    await getRepoOverview({ executionCwd: tempDir }, { refresh: false });
    const renamedInventory = readJson<{ allFiles: string[] }>(join(storageRoot, 'repo-overview-inventory.json'));
    expect(renamedInventory.allFiles).toContain('packages/app/src/server.ts');
    expect(renamedInventory.allFiles).not.toContain('packages/app/src/index.ts');

    renameSync(
      join(tempDir, 'packages', 'app', 'src', 'server.ts'),
      join(tempDir, 'packages', 'app', 'src', 'index.ts'),
    );
    writeFileSync(join(tempDir, 'docs', 'NOTES.md'), '# Keep dirty\n');

    await getRepoOverview({ executionCwd: tempDir }, { refresh: false });
    const revertedInventory = readJson<{ allFiles: string[] }>(join(storageRoot, 'repo-overview-inventory.json'));

    expect(revertedInventory.allFiles).toContain('packages/app/src/index.ts');
    expect(revertedInventory.allFiles).not.toContain('packages/app/src/server.ts');
  }, 15000);

  it('falls back to a full dirty build when no clean baseline exists yet', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-overview-no-baseline-'));
    initGitRepo(tempDir);
    createWorkspaceFixture(tempDir);
    commitAll(tempDir, 'initial');

    writeFileSync(join(tempDir, 'docs', 'NOTES.md'), '# Dirty before baseline\n');

    const dirty = await getRepoOverview({ executionCwd: tempDir }, { refresh: false });
    const storageRoot = getStorageRoot(tempDir);
    const currentInventory = readJson<{ allFiles: string[] }>(join(storageRoot, 'repo-overview-inventory.json'));

    expect(dirty.git?.hasUncommittedChanges).toBe(true);
    expect(currentInventory.allFiles).toContain('docs/NOTES.md');
    expect(existsSync(join(storageRoot, 'repo-overview-baseline.json'))).toBe(false);
    expect(existsSync(join(storageRoot, 'repo-overview-inventory-baseline.json'))).toBe(false);
  }, 15000);

  it('best-effort patches truncated baselines when dirty paths stay inside the known inventory', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-overview-truncated-best-effort-'));
    initGitRepo(tempDir);
    createWorkspaceFixture(tempDir);
    commitAll(tempDir, 'initial');

    await getRepoOverview({ executionCwd: tempDir }, { refresh: true });
    const storageRoot = getStorageRoot(tempDir);
    const baselineOverviewPath = join(storageRoot, 'repo-overview-baseline.json');
    const baselineOverview = readJson<{ truncated: boolean }>(baselineOverviewPath);
    writeJson(baselineOverviewPath, {
      ...baselineOverview,
      truncated: true,
    });

    const baselineInventory = readJson<{ allFiles: string[] }>(join(storageRoot, 'repo-overview-inventory-baseline.json'));
    writeFileSync(join(tempDir, 'docs', 'PRD.md'), '# PRD\n\nEdited while dirty.\n');

    const dirty = await getRepoOverview({ executionCwd: tempDir }, { refresh: false });
    const currentInventory = readJson<{ allFiles: string[] }>(join(storageRoot, 'repo-overview-inventory.json'));

    expect(dirty.truncated).toBe(true);
    expect(currentInventory.allFiles).toEqual(baselineInventory.allFiles);
  }, 15000);

  it('falls back to a full dirty build when a truncated baseline sees a deleted baseline-known file', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-overview-truncated-delete-fallback-'));
    initGitRepo(tempDir);
    createWorkspaceFixture(tempDir);
    commitAll(tempDir, 'initial');

    await getRepoOverview({ executionCwd: tempDir }, { refresh: true });
    const storageRoot = getStorageRoot(tempDir);
    const baselineOverviewPath = join(storageRoot, 'repo-overview-baseline.json');
    const baselineOverview = readJson<{ truncated: boolean }>(baselineOverviewPath);
    writeJson(baselineOverviewPath, {
      ...baselineOverview,
      truncated: true,
    });

    rmSync(join(tempDir, 'packages', 'app', 'src', 'index.ts'));

    const dirty = await getRepoOverview({ executionCwd: tempDir }, { refresh: false });
    const currentInventory = readJson<{ allFiles: string[] }>(join(storageRoot, 'repo-overview-inventory.json'));

    expect(dirty.truncated).toBe(false);
    expect(currentInventory.allFiles).not.toContain('packages/app/src/index.ts');
  }, 15000);

  it('falls back to a full dirty build when a truncated baseline sees a renamed baseline-known file', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-overview-truncated-rename-fallback-'));
    initGitRepo(tempDir);
    createWorkspaceFixture(tempDir);
    commitAll(tempDir, 'initial');

    await getRepoOverview({ executionCwd: tempDir }, { refresh: true });
    const storageRoot = getStorageRoot(tempDir);
    const baselineOverviewPath = join(storageRoot, 'repo-overview-baseline.json');
    const baselineOverview = readJson<{ truncated: boolean }>(baselineOverviewPath);
    writeJson(baselineOverviewPath, {
      ...baselineOverview,
      truncated: true,
    });

    renameSync(
      join(tempDir, 'packages', 'app', 'src', 'index.ts'),
      join(tempDir, 'packages', 'app', 'src', 'server.ts'),
    );

    const dirty = await getRepoOverview({ executionCwd: tempDir }, { refresh: false });
    const currentInventory = readJson<{ allFiles: string[] }>(join(storageRoot, 'repo-overview-inventory.json'));

    expect(dirty.truncated).toBe(false);
    expect(currentInventory.allFiles).toContain('packages/app/src/server.ts');
    expect(currentInventory.allFiles).not.toContain('packages/app/src/index.ts');
  }, 15000);

  it('falls back to a full dirty build when a truncated baseline sees baseline-external files', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-overview-truncated-fallback-'));
    initGitRepo(tempDir);
    createWorkspaceFixture(tempDir);
    commitAll(tempDir, 'initial');

    await getRepoOverview({ executionCwd: tempDir }, { refresh: true });
    const storageRoot = getStorageRoot(tempDir);
    const baselineOverviewPath = join(storageRoot, 'repo-overview-baseline.json');
    const baselineOverview = readJson<{ truncated: boolean }>(baselineOverviewPath);
    writeJson(baselineOverviewPath, {
      ...baselineOverview,
      truncated: true,
    });

    writeFileSync(join(tempDir, 'docs', 'NOTES.md'), '# Baseline external file\n');

    const dirty = await getRepoOverview({ executionCwd: tempDir }, { refresh: false });
    const currentInventory = readJson<{ allFiles: string[] }>(join(storageRoot, 'repo-overview-inventory.json'));

    expect(dirty.truncated).toBe(false);
    expect(currentInventory.allFiles).toContain('docs/NOTES.md');
  }, 15000);

  it('writes dirty overview artifacts only once for routing signals, impact estimate, and repo-intelligence context', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-overview-shared-snapshot-'));
    initGitRepo(tempDir);
    createWorkspaceFixture(tempDir);
    commitAll(tempDir, 'initial');

    await getRepoOverview({ executionCwd: tempDir }, { refresh: true });
    writeFileSync(join(tempDir, 'docs', 'PRD.md'), '# PRD\n\nUpdated details.\n');

    await getRepoRoutingSignals({ executionCwd: tempDir }, { refresh: false });
    expect(existsSync(join(getStorageRoot(tempDir), 'manifest.json'))).toBe(true);
    expect(existsSync(join(getStorageRoot(tempDir), 'repo-overview-inventory.json'))).toBe(true);
    expect(existsSync(join(getStorageRoot(tempDir), 'repo-overview.json'))).toBe(true);

    forceDirtyOverviewArtifacts(tempDir);
    await getImpactEstimate({ executionCwd: tempDir }, {
      module: '@demo/app',
      refresh: false,
    });
    expect(existsSync(join(getStorageRoot(tempDir), 'manifest.json'))).toBe(true);
    expect(existsSync(join(getStorageRoot(tempDir), 'repo-overview-inventory.json'))).toBe(true);
    expect(existsSync(join(getStorageRoot(tempDir), 'repo-overview.json'))).toBe(true);

    forceDirtyOverviewArtifacts(tempDir);
    await buildRepoIntelligenceContext({ executionCwd: tempDir }, {
      includeRepoOverview: true,
      includeChangedScope: true,
      refreshOverview: false,
    });
    expect(existsSync(join(getStorageRoot(tempDir), 'manifest.json'))).toBe(true);
    expect(existsSync(join(getStorageRoot(tempDir), 'repo-overview-inventory.json'))).toBe(true);
    expect(existsSync(join(getStorageRoot(tempDir), 'repo-overview.json'))).toBe(true);
  }, 20000);
});
