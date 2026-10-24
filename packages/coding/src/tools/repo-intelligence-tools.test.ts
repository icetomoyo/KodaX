import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Runner } from '@kodax-ai/agent';
import { getToolExecutionOverride } from '../agent-runtime/permission-gate.js';
import { buildRunnerAgentChain } from '../task-engine/runner-driven.js';
import { registerTool } from './registry.js';
import {
  getRepoIntelligenceIndex as getSemanticRepoIntelligenceIndex,
  getRepoRoutingSignals as getSemanticRepoRoutingSignals,
} from '../repo-intelligence/semantic-index.js';
import { shutdownRepoIntelligenceWorkerForTest } from '../repo-intelligence/semantic-worker-client.js';
import { QUERY_SCHEMA_VERSION } from '../repo-intelligence/semantic-shared.js';
import type { KodaXToolExecutionContext } from '../types.js';
import { toolImpactEstimate } from './impact-estimate.js';
import { toolModuleContext } from './module-context.js';
import { toolProcessContext } from './process-context.js';
import { toolRelationshipScan } from './relationship-scan.js';
import { toolSymbolContext } from './symbol-context.js';
import { commitAll, initGitRepo } from './test-helpers.js';

type RepoContext = Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>;
type LightQueryOptions = { targetPath?: string; refresh?: boolean };

function getRepoIntelligenceIndex(
  context: RepoContext,
  options: LightQueryOptions = {},
) {
  return getSemanticRepoIntelligenceIndex(context, { ...options, profile: 'light' });
}

function getRepoRoutingSignals(
  context: RepoContext,
  options: LightQueryOptions = {},
) {
  return getSemanticRepoRoutingSignals(context, { ...options, profile: 'light' });
}

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
  return join(workspaceRoot, '.agent', 'repo-intelligence', 'light');
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

describe('repo intelligence tool surfaces', () => {
  let tempDir = '';
  const previousRepoMode = process.env.KODAX_REPO_INTELLIGENCE;
  const previousToolWait = process.env.KODAX_REPO_INTELLIGENCE_TOOL_WAIT_MS;

  beforeEach(() => {
    process.env.KODAX_REPO_INTELLIGENCE = 'light';
    process.env.KODAX_REPO_INTELLIGENCE_TOOL_WAIT_MS = '30000';
  });

  afterEach(async () => {
    if (previousRepoMode === undefined) {
      delete process.env.KODAX_REPO_INTELLIGENCE;
    } else {
      process.env.KODAX_REPO_INTELLIGENCE = previousRepoMode;
    }
    if (previousToolWait === undefined) {
      delete process.env.KODAX_REPO_INTELLIGENCE_TOOL_WAIT_MS;
    } else {
      process.env.KODAX_REPO_INTELLIGENCE_TOOL_WAIT_MS = previousToolWait;
    }
    await shutdownRepoIntelligenceWorkerForTest();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      tempDir = '';
    }
  });

  it('returns module, symbol, process, and impact capsules from a local repo', async () => {
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

    const relationshipResult = await toolRelationshipScan({
      symbol: 'createApp',
      direction: 'both',
      include_lsp: true,
      refresh: false,
    }, ctx);
    expect(relationshipResult).toContain('Relationship scan for createApp');
    expect(relationshipResult).toContain('Engine: light');
    expect(relationshipResult).toContain('Identity');
    expect(relationshipResult).toContain('Upstream');
    expect(relationshipResult).toContain('startServer');
    expect(relationshipResult).toContain('Downstream');
    expect(relationshipResult).toContain('NameService');
    expect(relationshipResult).toContain('Impact');
    expect(relationshipResult).toContain('Evidence');
    expect(relationshipResult).toContain('LSP validation: LSP service is unavailable');
    expect(relationshipResult).not.toContain('not wired');

    const moduleOnlyRelationshipResult = await toolRelationshipScan({
      module: '@demo/app',
      direction: 'downstream',
      refresh: false,
    }, ctx);
    expect(moduleOnlyRelationshipResult).toContain('Relationship scan for @demo/app');
    expect(moduleOnlyRelationshipResult).toContain('module_context freshness=');
    expect(moduleOnlyRelationshipResult).not.toContain('process_context freshness=');
    expect(moduleOnlyRelationshipResult).not.toContain('- Process ');
  }, 60000);

  it('adds LSP call hierarchy and text-search evidence to relationship scans', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-relationship-evidence-'));
    createWorkspaceFixture(tempDir);

    let incomingPosition: { readonly line: number; readonly character: number } | undefined;
    let outgoingPosition: { readonly line: number; readonly character: number } | undefined;
    let incomingFile = '';
    let outgoingFile = '';
    const ctx = {
      backups: new Map<string, string>(),
      executionCwd: tempDir,
      lspService: {
        getIncomingCalls: async (
          file: string,
          position: { readonly line: number; readonly character: number },
        ): Promise<string> => {
          incomingFile = file;
          incomingPosition = position;
          return 'Incoming call: startServer (packages/app/src/index.ts:3)';
        },
        getOutgoingCalls: async (
          file: string,
          position: { readonly line: number; readonly character: number },
        ): Promise<string> => {
          outgoingFile = file;
          outgoingPosition = position;
          return 'Outgoing call: NameService.normalize (packages/shared/src/name-service.ts:4)';
        },
      },
    } as unknown as KodaXToolExecutionContext;

    const result = await toolRelationshipScan({
      symbol: 'createApp',
      direction: 'both',
      include_lsp: true,
      include_text_search: true,
      refresh: true,
    }, ctx);

    expect(result).toContain('Relationship scan for createApp');
    expect(result).toContain('LSP validation');
    expect(result).toContain('Incoming call: startServer');
    expect(result).toContain('Outgoing call: NameService.normalize');
    expect(result).toContain('Text-search validation');
    expect(result).toContain('grep exact-name evidence for "createApp"');
    expect(result).toContain('packages/app/src/index.ts');
    expect(result).not.toContain('not wired');
    expect(incomingFile.endsWith(join('packages', 'app', 'src', 'create-app.ts'))).toBe(true);
    expect(outgoingFile.endsWith(join('packages', 'app', 'src', 'create-app.ts'))).toBe(true);
    expect(incomingPosition).toEqual({ line: 2, character: 16 });
    expect(outgoingPosition).toEqual({ line: 2, character: 16 });
  }, 15000);

  it.each(['light', 'full'] as const)('keeps detailed capsule evidence available when the %s relationship summary omits it', async mode => {
    process.env.KODAX_REPO_INTELLIGENCE = mode;
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-entry-coverage-'));
    initGitRepo(tempDir);
    createWorkspaceFixture(tempDir);
    writeFileSync(join(tempDir, 'packages', 'app', 'README.md'), '# App compatibility contract\n');
    commitAll(tempDir, 'initial');
    const sourcePath = join(tempDir, 'packages', 'app', 'src', 'create-app.ts');
    writeFileSync(sourcePath, readFileSync(sourcePath, 'utf8') + '// Local refactor evidence\n');
    const ctx = { backups: new Map<string, string>(), executionCwd: tempDir, gitRoot: tempDir };

    const module = await toolModuleContext({ module: '@demo/app', refresh: true }, ctx);
    const moduleScan = await toolRelationshipScan({ module: '@demo/app', direction: 'both' }, ctx);
    expect(module).toContain('Tests: packages/app/tests/app.test.ts');
    expect(module).toContain('Docs: packages/app/README.md');
    expect(module).toContain('Top symbols:');
    expect(moduleScan).toContain('Module: @demo/app');
    expect(moduleScan).not.toContain('packages/app/tests/app.test.ts');
    expect(moduleScan).not.toContain('packages/app/README.md');

    const symbol = await toolSymbolContext({ symbol: 'createApp' }, ctx);
    const symbolScan = await toolRelationshipScan({ symbol: 'createApp', direction: 'both', depth: 2 }, ctx);
    expect(symbol).toContain('Signature: export function createApp(name: string): string');
    expect(symbol).toContain('Imports: ../../shared/src/name-service');
    expect(symbolScan).toContain('startServer');
    expect(symbolScan).toContain('create-app.ts:');
    expect(symbolScan).not.toContain('Signature:');
    expect(symbolScan).not.toContain('Imports:');
    expect(symbolScan).toContain('not a recursive traversal');

    const processCapsule = await toolProcessContext({ module: '@demo/app' }, ctx);
    const entryScan = await toolRelationshipScan({ entry: 'startServer', direction: 'downstream' }, ctx);
    expect(processCapsule).toContain('Steps:');
    expect(processCapsule).toContain('startServer');
    expect(moduleScan).not.toContain('- Process ');
    expect(entryScan).toContain('- Process ');
    expect(entryScan).toContain('startServer');
    expect(processCapsule).toContain('Summary:');
    expect(entryScan).not.toContain('Summary:');

    const impact = await toolImpactEstimate({ symbol: 'createApp' }, ctx);
    expect(impact).toContain('Changed-scope overlap: 1 file(s)');
    expect(symbolScan).toContain('Impact');
    expect(symbolScan).toContain('overlaps with 1 currently changed file(s)');
    expect(symbolScan).not.toContain('Changed-scope overlap:');
  }, 30000);

  it.each(['light', 'full'] as const)('refreshes module and path scans once, then reuses the %s index', async mode => {
    process.env.KODAX_REPO_INTELLIGENCE = mode;
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-relationship-refresh-'));
    createWorkspaceFixture(tempDir);
    const ctx = { backups: new Map<string, string>(), executionCwd: tempDir, gitRoot: tempDir };
    const freshness = (output: string): string => {
      const value = /module_context freshness=(\S+)/.exec(output)?.[1];
      expect(value).toBeDefined();
      expect(value).not.toBe('limited');
      return value!;
    };
    let previous = freshness(await toolRelationshipScan({ module: '@demo/app' }, ctx));
    for (const target of [{ module: '@demo/app' }, { path: 'packages/app/src/create-app.ts' }]) {
      const refreshed = await toolRelationshipScan({ ...target, refresh: true }, ctx);
      const current = freshness(refreshed);
      expect(current).not.toBe(previous);
      expect(refreshed).toContain(`impact_estimate freshness=${current}`);
      if ('module' in target) expect(refreshed).toContain('Dependency module: packages/shared');
      expect(freshness(await toolRelationshipScan(target, ctx))).toBe(current);
      previous = current;
    }
  }, 30000);

  it('reports unavailable SDK parts without false empty-edge findings and recovers when enabled', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-relationship-unavailable-'));
    createWorkspaceFixture(tempDir);
    const ctx = { backups: new Map<string, string>(), executionCwd: tempDir, gitRoot: tempDir };
    process.env.KODAX_REPO_INTELLIGENCE = 'off';
    const unavailable = await toolRelationshipScan({ symbol: 'createApp', module: '@demo/app' }, ctx);
    for (const [tool, query] of [
      ['symbol_context', 'symbol context'], ['module_context', 'module context'],
      ['process_context', 'process context'], ['impact_estimate', 'impact estimate'],
    ]) {
      expect(unavailable).toContain(`${tool}: Repo intelligence ${query} unavailable`);
    }
    expect(unavailable).toContain('Validate critical edits with read, grep');
    expect(unavailable).not.toContain('No additional gaps recorded');
    expect(unavailable).not.toMatch(/No (direct callers|direct callees|module dependents|module dependencies|impacted modules) found/);
    expect(unavailable).not.toContain('- Process ');

    process.env.KODAX_REPO_INTELLIGENCE = 'light';
    const recovered = await toolRelationshipScan({ symbol: 'createApp', module: '@demo/app' }, ctx);
    expect(recovered).toContain('startServer');
    expect(recovered).toContain('Dependency module: packages/shared');
    expect(recovered).not.toContain('symbol_context: Repo intelligence symbol context unavailable');
  }, 30000);

  it('keeps valid relationships while surfacing an unavailable process part', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-relationship-partial-'));
    createWorkspaceFixture(tempDir);
    const result = await toolRelationshipScan({ symbol: 'createApp' }, {
      backups: new Map<string, string>(), executionCwd: tempDir, gitRoot: tempDir,
    });
    expect(result).toContain('startServer');
    expect(result).toContain('Dependency module: packages/shared');
    expect(result).toContain('process_context: Repo intelligence process context unavailable');
    expect(result).not.toContain('No additional gaps recorded');
    expect(result).not.toContain('- Process ');
  }, 30000);

  it('retains exact discovery and checked fallback without making the aggregate an extension alias', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-entry-discovery-'));
    createWorkspaceFixture(tempDir);
    const ctx = { backups: new Map<string, string>(), executionCwd: tempDir, gitRoot: tempDir };
    const unregister = registerTool({
      name: 'module_context', description: 'Extension module contract with independent evidence.',
      input_schema: { type: 'object', properties: { module: { type: 'string' } } },
      sideEffect: 'readonly', handler: async () => 'EXTENSION_MODULE_EVIDENCE',
    });
    try {
      const agent = buildRunnerAgentChain(ctx).worker;
      const execute = async (name: string, input: Record<string, unknown>) => agent.tools!.find(tool => tool.name === name)!
        .execute(input, { agent, toolCallId: name });
      const catalog = await execute('tool_search', { query: 'select:module_context,symbol_context,process_context,impact_estimate' });
      for (const name of ['module_context', 'symbol_context', 'process_context', 'impact_estimate']) {
        expect(String(catalog.content)).toContain(`"name":"${name}"`);
        expect(agent.tools!.some(tool => tool.name === name)).toBe(true);
      }
      expect(String(catalog.content)).toContain('Extension module contract');
      const native = await execute('module_context', { module: '@demo/app' });
      const fallback = await execute('tool_call', { name: 'module_context', input: { module: '@demo/app' } });
      expect(native.content).toBe('EXTENSION_MODULE_EVIDENCE');
      expect(fallback.content).toBe(native.content);
      const aggregate = await execute('relationship_scan', { module: '@demo/app' });
      expect(String(aggregate.content)).toContain('Relationship scan for @demo/app');
      expect(String(aggregate.content)).not.toContain('EXTENSION_MODULE_EVIDENCE');
    } finally { unregister(); }
  }, 30000);

  it.each(['module_context', 'symbol_context', 'process_context', 'impact_estimate', 'relationship_scan'])(
    'preserves denial and later recovery at the concrete %s permission boundary', async name => {
      tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-entry-permission-'));
      createWorkspaceFixture(tempDir);
      const ctx = { backups: new Map<string, string>(), executionCwd: tempDir, gitRoot: tempDir };
      let permissions = 0;
      const events = { beforeToolExecute: async (tool: string) => tool !== name || permissions++ > 0
        ? true : '[Tool Error] explicit query denial' };
      const budget = { totalBudget: 100, spentBudget: 0 };
      const agent = buildRunnerAgentChain(ctx, undefined, budget, undefined, undefined, events).worker;
      const input = name === 'symbol_context' || name === 'impact_estimate' ? { symbol: 'createApp' }
        : { module: '@demo/app' };
      let round = 0;
      const result = await Runner.run(agent, 'Recover only after permission permits the query.', {
        tracer: null,
        toolObserver: { beforeTool: async call => (await getToolExecutionOverride(events, call.name, call.input, call.id)) ?? true },
        llm: async messages => {
          if (round === 1) {
            expect(messages.at(-1)?.content).toEqual([expect.objectContaining({
              type: 'tool_result', tool_use_id: 'query-1', is_error: true,
              content: '[Tool Error] explicit query denial',
            })]);
            expect(budget.spentBudget).toBe(0);
          }
          if (round === 2) {
            expect(messages.at(-1)?.content).toEqual([expect.objectContaining({
              type: 'tool_result', tool_use_id: 'query-2', is_error: false,
              content: expect.stringContaining('packages/app'),
            })]);
            expect(budget.spentBudget).toBe(1);
          }
          return round++ < 2 ? { text: '', toolCalls: [{ id: `query-${round}`, name, input }] }
            : { text: 'Query recovered after the actual permission decision.' };
        },
      });
      expect(result.output).toContain('Query recovered');
      expect(permissions).toBe(2);
      expect(budget.spentBudget).toBe(1);
    }, 30000);

  it('reuses the light-profile semantic cache when nothing changed', async () => {
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

  it('refreshes the light-profile semantic cache when source contents change', async () => {
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

  it('invalidates older semantic cache schema versions before reuse', async () => {
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

    expect(rebuilt.schemaVersion).toBe(QUERY_SCHEMA_VERSION);
    expect(readJson<{ schemaVersion: number }>(join(storageRoot, 'repo-intelligence-manifest.json')).schemaVersion).toBe(QUERY_SCHEMA_VERSION);
  }, 15000);

  it('reports polyglot light-profile language tiers without requiring external parsers', async () => {
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

  it('returns conservative routing signals with low confidence in light-profile mode', async () => {
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
    expect(routingSignals.riskHints).toContain('Light repo routing uses heuristic static analysis; validate low-confidence edges before editing.');
  });
});
