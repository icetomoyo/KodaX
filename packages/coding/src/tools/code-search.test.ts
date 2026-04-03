import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolCodeSearch } from './code-search.js';

describe('toolCodeSearch', () => {
  let tempDir = '';

  afterEach(() => {
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
});
