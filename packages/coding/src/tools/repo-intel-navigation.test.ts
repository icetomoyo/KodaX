import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RepoIntelQuery } from '../repo-intelligence/engine/supervisor.js';
import type { KodaXToolExecutionContext } from '../types.js';
import { toolFileOutline, toolFindSymbol } from './repo-intel-navigation.js';
import { buildToolExecutionContext } from '../agent-runtime/tool-execution-context.js';
import { resolveToolCapability } from '../agent-runtime/invariants/tool-permission.js';
import { isRepoIntelligenceWorkingToolName } from './registry.js';
import { isToolDiscoverable } from './tool-search.js';

const root = path.resolve('/work/repo');
const ready = { state: 'ready', indexed: 120, withSyntaxErrors: 0, notIndexed: { language: 30, size: 1 } };

interface Asked { readonly method: string; readonly params: Readonly<Record<string, unknown>> }

/** A repository index answering each method with a canned answer, recording what it was asked. */
function index(answers: Record<string, unknown>, asked: Asked[] = []): RepoIntelQuery {
  return {
    root,
    async request<T>(method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
      asked.push({ method, params });
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
  };
}

function context(repoIntel: RepoIntelQuery | undefined, cwd = root): KodaXToolExecutionContext {
  return { backups: new Map(), executionCwd: cwd, gitRoot: root, repoIntel } as KodaXToolExecutionContext;
}

const hit = (file: string, line: number, extra: Record<string, unknown> = {}) => ({
  path: file, name: 'run', kind: 'function', container: null, line, column: 1, language: 'typescript', stale: false, ...extra,
});

describe('find_symbol', () => {
  it('lists definitions by file, with line ranges and files changed since indexing', async () => {
    const answer = await toolFindSymbol({ name: 'run' }, context(index({
      'symbols.definitions': {
        hits: [hit('src/a.ts', 12, { endLine: 30 }), hit('src/a.ts', 40, { kind: 'method', container: 'Store', endLine: 52 }),
          hit('src/b.ts', 4, { stale: true })],
        total: 3, nextOffset: null, coverage: ready,
      },
    })));
    expect(answer).toBe([
      '3 definitions of `run`:',
      'src/a.ts',
      '  12-30 function run',
      '  40-52 method Store.run',
      'src/b.ts (changed since indexed; lines may have moved)',
      '  4 function run',
    ].join('\n'));
  });

  it('answers nothing while the index is being built, since a partial answer looks complete', async () => {
    const asked: Asked[] = [];
    const answer = await toolFindSymbol({ name: 'run', references: true }, context(index({
      'symbols.definitions': { hits: [hit('src/a.ts', 1)], total: 1, nextOffset: null, coverage: { ...ready, state: 'indexing', indexed: 40 } },
    }, asked)));
    expect(answer).toMatch(/still being built \(40 files so far\)/);
    expect(answer).toMatch(/grep and read/);
    expect(answer).not.toMatch(/src\/a\.ts/);
    expect(asked.map(item => item.method)).toEqual(['symbols.definitions']);
  });

  it('says what was not indexed when nothing is found', async () => {
    const answer = await toolFindSymbol({ name: 'run' }, context(index({
      'symbols.definitions': { hits: [], total: 0, nextOffset: null, coverage: ready },
    })));
    expect(answer).toBe('No definition of `run` in the index of 120 files. Not indexed: language 30, size 1; grep reaches those.');
  });

  it('resolves uses through imports when the name has one defining file, resolved first', async () => {
    const asked: Asked[] = [];
    const answer = await toolFindSymbol({ name: 'run', references: true }, context(index({
      'symbols.definitions': { hits: [hit('src/a.ts', 12)], total: 1, nextOffset: null, coverage: ready },
      'symbols.references': {
        hits: [hit('src/b.ts', 4, { precision: 'syntactic' }), hit('src/b.ts', 19, { precision: 'syntactic' }),
          hit('src/c.ts', 7, { precision: 'heuristic', stale: true })],
        total: 60, resolved: 2, nextOffset: 3, coverage: ready,
      },
    }, asked)));
    expect(asked[1]).toEqual({ method: 'symbols.references', params: { name: 'run', path: 'src/a.ts', limit: 50, offset: 0 } });
    expect(answer).toBe([
      '1 definition of `run`:',
      'src/a.ts',
      '  12 function run',
      '',
      '60 uses of `run` defined in src/a.ts:',
      'Resolved through imports (2):',
      'src/b.ts: 4, 19',
      'Matched by name only, so possibly another `run` (58):',
      'src/c.ts (changed since indexed; lines may have moved): 7',
      'More: call again with offset 3.',
    ].join('\n'));
  });

  it('matches uses by name when the name is defined in several files and no path picks one', async () => {
    const asked: Asked[] = [];
    const answer = await toolFindSymbol({ name: 'run', references: true, offset: 50 }, context(index({
      'symbols.definitions': { hits: [hit('src/a.ts', 12), hit('src/b.ts', 3)], total: 2, nextOffset: null, coverage: ready },
      'symbols.references': { hits: [hit('src/c.ts', 7, { precision: 'heuristic' })], total: 51, nextOffset: null, coverage: ready },
    }, asked)));
    expect(asked[1]?.params).toEqual({ name: 'run', limit: 50, offset: 50 });
    expect(answer).toBe([
      '`run` has 2 definitions in different files; give `path` to resolve its uses through imports. 51 uses matched by name only:',
      'src/c.ts: 7',
    ].join('\n'));
  });

  it('takes the defining file from `path`, relative to the working folder', async () => {
    const asked: Asked[] = [];
    await toolFindSymbol({ name: 'run', references: true, path: 'a.ts' }, context(index({
      'symbols.definitions': { hits: [], total: 0, nextOffset: null, coverage: ready },
      'symbols.references': { hits: [], total: 0, resolved: 0, nextOffset: null, coverage: ready },
    }, asked), path.join(root, 'src')));
    expect(asked[1]?.params).toMatchObject({ path: 'src/a.ts' });
  });

  it('shows paths relative to the working folder', async () => {
    const answer = await toolFindSymbol({ name: 'run' }, context(index({
      'symbols.definitions': { hits: [hit('src/a.ts', 12), hit('lib/b.ts', 3)], total: 2, nextOffset: null, coverage: ready },
    }), path.join(root, 'src')));
    expect(answer).toContain('\na.ts\n');
    expect(answer).toContain('\n../lib/b.ts\n');
  });

  it('refuses a path outside the repository', async () => {
    const answer = await toolFindSymbol({ name: 'run', path: '../../elsewhere/a.ts' }, context(index({})));
    expect(answer).toMatch(/^\[Tool Error\] find_symbol: .*outside the repository/);
  });

  it('points to grep and read when the engine cannot answer', async () => {
    const answer = await toolFindSymbol({ name: 'run' }, context(index({ 'symbols.definitions': new Error('The RepoIntel engine is starting.') })));
    expect(answer).toBe('The repository index cannot answer now (The RepoIntel engine is starting.). Use grep and read instead.');
  });

  it('needs a name', async () => {
    expect(await toolFindSymbol({ name: ' ' }, context(index({})))).toBe('[Tool Error] find_symbol: `name` is required.');
  });
});

describe('file_outline', () => {
  it('lists a file\'s definitions with line ranges and declaring lines, members indented', async () => {
    const asked: Asked[] = [];
    const answer = await toolFileOutline({ path: 'store.ts' }, context(index({
      'file.outline': {
        path: 'src/store.ts', indexed: true, language: 'typescript', withSyntaxErrors: false,
        definitions: [
          hit('src/store.ts', 3, { name: 'Store', kind: 'class', endLine: 20, signature: 'export class Store {' }),
          hit('src/store.ts', 5, { kind: 'method', container: 'Store', endLine: 9, signature: 'async run(task: Task) {' }),
          hit('src/store.ts', 22, { name: 'LIMIT', kind: 'variable' }),
        ],
      },
    }, asked), path.join(root, 'src')));
    expect(asked).toEqual([{ method: 'file.outline', params: { path: 'src/store.ts' } }]);
    expect(answer).toBe([
      'store.ts (typescript, 3 definitions)',
      '  3-20 export class Store {',
      '    5-9 async run(task: Task) {',
      '  22 variable LIMIT',
    ].join('\n'));
  });

  it('warns that a file with syntax errors may be missing definitions', async () => {
    const answer = await toolFileOutline({ path: 'a.ts' }, context(index({
      'file.outline': { path: 'a.ts', indexed: true, language: 'typescript', withSyntaxErrors: true, definitions: [] },
    })));
    expect(answer).toBe('a.ts (typescript, 0 definitions; it has syntax errors, so some may be missing)');
  });

  it('says why a file is not indexed', async () => {
    const answer = await toolFileOutline({ path: 'notes.md' }, context(index({
      'file.outline': { path: 'notes.md', indexed: false, reason: 'language' },
    })));
    expect(answer).toBe('notes.md is not indexed (language). Read it instead.');
  });
});

describe('offering the index tools', () => {
  const names = ['find_symbol', 'file_outline'];

  it('offers them only to a Run the Host bound an index to', () => {
    const bound = buildToolExecutionContext({
      options: { provider: 'offline-fixture', context: { repoIntel: index({}) } },
      runtime: undefined, managedProtocolPayloadRef: { current: undefined },
    });
    const unbound = buildToolExecutionContext({
      options: { provider: 'offline-fixture' }, runtime: undefined, managedProtocolPayloadRef: { current: undefined },
    });
    expect(names.map(name => isToolDiscoverable(name, bound))).toEqual([true, true]);
    expect(names.map(name => isToolDiscoverable(name, unbound))).toEqual([false, false]);
  });

  it('treats them as read-only, and as repository intelligence that the off mode hides', () => {
    expect(names.map(resolveToolCapability)).toEqual(['read', 'read']);
    expect(names.map(isRepoIntelligenceWorkingToolName)).toEqual([true, true]);
  });
});
