import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getRepoIntelligenceIndex } from '../repo-intelligence/query.js';
import { toolModuleContext } from './module-context.js';
import { toolSymbolContext } from './symbol-context.js';
import { toolProcessContext } from './process-context.js';
import { toolImpactEstimate } from './impact-estimate.js';
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

describe('repo intelligence tool surfaces', () => {
  let tempDir = '';

  afterEach(() => {
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
    expect(rustRun?.callTargets.some((target) => target.name === 'normalize')).toBe(true);
    expect(rustTraitMethod?.qualifiedName).toContain('Greeter.run_trait');
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
    expect(cppRun?.callTargets.some((target) => target.name === 'normalize')).toBe(true);
  }, 15000);
});
