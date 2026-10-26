import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

  it.each(['true', 'false'])('preserves spaced Unicode paths and rename destinations with core.quotepath=%s', async quotePath => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-changed-scope-'));
    initGitRepo(tempDir);
    const git = (args: string[]) => execFileSync('git', args, { cwd: tempDir, stdio: 'ignore', windowsHide: true });
    git(['config', 'core.quotepath', quotePath]);
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(join(tempDir, 'src', '旧 file.ts'), 'export const renamed = true;\n');
    commitAll(tempDir, 'initial');
    renameSync(join(tempDir, 'src', '旧 file.ts'), join(tempDir, 'src', '新 file.ts'));
    git(['add', 'src']);
    writeFileSync(join(tempDir, 'src', '多  空格.ts'), 'export const added = true;\n');
    const context = { backups: new Map<string, string>(), executionCwd: tempDir };
    const all = await toolChangedScope({ scope: 'all' }, context);
    expect(all).toContain('- renamed src/新 file.ts [source] -> src');
    expect(all).toContain('- untracked src/多  空格.ts [source] -> src');
    expect(all).toContain('Categories: source=2 docs=0 tests=0 config=0 other=0');
    expect(all).not.toContain('Cross-area change');
    const staged = await toolChangedScope({ scope: 'staged' }, context);
    expect(staged).toContain('- renamed src/新 file.ts [source] -> src');
    expect(staged).not.toContain('src/多  空格.ts');
    const unstaged = await toolChangedScope({ scope: 'unstaged' }, context);
    expect(unstaged).toContain('- untracked src/多  空格.ts [source] -> src');
    expect(unstaged).not.toContain('src/新 file.ts');
    git(['add', 'src']);
    git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'rename and add']);
    const compared = await toolChangedScope({ scope: 'compare', base_ref: 'HEAD~1' }, context);
    expect(compared).toContain('- renamed src/新 file.ts [source] -> src');
    expect(compared).toContain('- added src/多  空格.ts [source] -> src');
    expect(compared).toContain('Changed files: 2');
    expect(compared).not.toContain('旧 file.ts');
  });
});
