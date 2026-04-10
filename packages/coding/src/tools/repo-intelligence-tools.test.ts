import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRepoIntelligenceIndex, getRepoRoutingSignals } from '../repo-intelligence/query.js';
import { toolImpactEstimate } from './impact-estimate.js';
import { toolModuleContext } from './module-context.js';
import { toolProcessContext } from './process-context.js';
import { toolSymbolContext } from './symbol-context.js';
import { commitAll, initGitRepo } from './test-helpers.js';

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
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(workspaceRoot, 'rust_src', 'lib.rs'), [
    'pub struct Greeter;',
    '',
    'impl Greeter {',
    '    pub fn normalize(&self, value: &str) -> String {',
    '        value.trim().to_string()',
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
    '};',
    '',
  ].join('\n'));
}

function getRepoIntelligenceStorageRoot(workspaceRoot: string): string {
  return join(workspaceRoot, '.agent', 'repo-intelligence');
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

describe('repo intelligence tool surfaces', () => {
  let tempDir = '';
  const previousRepoMode = process.env.KODAX_REPO_INTELLIGENCE_MODE;

  beforeEach(() => {
    process.env.KODAX_REPO_INTELLIGENCE_MODE = 'oss';
  });

  afterEach(() => {
    if (previousRepoMode === undefined) {
      delete process.env.KODAX_REPO_INTELLIGENCE_MODE;
    } else {
      process.env.KODAX_REPO_INTELLIGENCE_MODE = previousRepoMode;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('returns fallback module, symbol, process, and impact capsules from a local repo', async () => {
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
    expect(moduleResult).toContain('Top symbols:');
    expect(moduleResult).toContain('createApp');

    const symbolResult = await toolSymbolContext({
      symbol: 'createApp',
      refresh: false,
    }, ctx);
    expect(symbolResult).toContain('Symbol context for createApp');
    expect(symbolResult).toContain('packages/app/src/create-app.ts');
    expect(symbolResult).toContain('Possible callers: startServer');

    const processResult = await toolProcessContext({
      module: '@demo/app',
      refresh: false,
    }, ctx);
    expect(processResult).toContain('Process context for');
    expect(processResult).toContain('@demo/app');

    const impactResult = await toolImpactEstimate({
      symbol: 'sharedUtil',
      refresh: false,
    }, ctx);
    expect(impactResult).toContain('Impact estimate for sharedUtil');
    expect(impactResult).toContain('@demo/shared(packages/shared)');
  }, 15000);

  it('reuses the fallback query cache when nothing changed', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-cache-hit-'));
    createWorkspaceFixture(tempDir);

    const ctx = {
      executionCwd: tempDir,
    };

    const first = await getRepoIntelligenceIndex(ctx, {
      targetPath: 'packages/app',
      refresh: true,
    });
    const second = await getRepoIntelligenceIndex(ctx, {
      targetPath: 'packages/app',
      refresh: false,
    });

    expect(second.generatedAt).toBe(first.generatedAt);
    expect(second.sourceFingerprint).toBe(first.sourceFingerprint);
  });

  it('refreshes the fallback query cache when source contents change', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-fingerprint-'));
    createWorkspaceFixture(tempDir);

    const ctx = {
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

    expect(after.generatedAt).not.toBe(before.generatedAt);
    expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint);
    expect(after.symbols.some((symbol) => symbol.name === 'stopServer')).toBe(true);
  });

  it('invalidates older fallback cache schema versions before reuse', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-schema-'));
    createPolyglotFixture(tempDir);

    const ctx = {
      executionCwd: tempDir,
    };

    await getRepoIntelligenceIndex(ctx, {
      refresh: true,
    });

    const storageRoot = getRepoIntelligenceStorageRoot(tempDir);
    for (const fileName of ['repo-intelligence-index.json', 'repo-intelligence-manifest.json']) {
      const filePath = join(storageRoot, fileName);
      const payload = readJson<Record<string, unknown>>(filePath);
      payload.schemaVersion = 0;
      writeFileSync(filePath, JSON.stringify(payload, null, 2));
    }

    const rebuilt = await getRepoIntelligenceIndex(ctx, {
      refresh: false,
    });

    expect(rebuilt.schemaVersion).toBe(10);
    expect(readJson<{ schemaVersion: number }>(join(storageRoot, 'repo-intelligence-manifest.json')).schemaVersion).toBe(10);
  }, 15000);

  it('reports polyglot fallback language tiers without requiring premium parsers in the public path', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-polyglot-'));
    createPolyglotFixture(tempDir);

    const index = await getRepoIntelligenceIndex({
      executionCwd: tempDir,
    }, {
      refresh: true,
    });

    expect(index.languages).toEqual(expect.arrayContaining([
      { language: 'python', capabilityTier: 'high', fileCount: 3 },
      { language: 'go', capabilityTier: 'high', fileCount: 1 },
      { language: 'java', capabilityTier: 'medium', fileCount: 1 },
      { language: 'rust', capabilityTier: 'high', fileCount: 1 },
      { language: 'cpp', capabilityTier: 'low', fileCount: 1 },
    ]));
  }, 15000);

  it('returns conservative routing signals with low confidence in OSS fallback mode', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-routing-'));
    createWorkspaceFixture(tempDir);

    const routingSignals = await getRepoRoutingSignals({
      executionCwd: tempDir,
    }, {
      targetPath: 'packages/app',
      refresh: true,
    });

    expect(routingSignals.activeModuleId).toBeDefined();
    expect(routingSignals.lowConfidence).toBe(true);
    expect(routingSignals.riskHints).toContain('Fallback repo routing uses OSS baseline heuristics.');
  });
});
