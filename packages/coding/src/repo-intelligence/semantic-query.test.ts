import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  findModuleMatch,
  resolveImpactEstimateFromIndex,
  resolveModuleContextFromIndex,
  resolveSymbolContextFromIndex,
} from './semantic-query.js';
import { renderImpactEstimate, renderSymbolContext } from './semantic-render.js';
import type { ModuleCapsule, RepoIntelligenceIndex, RepoSymbolRecord } from './semantic-types.js';

function module(moduleId: string, root: string, symbolCount = 1): ModuleCapsule {
  return {
    moduleId,
    label: moduleId,
    kind: moduleId === '.' ? 'root' : 'package',
    root,
    fileCount: 1,
    sourceFileCount: 1,
    symbolCount,
    languages: [],
    topSymbols: [],
    dependencies: [],
    dependents: [],
    entryFiles: [],
    keyTests: [],
    keyDocs: [],
    sampleFiles: [],
    processIds: [],
    confidence: 0.9,
  };
}

const workspaceRoot = path.resolve('repo');

function index(modules: ModuleCapsule[]): RepoIntelligenceIndex {
  return {
    schemaVersion: 1,
    workspaceRoot,
    generatedAt: '2026-11-23T00:00:00.000Z',
    overviewGeneratedAt: '2026-11-23T00:00:00.000Z',
    sourceFileCount: modules.length,
    sourceFingerprint: 'test',
    languages: [],
    modules,
    symbols: [],
    processes: [],
  };
}

describe('findModuleMatch', () => {
  const big = module('packages/big', 'packages/big', 500);
  const app = module('packages/app', 'packages/app', 3);
  const nested = module('packages/app/plugins', 'packages/app/plugins', 1);
  const root = module('.', '.', 0);

  it('picks the most specific module that contains the target path', () => {
    const match = findModuleMatch(index([root, app, nested, big]), undefined, 'packages/app/plugins/a.ts');
    expect(match?.moduleId).toBe('packages/app/plugins');
  });

  it('resolves an absolute target path against the workspace root', () => {
    const match = findModuleMatch(index([big, app]), undefined, path.join(workspaceRoot, 'packages', 'app', 'src', 'x.ts'));
    expect(match?.moduleId).toBe('packages/app');
  });

  it('falls back to the root module for a path outside every package', () => {
    const match = findModuleMatch(index([big, root, app]), undefined, 'scripts/build.ts');
    expect(match?.moduleId).toBe('.');
  });

  it('returns no module instead of an unrelated one when nothing contains the path', () => {
    expect(findModuleMatch(index([big, app]), undefined, 'scripts/build.ts')).toBeNull();
  });

  it('returns no module instead of an unrelated one when the name matches nothing', () => {
    expect(findModuleMatch(index([big, app]), 'payments')).toBeNull();
  });

  it('returns the root module, not the largest package, when no module or path is given', () => {
    expect(findModuleMatch(index([big, app, root]))?.moduleId).toBe('.');
    expect(findModuleMatch(index([big, app]))).toBeNull();
  });

  it('still matches a module by name', () => {
    expect(findModuleMatch(index([big, app]), 'app')?.moduleId).toBe('packages/app');
  });
});

describe('resolveModuleContextFromIndex', () => {
  it('errors when no module matches', () => {
    expect(() => resolveModuleContextFromIndex(index([module('packages/big', 'packages/big', 500)]), { module: 'payments' }))
      .toThrow('No module matched "payments"');
  });
});

function symbol(id: string, moduleId: string, calls: string[] = []): RepoSymbolRecord {
  return {
    id,
    name: id,
    qualifiedName: id,
    kind: 'function',
    filePath: `${moduleId}/${id}.ts`,
    moduleId,
    language: 'typescript',
    capabilityTier: 'high',
    line: 1,
    signature: `function ${id}()`,
    exported: true,
    calls,
    callTargets: calls.map((target) => ({ symbolId: target, name: target, filePath: `${moduleId}/${target}.ts`, moduleId })),
    importPaths: [],
    confidence: 0.9,
  };
}

describe('truncated relationship lists', () => {
  const callerIds = Array.from({ length: 11 }, (_, i) => `caller${i}`);
  const symbolIndex = {
    ...index([module('packages/app', 'packages/app')]),
    symbols: [
      symbol('target', 'packages/app'),
      ...callerIds.map((id) => symbol(id, 'packages/app', ['target'])),
    ],
  };

  it('counts the callers a symbol context leaves out and says so', () => {
    const result = resolveSymbolContextFromIndex(symbolIndex, { symbol: 'target' });
    expect(result.callers).toHaveLength(8);
    expect(result.omitted?.callers).toBe(3);
    expect(renderSymbolContext(result)).toContain('(+3 more not shown)');
  });

  it('counts impacted symbols a module impact estimate leaves out and says so', () => {
    const result = resolveImpactEstimateFromIndex(symbolIndex, { module: 'packages/app' });
    expect(result.impactedSymbols).toHaveLength(8);
    expect(result.omitted?.impactedSymbols).toBe(4);
    expect(renderImpactEstimate(result)).toContain('(+4 more not shown)');
  });

  it('adds no marker when nothing was left out', () => {
    const small = { ...symbolIndex, symbols: symbolIndex.symbols.slice(0, 3) };
    const result = resolveSymbolContextFromIndex(small, { symbol: 'target' });
    expect(result.omitted).toBeUndefined();
    expect(renderSymbolContext(result)).not.toContain('more not shown');
  });
});
