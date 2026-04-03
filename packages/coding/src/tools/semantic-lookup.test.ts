import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolSemanticLookup } from './semantic-lookup.js';

function createWorkspaceFixture(workspaceRoot: string): void {
  mkdirSync(join(workspaceRoot, 'packages', 'shared', 'src'), { recursive: true });
  mkdirSync(join(workspaceRoot, 'packages', 'app', 'src'), { recursive: true });

  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'workspace-root' }, null, 2));
  writeFileSync(join(workspaceRoot, 'packages', 'shared', 'package.json'), JSON.stringify({ name: '@demo/shared' }, null, 2));
  writeFileSync(join(workspaceRoot, 'packages', 'app', 'package.json'), JSON.stringify({ name: '@demo/app' }, null, 2));

  writeFileSync(join(workspaceRoot, 'packages', 'shared', 'src', 'name-service.ts'), [
    'export class NameService {',
    '  normalize(input: string): string {',
    '    return input.trim().toUpperCase();',
    '  }',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(workspaceRoot, 'packages', 'app', 'src', 'index.ts'), [
    "import { NameService } from '../../shared/src/name-service';",
    '',
    'export function startServer(name: string): string {',
    '  const service = new NameService();',
    '  return service.normalize(name);',
    '}',
    '',
  ].join('\n'));
}

describe('toolSemanticLookup', () => {
  let tempDir = '';

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('returns semantic symbol matches from repo intelligence', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-semantic-lookup-'));
    createWorkspaceFixture(tempDir);

    const result = await toolSemanticLookup({
      query: 'NameService',
      target_path: 'packages/app',
      kind: 'auto',
    }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('Retrieval result for semantic_lookup');
    expect(result).toContain('NameService');
    expect(result).toContain('Scope: workspace | Trust: workspace | Freshness: snapshot');
  }, 15000);
});
