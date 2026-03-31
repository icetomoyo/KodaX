import fsPromises from 'node:fs/promises';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as repoIndexModule from '../repo-intelligence/index.js';
import { getRepoIntelligenceIndex, getRepoRoutingSignals } from '../repo-intelligence/query.js';
import { toolModuleContext } from './module-context.js';
import { toolSymbolContext } from './symbol-context.js';
import { toolProcessContext } from './process-context.js';
import { toolImpactEstimate } from './impact-estimate.js';
import { commitAll, initGitRepo } from './test-helpers.js';

const TEST_SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.go', '.rs', '.cpp', '.cc', '.cxx', '.c', '.hpp', '.h',
]);

function createWorkspaceFixture(workspaceRoot: string): void {
  mkdirSync(join(workspaceRoot, 'packages', 'shared', 'src'), { recursive: true });
  mkdirSync(join(workspaceRoot, 'packages', 'app', 'src'), { recursive: true });
  mkdirSync(join(workspaceRoot, 'packages', 'app', 'tests'), { recursive: true });
  mkdirSync(join(workspaceRoot, 'docs'), { recursive: true });

  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'workspace-root' }, null, 2));
  writeFileSync(join(workspaceRoot, 'packages', 'shared', 'package.json'), JSON.stringify({ name: '@demo/shared' }, null, 2));
  writeFileSync(join(workspaceRoot, 'packages', 'app', 'package.json'), JSON.stringify({ name: '@demo/app' }, null, 2));
  writeFileSync(join(workspaceRoot, 'docs', 'PRD.md'), '# PRD\n');

  writeFileSync(join(workspaceRoot, 'packages', 'shared', 'src', 'utils.ts'), [
    'export function sharedUtil(input: string): string {',
    '  return input.trim().toUpperCase();',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(workspaceRoot, 'packages', 'shared', 'src', 'name-service.ts'), [
    "import { sharedUtil } from './utils';",
    '',
    'export class NameService {',
    '  normalize(input: string): string {',
    '    return sharedUtil(input);',
    '  }',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(workspaceRoot, 'packages', 'app', 'src', 'create-app.ts'), [
    "import { NameService } from '../../shared/src/name-service';",
    '',
    'export function createApp(name: string): string {',
    '  const service = new NameService();',
    '  return service.normalize(name);',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(workspaceRoot, 'packages', 'app', 'src', 'index.ts'), [
    "import { createApp } from './create-app';",
    '',
    'export function startServer(name: string): string {',
    '  return createApp(name);',
    '}',
    '',
    "startServer('demo');",
    '',
  ].join('\n'));

  writeFileSync(join(workspaceRoot, 'packages', 'app', 'tests', 'app.test.ts'), [
    "import { startServer } from '../src/index';",
    '',
    "describe('startServer', () => {",
    "  it('returns a value', () => {",
    "    expect(startServer('demo')).toBe('DEMO');",
    '  });',
    '});',
    '',
  ].join('\n'));
}

function createPolyglotFixture(workspaceRoot: string): void {
  mkdirSync(join(workspaceRoot, 'python_pkg'), { recursive: true });
  mkdirSync(join(workspaceRoot, 'go_service'), { recursive: true });
  mkdirSync(join(workspaceRoot, 'java_src'), { recursive: true });
  mkdirSync(join(workspaceRoot, 'rust_src'), { recursive: true });
  mkdirSync(join(workspaceRoot, 'cpp_src'), { recursive: true });

  writeFileSync(join(workspaceRoot, 'python_pkg', '__init__.py'), '');
  writeFileSync(join(workspaceRoot, 'python_pkg', 'helpers.py'), [
    'def normalize(value: str) -> str:',
    '    return value.strip().lower()',
    '',
  ].join('\n'));
  writeFileSync(join(workspaceRoot, 'python_pkg', 'service.py'), [
    'from .helpers import normalize',
    '',
    'class NameService:',
    '    def clean(self, value: str) -> str:',
    '        return normalize(value)',
    '',
    'def run(value: str) -> str:',
    '    service = NameService()',
    '    return service.clean(value)',
    '',
  ].join('\n'));

  writeFileSync(join(workspaceRoot, 'go_service', 'name_service.go'), [
    'package gosvc',
    '',
    'import "strings"',
    '',
    'type NameService struct {}',
    '',
    'func (s *NameService) Normalize(value string) string {',
    '  return strings.TrimSpace(value)',
    '}',
    '',
    'func Start(value string) string {',
    '  service := NameService{}',
    '  return service.Normalize(value)',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(workspaceRoot, 'java_src', 'UserService.java'), [
    'public class UserService {',
    '  public String normalize(String value) {',
    '    return value.trim();',
    '  }',
    '',
    '  public String run(String value) {',
    '    return normalize(value);',
    '  }',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(workspaceRoot, 'rust_src', 'lib.rs'), [
    'pub trait Runner {',
    '    fn run_trait(&self, value: &str) -> String;',
    '}',
    '',
    'pub struct Greeter;',
    '',
    'impl Greeter {',
    '    pub fn normalize(&self, value: &str) -> String {',
    '        value.trim().to_string()',
    '    }',
    '',
    '    pub fn run(&self, value: &str) -> String {',
    '        self.normalize(value)',
    '    }',
    '}',
    '',
    'impl Runner for Greeter {',
    '    fn run_trait(&self, value: &str) -> String {',
    '        self.normalize(value)',
    '    }',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(workspaceRoot, 'cpp_src', 'name_service.cpp'), [
    '#include <string>',
    '',
    'class NameService {',
    'public:',
    '  std::string normalize(const std::string& value);',
    '  std::string run(const std::string& value);',
    '};',
    '',
    'std::string NameService::normalize(const std::string& value) {',
    '  return value;',
    '}',
    '',
    'std::string NameService::run(const std::string& value) {',
    '  return normalize(value);',
    '}',
    '',
  ].join('\n'));
}

function getRepoIntelligenceStorageRoot(workspaceRoot: string): string {
  return join(workspaceRoot, '.agent', 'repo-intelligence');
}

function stableIndexSnapshot(index: Awaited<ReturnType<typeof getRepoIntelligenceIndex>>) {
  return {
    schemaVersion: index.schemaVersion,
    workspaceRoot: index.workspaceRoot,
    sourceFileCount: index.sourceFileCount,
    sourceFingerprint: index.sourceFingerprint,
    languages: index.languages,
    modules: index.modules,
    symbols: index.symbols,
    processes: index.processes,
  };
}

function forceQueryIndexCacheMiss(workspaceRoot: string): void {
  rmSync(getRepoIntelligenceStorageRoot(workspaceRoot), { recursive: true, force: true });
}

function forceCurrentOverviewInventoryCacheMiss(workspaceRoot: string): void {
  rmSync(join(getRepoIntelligenceStorageRoot(workspaceRoot), 'repo-overview-inventory.json'), { force: true });
}

function readJson(filePath: string): any {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJson(filePath: string, payload: unknown): void {
  writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function normalizeTestPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function collectObservedSourceStatPaths(
  calls: Array<unknown[]>,
  workspaceRoot: string,
): string[] {
  const observed = new Set<string>();

  for (const [filePath] of calls) {
    if (typeof filePath !== 'string') {
      continue;
    }

    const relativePath = normalizeTestPath(relative(workspaceRoot, filePath));
    if (
      !relativePath
      || relativePath.startsWith('..')
      || TEST_SOURCE_EXTENSIONS.has(extname(relativePath).toLowerCase()) === false
    ) {
      continue;
    }

    observed.add(relativePath);
  }

  return Array.from(observed).sort((left, right) => left.localeCompare(right));
}

describe('repo intelligence tool surfaces', () => {
  let tempDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('returns module, symbol, process, and impact capsules from local repo intelligence', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-tools-'));
    initGitRepo(tempDir);
    createWorkspaceFixture(tempDir);
    commitAll(tempDir, 'initial');

    const ctx = {
      backups: new Map<string, string>(),
      executionCwd: join(tempDir, 'packages', 'app'),
    };

    const moduleResult = await toolModuleContext({
      module: '@demo/app',
      refresh: true,
    }, ctx);
    expect(moduleResult).toContain('Module context for @demo/app');
    expect(moduleResult).toContain('Dependencies: packages/shared');
    expect(moduleResult).toContain('Top symbols:');
    expect(moduleResult).toContain('startServer');
    expect(moduleResult).toContain('createApp');

    const symbolResult = await toolSymbolContext({
      symbol: 'createApp',
      refresh: false,
    }, ctx);
    expect(symbolResult).toContain('Symbol context for createApp');
    expect(symbolResult).toContain('packages/app/src/create-app.ts');
    expect(symbolResult).toContain('Possible callees:');
    expect(symbolResult).toContain('normalize -> packages/shared/src/name-service.ts');
    expect(symbolResult).toContain('Possible callers: startServer');

    const methodResult = await toolSymbolContext({
      symbol: 'normalize',
      module: '@demo/shared',
      refresh: false,
    }, ctx);
    expect(methodResult).toContain('Symbol context for normalize');
    expect(methodResult).toContain('packages/shared/src/name-service.ts');
    expect(methodResult).toContain('Possible callers: createApp');

    const processResult = await toolProcessContext({
      entry: 'startServer',
      refresh: false,
    }, ctx);
    expect(processResult).toContain('Process context for');
    expect(processResult).toContain('startServer');
    expect(processResult).toContain('Calls createApp');
    expect(processResult).toContain('normalize');

    const impactResult = await toolImpactEstimate({
      symbol: 'sharedUtil',
      refresh: false,
    }, ctx);
    expect(impactResult).toContain('Impact estimate for sharedUtil');
    expect(impactResult).toContain('@demo/shared(packages/shared)');
    expect(impactResult).toContain('normalize -> packages/shared/src/name-service.ts');
  }, 15000);

  it('refreshes repo intelligence in filesystem mode when the source fingerprint changes', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-fingerprint-'));
    createWorkspaceFixture(tempDir);

    const ctx = {
      backups: new Map<string, string>(),
      executionCwd: tempDir,
    };

    const before = await getRepoIntelligenceIndex(ctx, {
      targetPath: 'packages/app',
      refresh: true,
    });

    writeFileSync(join(tempDir, 'packages', 'app', 'src', 'index.ts'), [
      "import { createApp } from './create-app';",
      '',
      'export function startServer(name: string): string {',
      '  return createApp(name);',
      '}',
      '',
      'export function stopServer(name: string): string {',
      '  return createApp(name);',
      '}',
      '',
      "startServer('demo');",
      '',
    ].join('\n'));

    const after = await getRepoIntelligenceIndex(ctx, {
      targetPath: 'packages/app',
      refresh: false,
    });

    expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint);
    expect(after.generatedAt).not.toBe(before.generatedAt);
    expect(after.symbols.some((symbol) => symbol.name === 'stopServer')).toBe(true);
  });

  it('refreshes repo intelligence in filesystem mode when new source files are added', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-filesystem-add-'));
    createWorkspaceFixture(tempDir);

    const ctx = {
      backups: new Map<string, string>(),
      executionCwd: tempDir,
    };

    const before = await getRepoIntelligenceIndex(ctx, {
      targetPath: 'packages/app',
      refresh: true,
    });

    writeFileSync(join(tempDir, 'packages', 'app', 'src', 'stop-server.ts'), [
      'export function stopServer(name: string): string {',
      '  return name.trim();',
      '}',
      '',
    ].join('\n'));

    const after = await getRepoIntelligenceIndex(ctx, {
      targetPath: 'packages/app',
      refresh: false,
    });

    expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint);
    expect(after.sourceFileCount).toBe(before.sourceFileCount + 1);
    expect(after.symbols.some((symbol) => symbol.name === 'stopServer' && symbol.filePath === 'src/stop-server.ts')).toBe(true);
  });

  it('uses bundled Python parsing for methods and cross-file calls', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-python-'));
    createPolyglotFixture(tempDir);

    const index = await getRepoIntelligenceIndex({
      executionCwd: tempDir,
    }, {
      targetPath: 'python_pkg',
      refresh: true,
    });

    const cleanMethod = index.symbols.find((symbol) =>
      symbol.filePath === 'service.py'
      && symbol.name === 'clean'
      && symbol.kind === 'method',
    );
    const runFunction = index.symbols.find((symbol) =>
      symbol.filePath === 'service.py'
      && symbol.name === 'run'
      && symbol.kind === 'function',
    );

    expect(cleanMethod).toBeDefined();
    expect(cleanMethod?.qualifiedName).toContain('NameService.clean');
    expect(cleanMethod?.callTargets.some((target) => target.name === 'normalize' && target.filePath === 'helpers.py')).toBe(true);
    expect(runFunction?.callTargets.some((target) => target.name === 'clean' && target.filePath === 'service.py')).toBe(true);
  }, 15000);

  it('captures richer method relationships for Go, Java, Rust, and C++', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-polyglot-'));
    createPolyglotFixture(tempDir);

    const index = await getRepoIntelligenceIndex({
      executionCwd: tempDir,
    }, {
      refresh: true,
    });

    const goMethod = index.symbols.find((symbol) =>
      symbol.filePath === 'go_service/name_service.go'
      && symbol.name === 'Normalize'
      && symbol.kind === 'method',
    );
    const goStart = index.symbols.find((symbol) =>
      symbol.filePath === 'go_service/name_service.go'
      && symbol.name === 'Start',
    );
    expect(goMethod?.qualifiedName).toContain('NameService.Normalize');
    expect(goMethod?.capabilityTier).toBe('high');
    expect(goStart?.callTargets.some((target) => target.name === 'Normalize')).toBe(true);

    const javaMethod = index.symbols.find((symbol) =>
      symbol.filePath === 'java_src/UserService.java'
      && symbol.name === 'normalize'
      && symbol.kind === 'method',
    );
    const javaRun = index.symbols.find((symbol) =>
      symbol.filePath === 'java_src/UserService.java'
      && symbol.name === 'run',
    );
    expect(javaMethod?.qualifiedName).toContain('UserService.normalize');
    expect(javaMethod?.capabilityTier).toBe('medium');
    expect(javaRun?.callTargets.some((target) => target.name === 'normalize')).toBe(true);

    const rustMethod = index.symbols.find((symbol) =>
      symbol.filePath === 'rust_src/lib.rs'
      && symbol.name === 'normalize'
      && symbol.kind === 'method',
    );
    const rustRun = index.symbols.find((symbol) =>
      symbol.filePath === 'rust_src/lib.rs'
      && symbol.name === 'run',
    );
    const rustTraitMethod = index.symbols.find((symbol) =>
      symbol.filePath === 'rust_src/lib.rs'
      && symbol.name === 'run_trait'
      && symbol.kind === 'method',
    );
    expect(rustMethod?.qualifiedName).toContain('Greeter.normalize');
    expect(rustMethod?.capabilityTier).toBe('high');
    expect(rustRun?.callTargets.some((target) => target.name === 'normalize')).toBe(true);
    expect(rustTraitMethod?.qualifiedName).toContain('Greeter.run_trait');
    expect(rustTraitMethod?.capabilityTier).toBe('high');
    expect(rustTraitMethod?.callTargets.some((target) => target.name === 'normalize')).toBe(true);

    const cppMethod = index.symbols.find((symbol) =>
      symbol.filePath === 'cpp_src/name_service.cpp'
      && symbol.name === 'normalize'
      && symbol.kind === 'method'
      && symbol.qualifiedName.includes('NameService.normalize'),
    );
    const cppRun = index.symbols.find((symbol) =>
      symbol.filePath === 'cpp_src/name_service.cpp'
      && symbol.name === 'run'
      && symbol.kind === 'method',
    );
    expect(cppMethod).toBeDefined();
    expect(cppMethod?.capabilityTier).toBe('low');
    expect(cppRun?.callTargets.some((target) => target.name === 'normalize')).toBe(true);
    expect(index.languages).toEqual(expect.arrayContaining([
      { language: 'python', capabilityTier: 'high', fileCount: 3 },
      { language: 'go', capabilityTier: 'high', fileCount: 1 },
      { language: 'java', capabilityTier: 'medium', fileCount: 1 },
      { language: 'rust', capabilityTier: 'high', fileCount: 1 },
      { language: 'cpp', capabilityTier: 'low', fileCount: 1 },
    ]));
  }, 15000);

  it('renders corrected capability tiers in module, symbol, and routing outputs', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-tier-output-'));
    createPolyglotFixture(tempDir);

    const ctx = {
      backups: new Map<string, string>(),
      executionCwd: tempDir,
    };

    const moduleResult = await toolModuleContext({
      target_path: 'go_service',
      refresh: true,
    }, ctx);
    expect(moduleResult).toContain('Languages: go/high:1');

    const symbolResult = await toolSymbolContext({
      symbol: 'Normalize',
      target_path: 'go_service',
      refresh: false,
    }, ctx);
    expect(symbolResult).toContain('Language: go/high');

    const routingSignals = await getRepoRoutingSignals({
      executionCwd: tempDir,
    }, {
      targetPath: 'go_service',
      refresh: false,
    });
    expect(routingSignals.predominantCapabilityTier).toBe('high');
  }, 15000);

  it('invalidates older repo-intelligence cache schema versions before reuse', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-schema-'));
    createPolyglotFixture(tempDir);

    const ctx = {
      executionCwd: tempDir,
    };

    await getRepoIntelligenceIndex(ctx, {
      refresh: true,
    });

    const storageRoot = getRepoIntelligenceStorageRoot(tempDir);
    for (const fileName of [
      'repo-intelligence-index.json',
      'repo-intelligence-manifest.json',
      'file-analysis-index.json',
    ]) {
      const filePath = join(storageRoot, fileName);
      const payload = readJson(filePath);
      payload.schemaVersion = 2;
      writeJson(filePath, payload);
    }

    const rebuilt = await getRepoIntelligenceIndex(ctx, {
      refresh: false,
    });

    expect(rebuilt.schemaVersion).toBe(9);
    expect(rebuilt.languages).toEqual(expect.arrayContaining([
      { language: 'go', capabilityTier: 'high', fileCount: 1 },
      { language: 'rust', capabilityTier: 'high', fileCount: 1 },
    ]));
    expect(readJson(join(storageRoot, 'repo-intelligence-manifest.json')).schemaVersion).toBe(9);
  }, 15000);

  it('reuses the clean git query cache without re-statting source files', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-clean-git-hit-'));
    initGitRepo(tempDir);
    createWorkspaceFixture(tempDir);
    commitAll(tempDir, 'initial');

    const ctx = {
      executionCwd: tempDir,
    };

    await getRepoIntelligenceIndex(ctx, { refresh: true });

    const statSpy = vi.spyOn(fsPromises, 'stat');
    const cached = await getRepoIntelligenceIndex(ctx, { refresh: false });

    expect(cached.sourceFileCount).toBeGreaterThan(0);
    expect(collectObservedSourceStatPaths(statSpy.mock.calls as Array<unknown[]>, tempDir)).toEqual([]);
  }, 15000);

  it('directly reuses the clean git query cache without rebuilding repo inputs when overview inventory is missing', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-clean-preflight-hit-'));
    initGitRepo(tempDir);
    createWorkspaceFixture(tempDir);
    commitAll(tempDir, 'initial');

    const ctx = {
      executionCwd: tempDir,
    };

    const initial = await getRepoIntelligenceIndex(ctx, { refresh: true });
    forceCurrentOverviewInventoryCacheMiss(tempDir);

    const collectSpy = vi.spyOn(repoIndexModule, 'collectWorkspaceFilesForSource');
    const cached = await getRepoIntelligenceIndex(ctx, { refresh: false });

    expect(cached.generatedAt).toBe(initial.generatedAt);
    expect(collectSpy).not.toHaveBeenCalled();
  }, 15000);

  it('re-materializes dirty git docs-only changes without re-statting source files', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-dirty-docs-'));
    initGitRepo(tempDir);
    createWorkspaceFixture(tempDir);
    commitAll(tempDir, 'initial');

    const ctx = {
      executionCwd: tempDir,
    };

    await getRepoIntelligenceIndex(ctx, { refresh: true });

    writeFileSync(join(tempDir, 'docs', 'PRD.md'), '# PRD\n\nUpdated details.\n');

    const statSpy = vi.spyOn(fsPromises, 'stat');
    const incremental = await getRepoIntelligenceIndex(ctx, { refresh: false });

    expect(collectObservedSourceStatPaths(statSpy.mock.calls as Array<unknown[]>, tempDir)).toEqual([]);

    forceQueryIndexCacheMiss(tempDir);
    const rebuilt = await getRepoIntelligenceIndex(ctx, { refresh: false });

    expect(stableIndexSnapshot(incremental)).toEqual(stableIndexSnapshot(rebuilt));
  }, 15000);

  it('directly reuses identical dirty docs-only query snapshots without rewriting the query index', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-dirty-docs-direct-hit-'));
    initGitRepo(tempDir);
    createWorkspaceFixture(tempDir);
    commitAll(tempDir, 'initial');

    const ctx = {
      executionCwd: tempDir,
    };

    await getRepoIntelligenceIndex(ctx, { refresh: true });

    writeFileSync(join(tempDir, 'docs', 'PRD.md'), '# PRD\n\nUpdated details.\n');

    const firstDirty = await getRepoIntelligenceIndex(ctx, { refresh: false });
    const statSpy = vi.spyOn(fsPromises, 'stat');
    const secondDirty = await getRepoIntelligenceIndex(ctx, { refresh: false });

    expect(secondDirty.generatedAt).toBe(firstDirty.generatedAt);
    expect(secondDirty.overviewGeneratedAt).toBe(firstDirty.overviewGeneratedAt);
    expect(secondDirty.sourceFingerprint).toBe(firstDirty.sourceFingerprint);
    expect(collectObservedSourceStatPaths(statSpy.mock.calls as Array<unknown[]>, tempDir)).toEqual([]);
  }, 15000);

  it('directly reuses identical dirty docs-only query snapshots without rebuilding repo inputs when overview inventory is missing', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-dirty-docs-preflight-hit-'));
    initGitRepo(tempDir);
    createWorkspaceFixture(tempDir);
    commitAll(tempDir, 'initial');

    const ctx = {
      executionCwd: tempDir,
    };

    await getRepoIntelligenceIndex(ctx, { refresh: true });
    writeFileSync(join(tempDir, 'docs', 'PRD.md'), '# PRD\n\nUpdated details.\n');

    const firstDirty = await getRepoIntelligenceIndex(ctx, { refresh: false });
    forceCurrentOverviewInventoryCacheMiss(tempDir);

    const collectSpy = vi.spyOn(repoIndexModule, 'collectWorkspaceFilesForSource');
    const secondDirty = await getRepoIntelligenceIndex(ctx, { refresh: false });

    expect(secondDirty.generatedAt).toBe(firstDirty.generatedAt);
    expect(secondDirty.overviewGeneratedAt).toBe(firstDirty.overviewGeneratedAt);
    expect(collectSpy).not.toHaveBeenCalled();
  }, 15000);

  it('does not direct-hit when dirty source files change under the same dirty path set', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-dirty-source-direct-hit-miss-'));
    initGitRepo(tempDir);
    createPolyglotFixture(tempDir);
    commitAll(tempDir, 'initial');

    const ctx = {
      executionCwd: tempDir,
    };

    await getRepoIntelligenceIndex(ctx, { refresh: true });

    writeFileSync(join(tempDir, 'python_pkg', 'helpers.py'), [
      'def normalize(value: str) -> str:',
      '    return value.strip().lower()',
      '',
      'def temporary_marker(value: str) -> str:',
      '    return value',
      '',
    ].join('\n'));
    const firstDirty = await getRepoIntelligenceIndex(ctx, { refresh: false });

    writeFileSync(join(tempDir, 'python_pkg', 'helpers.py'), [
      'def normalize(value: str) -> str:',
      '    return value.strip().lower().replace("-", "_")',
      '',
      'def temporary_marker(value: str) -> str:',
      '    return value',
      '',
      'def temporary_marker_two(value: str) -> str:',
      '    return value.upper()',
      '',
    ].join('\n'));

    const statSpy = vi.spyOn(fsPromises, 'stat');
    const secondDirty = await getRepoIntelligenceIndex(ctx, { refresh: false });

    expect(secondDirty.generatedAt).not.toBe(firstDirty.generatedAt);
    expect(secondDirty.sourceFingerprint).not.toBe(firstDirty.sourceFingerprint);
    expect(secondDirty.symbols.some((symbol) => symbol.name === 'temporary_marker_two' && symbol.filePath === 'python_pkg/helpers.py')).toBe(true);
    expect(collectObservedSourceStatPaths(statSpy.mock.calls as Array<unknown[]>, tempDir)).toEqual([
      'python_pkg/helpers.py',
    ]);
  }, 15000);

  it('matches a forced full rebuild after dirty git incremental refresh for file edits', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-incremental-edit-'));
    initGitRepo(tempDir);
    createPolyglotFixture(tempDir);
    commitAll(tempDir, 'initial');

    const ctx = {
      executionCwd: tempDir,
    };

    await getRepoIntelligenceIndex(ctx, { refresh: true });

    writeFileSync(join(tempDir, 'python_pkg', 'helpers.py'), [
      'def normalize(value: str) -> str:',
      '    return value.strip().lower().replace("-", "_")',
      '',
    ].join('\n'));

    const statSpy = vi.spyOn(fsPromises, 'stat');
    const incremental = await getRepoIntelligenceIndex(ctx, { refresh: false });

    expect(collectObservedSourceStatPaths(statSpy.mock.calls as Array<unknown[]>, tempDir)).toEqual([
      'python_pkg/helpers.py',
    ]);

    forceQueryIndexCacheMiss(tempDir);
    const rebuilt = await getRepoIntelligenceIndex(ctx, { refresh: false });

    expect(stableIndexSnapshot(incremental)).toEqual(stableIndexSnapshot(rebuilt));
  }, 15000);

  it('reverts back to the clean baseline analysis when a dirty source edit is undone while other files stay dirty', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-incremental-revert-'));
    initGitRepo(tempDir);
    createPolyglotFixture(tempDir);
    commitAll(tempDir, 'initial');

    const ctx = {
      executionCwd: tempDir,
    };

    await getRepoIntelligenceIndex(ctx, { refresh: true });

    writeFileSync(join(tempDir, 'python_pkg', 'helpers.py'), [
      'def normalize(value: str) -> str:',
      '    return value.strip().lower()',
      '',
      'def temporary_marker(value: str) -> str:',
      '    return value',
      '',
    ].join('\n'));
    await getRepoIntelligenceIndex(ctx, { refresh: false });

    writeFileSync(join(tempDir, 'python_pkg', 'helpers.py'), [
      'def normalize(value: str) -> str:',
      '    return value.strip().lower()',
      '',
    ].join('\n'));
    writeFileSync(join(tempDir, 'README.md'), '# Keep dirty\n');

    const reverted = await getRepoIntelligenceIndex(ctx, { refresh: false });
    forceQueryIndexCacheMiss(tempDir);
    const rebuilt = await getRepoIntelligenceIndex(ctx, { refresh: false });

    expect(reverted.symbols.some((symbol) => symbol.name === 'temporary_marker')).toBe(false);
    expect(stableIndexSnapshot(reverted)).toEqual(stableIndexSnapshot(rebuilt));
  }, 15000);

  it('matches a forced full rebuild after dirty git incremental refresh for new source files', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-incremental-add-'));
    initGitRepo(tempDir);
    createPolyglotFixture(tempDir);
    commitAll(tempDir, 'initial');

    const ctx = {
      executionCwd: tempDir,
    };

    await getRepoIntelligenceIndex(ctx, { refresh: true });

    writeFileSync(join(tempDir, 'python_pkg', 'formatters.py'), [
      'def slugify(value: str) -> str:',
      '    return value.strip().lower().replace(" ", "-")',
      '',
    ].join('\n'));

    const incremental = await getRepoIntelligenceIndex(ctx, { refresh: false });
    forceQueryIndexCacheMiss(tempDir);
    const rebuilt = await getRepoIntelligenceIndex(ctx, { refresh: false });

    expect(incremental.symbols.some((symbol) => symbol.name === 'slugify' && symbol.filePath === 'python_pkg/formatters.py')).toBe(true);
    expect(stableIndexSnapshot(incremental)).toEqual(stableIndexSnapshot(rebuilt));
  }, 15000);

  it('matches a forced full rebuild after dirty git incremental refresh for deleted source files', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-incremental-delete-'));
    initGitRepo(tempDir);
    createPolyglotFixture(tempDir);
    commitAll(tempDir, 'initial');

    const ctx = {
      executionCwd: tempDir,
    };

    await getRepoIntelligenceIndex(ctx, { refresh: true });

    rmSync(join(tempDir, 'cpp_src', 'name_service.cpp'));

    const incremental = await getRepoIntelligenceIndex(ctx, { refresh: false });
    forceQueryIndexCacheMiss(tempDir);
    const rebuilt = await getRepoIntelligenceIndex(ctx, { refresh: false });

    expect(incremental.symbols.some((symbol) => symbol.filePath === 'cpp_src/name_service.cpp')).toBe(false);
    expect(stableIndexSnapshot(incremental)).toEqual(stableIndexSnapshot(rebuilt));
  }, 15000);

  it('matches a forced full rebuild after dirty git incremental refresh for renamed source files', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-incremental-rename-'));
    initGitRepo(tempDir);
    createPolyglotFixture(tempDir);
    commitAll(tempDir, 'initial');

    const ctx = {
      executionCwd: tempDir,
    };

    await getRepoIntelligenceIndex(ctx, { refresh: true });

    renameSync(
      join(tempDir, 'cpp_src', 'name_service.cpp'),
      join(tempDir, 'cpp_src', 'renamed_service.cpp'),
    );

    const incremental = await getRepoIntelligenceIndex(ctx, { refresh: false });
    forceQueryIndexCacheMiss(tempDir);
    const rebuilt = await getRepoIntelligenceIndex(ctx, { refresh: false });

    expect(incremental.symbols.some((symbol) => symbol.filePath === 'cpp_src/name_service.cpp')).toBe(false);
    expect(incremental.symbols.some((symbol) => symbol.filePath === 'cpp_src/renamed_service.cpp')).toBe(true);
    expect(stableIndexSnapshot(incremental)).toEqual(stableIndexSnapshot(rebuilt));
  }, 15000);

  it('falls back to a full rebuild when file analysis cache is missing or corrupt', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-incremental-corrupt-'));
    createPolyglotFixture(tempDir);

    const ctx = {
      executionCwd: tempDir,
    };

    await getRepoIntelligenceIndex(ctx, { refresh: true });

    writeFileSync(join(tempDir, 'python_pkg', 'helpers.py'), [
      'def normalize(value: str) -> str:',
      '    return value.strip().upper()',
      '',
    ].join('\n'));
    writeFileSync(join(getRepoIntelligenceStorageRoot(tempDir), 'file-analysis-index.json'), '{not-valid-json');

    const recovered = await getRepoIntelligenceIndex(ctx, { refresh: false });
    forceQueryIndexCacheMiss(tempDir);
    const rebuilt = await getRepoIntelligenceIndex(ctx, { refresh: false });

    expect(stableIndexSnapshot(recovered)).toEqual(stableIndexSnapshot(rebuilt));
  }, 15000);
});
