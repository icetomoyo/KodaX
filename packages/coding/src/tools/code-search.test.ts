import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toolCodeSearch } from './code-search.js';
import { toolGrep } from './grep.js';
import { toolGlob } from './glob.js';

describe('toolCodeSearch', () => {
  let tempDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('finds local code matches with retrieval metadata', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-code-search-'));
    writeFileSync(join(tempDir, 'alpha.ts'), 'export const NameService = 1;\n', 'utf-8');
    writeFileSync(join(tempDir, 'beta.ts'), 'export function normalizeName() { return "ok"; }\n', 'utf-8');

    const result = await toolCodeSearch({
      query: 'Name',
      path: tempDir,
      limit: 4,
    }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('Retrieval result for code_search');
    expect(result).toContain('Scope: workspace | Trust: workspace | Freshness: snapshot');
    expect(result).toContain('alpha.ts');
  });

  it('can replace local literal content and filename lookup with existing grep and glob', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-search-substitution-'));
    writeFileSync(join(tempDir, 'cache-store.ts'), 'export const TTL = "clock() >= insertedAt + ttlMs";\n', 'utf8');
    writeFileSync(join(tempDir, 'decoy.ts'), 'export const note = "clockX >= insertedAt + ttlMs";\n', 'utf8');
    const ctx = { backups: new Map<string, string>(), executionCwd: tempDir };
    const local = await toolCodeSearch({ query: 'clock()', path: tempDir, case_sensitive: true }, ctx);
    const grep = await toolGrep({ pattern: 'clock\\(\\)', path: tempDir }, ctx);
    for (const result of [local, grep]) {
      expect(result).toContain('cache-store.ts');
      expect(result).toContain('insertedAt + ttlMs');
      expect(result).not.toContain('decoy.ts');
    }
    expect(await toolCodeSearch({ query: 'cache-store', path: tempDir }, ctx)).toContain('cache-store.ts');
    expect(await toolGlob({ pattern: '**/*cache-store*', path: tempDir }, ctx)).toContain('cache-store.ts');
    expect(await toolGrep({ pattern: 'ttl', path: tempDir, ignore_case: true }, ctx)).toContain('export const TTL');
  });

  it('uses provider-backed code search when requested', async () => {
    const result = await toolCodeSearch({
      query: 'NameService',
      provider_id: 'provider-1',
    }, {
      backups: new Map(),
      executionCwd: process.cwd(),
      extensionRuntime: {
        searchCapabilities: async () => ([
          { title: 'Provider match', path: '/virtual/provider.ts' },
        ]),
      } as never,
    });

    expect(result).toContain('Provider: provider-1');
    expect(result).toContain('Provider match');
  });

  it('probes one extra provider result so an explicit limit is never silently incomplete', async () => {
    let requestedLimit: number | undefined;
    const result = await toolCodeSearch({
      query: 'NameService',
      provider_id: 'provider-1',
      limit: 2,
    }, {
      backups: new Map(),
      executionCwd: process.cwd(),
      extensionRuntime: {
        searchCapabilities: async (_provider: string, _query: string, options: { limit?: number }) => {
          requestedLimit = options.limit;
          return [
            { title: 'Provider match 1', path: '/virtual/one.ts' },
            { title: 'Provider match 2', path: '/virtual/two.ts' },
            { title: 'Provider match 3', path: '/virtual/three.ts' },
          ];
        },
      } as never,
    });

    expect(requestedLimit).toBe(3);
    expect(result).toContain('RESULT_LIMIT_REACHED');
    expect(result).toContain('Provider match 2');
    expect(result).not.toContain('Provider match 3');
  });

  it('does not mark an exact provider result count as incomplete', async () => {
    const result = await toolCodeSearch({
      query: 'NameService',
      provider_id: 'provider-1',
      limit: 2,
    }, {
      backups: new Map(),
      executionCwd: process.cwd(),
      extensionRuntime: {
        searchCapabilities: async () => ([
          { title: 'Provider match 1', path: '/virtual/one.ts' },
          { title: 'Provider match 2', path: '/virtual/two.ts' },
        ]),
      } as never,
    });

    expect(result).not.toContain('RESULT_LIMIT_REACHED');
  });

  it('does not silently omit candidate files after the former 300-file cap', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-code-search-'));
    for (let index = 0; index < 305; index++) {
      writeFileSync(join(tempDir, `candidate-${index.toString().padStart(3, '0')}.ts`), '', 'utf-8');
    }

    const result = await toolCodeSearch({
      query: 'not-present',
      path: tempDir,
    }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('- scannedFiles: 305');
  });

  it('marks a bounded workspace scan incomplete and exposes the next scan offset', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-code-search-'));
    for (let index = 0; index < 513; index++) {
      writeFileSync(join(tempDir, `candidate-${index.toString().padStart(3, '0')}.ts`), '', 'utf-8');
    }

    const first = await toolCodeSearch({
      query: 'not-present',
      path: tempDir,
    }, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    const second = await toolCodeSearch({
      query: 'not-present',
      path: tempDir,
      scan_offset: 512,
    }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(first).toContain('SOURCE_INCOMPLETE');
    expect(first).toContain('scan_offset=512');
    expect(first).toContain('- scannedFiles: 512');
    expect(first).toContain('- candidateFiles: 513');
    expect(second).not.toContain('SOURCE_INCOMPLETE');
    expect(second).toContain('- scannedFiles: 1');
  });

  it('marks the source incomplete when a candidate cannot be read', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-code-search-'));
    writeFileSync(join(tempDir, 'unreadable.ts'), 'const target = true;\n', 'utf-8');
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('access denied'));

    const result = await toolCodeSearch({
      query: 'target',
      path: tempDir,
    }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('SOURCE_INCOMPLETE');
    expect(result).toContain('- unreadableFiles: 1');
  });

  it('makes the explicit result limit visible instead of implying completeness', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-code-search-'));
    for (let index = 0; index < 3; index++) {
      writeFileSync(join(tempDir, `match-${index}.ts`), `const target${index} = true;\n`, 'utf-8');
    }

    const result = await toolCodeSearch({
      query: 'target',
      path: tempDir,
      limit: 2,
    }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('RESULT_LIMIT_REACHED');
    expect(result).toContain('limit=2');
    expect(result.match(/^\d+\. /gm)).toHaveLength(2);
  });

  it('does not mark exactly N local matches as incomplete', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-code-search-'));
    for (let index = 0; index < 2; index++) {
      writeFileSync(join(tempDir, `source-${index}.ts`), `const target${index} = true;\n`, 'utf-8');
    }

    const result = await toolCodeSearch({
      query: 'target',
      path: tempDir,
      limit: 2,
    }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).not.toContain('RESULT_LIMIT_REACHED');
    expect(result).toContain('target1');
  });
});
