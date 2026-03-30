import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolChangedDiff, toolChangedDiffBundle } from './changed-diff.js';
import { commitAll, initGitRepo } from './test-helpers.js';

function gitStdout(workspaceRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: workspaceRoot,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  }).trim();
}

describe('toolChangedDiff', () => {
  let tempDir = '';

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('paginates the current workspace diff for a specific file', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-changed-diff-'));
    initGitRepo(tempDir);

    mkdirSync(join(tempDir, 'packages', 'app', 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'packages', 'app', 'src', 'task-engine.ts'), [
      'export function alpha() {',
      "  return 'a';",
      '}',
      '',
      'export function beta() {',
      "  return 'b';",
      '}',
      '',
    ].join('\n'));
    commitAll(tempDir, 'initial');

    writeFileSync(join(tempDir, 'packages', 'app', 'src', 'task-engine.ts'), [
      'export function alpha() {',
      "  return 'admission';",
      '}',
      '',
      'export function beta() {',
      "  return 'generator';",
      '}',
      '',
      'export function gamma() {',
      "  return 'evaluator';",
      '}',
      '',
    ].join('\n'));

    const firstPage = await toolChangedDiff({
      path: 'packages/app/src/task-engine.ts',
      offset: 1,
      limit: 8,
    }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(firstPage).toContain('Changed diff for packages/app/src/task-engine.ts');
    expect(firstPage).toContain('Showing diff lines 1-8');
    expect(firstPage).toContain('Use changed_diff with offset=9 limit=8');

    const secondPage = await toolChangedDiff({
      path: 'packages/app/src/task-engine.ts',
      offset: 9,
      limit: 8,
    }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(secondPage).toContain("+  return 'generator';");
    expect(secondPage).toContain("+export function gamma() {");
  });

  it('reads compare-range diffs for the requested file', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-changed-diff-'));
    initGitRepo(tempDir);

    mkdirSync(join(tempDir, 'docs'), { recursive: true });
    writeFileSync(join(tempDir, 'docs', 'FEATURE.md'), '# Feature\n\nalpha\n');
    commitAll(tempDir, 'initial');
    const baseRef = gitStdout(tempDir, ['rev-parse', 'HEAD']);

    writeFileSync(join(tempDir, 'docs', 'FEATURE.md'), '# Feature\n\nalpha\n\nbeta\n\ngamma\n');
    commitAll(tempDir, 'expand feature doc');

    const result = await toolChangedDiff({
      path: 'docs/FEATURE.md',
      base_ref: baseRef,
      limit: 40,
    }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain(`Range: ${baseRef}...HEAD`);
    expect(result).toContain('+beta');
    expect(result).toContain('+gamma');
  });

  it('resolves the workspace root when target_path points to a file', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-changed-diff-'));
    initGitRepo(tempDir);

    mkdirSync(join(tempDir, 'packages', 'app', 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'packages', 'app', 'src', 'feature.ts'), [
      'export const value = 1;',
      '',
    ].join('\n'));
    commitAll(tempDir, 'initial');

    writeFileSync(join(tempDir, 'packages', 'app', 'src', 'feature.ts'), [
      'export const value = 2;',
      '',
    ].join('\n'));

    const result = await toolChangedDiff({
      target_path: 'packages/app/src/feature.ts',
      path: 'packages/app/src/feature.ts',
      limit: 20,
    }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('Changed diff for packages/app/src/feature.ts');
    expect(result).toContain("-export const value = 1;");
    expect(result).toContain("+export const value = 2;");
  });

  it('reads a bundle of workspace diffs for multiple files', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-changed-diff-'));
    initGitRepo(tempDir);

    mkdirSync(join(tempDir, 'packages', 'app', 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'packages', 'app', 'src', 'alpha.ts'), 'export const alpha = 1;\n');
    writeFileSync(join(tempDir, 'packages', 'app', 'src', 'beta.ts'), 'export const beta = 1;\n');
    commitAll(tempDir, 'initial');

    writeFileSync(join(tempDir, 'packages', 'app', 'src', 'alpha.ts'), 'export const alpha = 2;\n');
    writeFileSync(join(tempDir, 'packages', 'app', 'src', 'beta.ts'), 'export const beta = 3;\n');

    const result = await toolChangedDiffBundle({
      paths: [
        'packages/app/src/alpha.ts',
        'packages/app/src/beta.ts',
      ],
      limit_per_path: 20,
    }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('Changed diff bundle for 2 file(s)');
    expect(result).toContain('=== packages/app/src/alpha.ts ===');
    expect(result).toContain('=== packages/app/src/beta.ts ===');
    expect(result).toContain("+export const alpha = 2;");
    expect(result).toContain("+export const beta = 3;");
  });

  it('reads compare-range bundle diffs with per-file continuation hints', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-changed-diff-'));
    initGitRepo(tempDir);

    mkdirSync(join(tempDir, 'docs'), { recursive: true });
    writeFileSync(join(tempDir, 'docs', 'A.md'), '# A\n\none\n');
    writeFileSync(join(tempDir, 'docs', 'B.md'), '# B\n\ntwo\n');
    commitAll(tempDir, 'initial');
    const baseRef = gitStdout(tempDir, ['rev-parse', 'HEAD']);

    writeFileSync(join(tempDir, 'docs', 'A.md'), '# A\n\none\n\ntwo\n\nthree\n');
    writeFileSync(join(tempDir, 'docs', 'B.md'), '# B\n\ntwo\n\nthree\n\nfour\n');
    commitAll(tempDir, 'expand docs');

    const result = await toolChangedDiffBundle({
      base_ref: baseRef,
      paths: ['docs/A.md', 'docs/B.md'],
      limit_per_path: 6,
    }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain(`Range: ${baseRef}...HEAD`);
    expect(result).toContain('=== docs/A.md ===');
    expect(result).toContain('=== docs/B.md ===');
    expect(result).toContain('[Continue docs/A.md with changed_diff path=docs/A.md');
    expect(result).toContain('[Continue docs/B.md with changed_diff path=docs/B.md');
  });

  it('suggests larger continuation windows for dominant large diffs', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-changed-diff-'));
    initGitRepo(tempDir);

    mkdirSync(join(tempDir, 'packages', 'app', 'src'), { recursive: true });
    const initialLines = Array.from({ length: 1100 }, (_, index) => `export const value${index} = 'a';`);
    const updatedLines = Array.from({ length: 1100 }, (_, index) => `export const value${index} = 'b';`);
    writeFileSync(join(tempDir, 'packages', 'app', 'src', 'task-engine.ts'), `${initialLines.join('\n')}\n`);
    commitAll(tempDir, 'initial');

    writeFileSync(join(tempDir, 'packages', 'app', 'src', 'task-engine.ts'), `${updatedLines.join('\n')}\n`);

    const page = await toolChangedDiff({
      path: 'packages/app/src/task-engine.ts',
      offset: 1,
      limit: 120,
    }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(page).toContain('Showing diff lines 1-120');
    expect(page).toContain('Large diff detected.');
    expect(page).toContain('limit=480');
  });
});
