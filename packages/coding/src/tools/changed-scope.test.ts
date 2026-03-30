import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolChangedScope } from './changed-scope.js';
import { commitAll, initGitRepo } from './test-helpers.js';

describe('toolChangedScope', () => {
  let tempDir = '';

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('analyzes the current git diff without counting repo-intelligence artifacts', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-changed-scope-'));
    initGitRepo(tempDir);

    mkdirSync(join(tempDir, 'packages', 'app', 'src'), { recursive: true });
    mkdirSync(join(tempDir, 'docs'), { recursive: true });
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'workspace-root' }, null, 2));
    writeFileSync(join(tempDir, 'packages', 'app', 'package.json'), JSON.stringify({ name: '@demo/app' }, null, 2));
    writeFileSync(join(tempDir, 'packages', 'app', 'src', 'index.ts'), 'export const value = 1;\n');
    writeFileSync(join(tempDir, 'docs', 'PRD.md'), '# PRD\n');
    commitAll(tempDir, 'initial');

    mkdirSync(join(tempDir, 'packages', 'api'), { recursive: true });
    writeFileSync(join(tempDir, 'packages', 'app', 'src', 'index.ts'), 'export const value = 2;\n');
    writeFileSync(join(tempDir, 'docs', 'PRD.md'), '# PRD\n\nUpdated.\n');
    writeFileSync(join(tempDir, 'packages', 'api', 'package.json'), JSON.stringify({ name: '@demo/api' }, null, 2));

    const result = await toolChangedScope({
      scope: 'all',
      refresh_overview: true,
    }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('Changed scope for');
    expect(result).toContain('Changed files: 3');
    expect(result).toContain('Categories: source=1 docs=1 tests=0 config=1 other=0');
    expect(result).toContain('packages/app/src/index.ts');
    expect(result).toContain('packages/api/package.json');
    expect(result).toContain('docs/PRD.md');
    expect(result).not.toContain('.agent/repo-intelligence');
    expect(existsSync(join(tempDir, '.agent', 'repo-intelligence', 'changed-scope.json'))).toBe(true);
  });
});
