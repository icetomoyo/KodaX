import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolRepoOverview } from './repo-overview.js';
import { initGitRepo } from './test-helpers.js';

describe('toolRepoOverview', () => {
  let tempDir = '';

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('summarizes the workspace and persists a repo overview snapshot', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-repo-overview-'));
    initGitRepo(tempDir);

    mkdirSync(join(tempDir, 'packages', 'app', 'src'), { recursive: true });
    mkdirSync(join(tempDir, 'docs'), { recursive: true });
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'workspace-root' }, null, 2));
    writeFileSync(join(tempDir, 'packages', 'app', 'package.json'), JSON.stringify({ name: '@demo/app' }, null, 2));
    writeFileSync(join(tempDir, 'packages', 'app', 'src', 'index.ts'), 'export const value = 1;\n');
    writeFileSync(join(tempDir, 'docs', 'PRD.md'), '# PRD\n');

    const result = await toolRepoOverview({
      refresh: true,
    }, {
      backups: new Map(),
      executionCwd: join(tempDir, 'packages', 'app'),
    });

    expect(result).toContain('Repository overview for');
    expect(result).toContain(`Root: ${tempDir}`);
    expect(result).toContain('Key manifests:');
    expect(result).toContain('packages/app/package.json');
    expect(result).toContain('@demo/app');
    expect(result).toContain('Entry hints:');
    expect(result).toContain('packages/app/src/index.ts');
    expect(existsSync(join(tempDir, '.agent', 'repo-intelligence', 'repo-overview.json'))).toBe(true);
  });
});
