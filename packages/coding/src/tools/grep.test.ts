import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolGrep } from './grep.js';

function ctx(cwd?: string) {
  return { backups: new Map(), executionCwd: cwd };
}

describe('toolGrep', () => {
  let tempDir = '';

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  function setup(files: Record<string, string>): string {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-grep-'));
    for (const [name, content] of Object.entries(files)) {
      const dir = join(tempDir, name, '..');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(tempDir, name), content, 'utf-8');
    }
    return tempDir;
  }

  /* ---------- Basic matching (existing) ---------- */

  it('finds matches for safe regular expressions', async () => {
    const dir = setup({ 'notes.txt': 'alpha\nbeta\nGamma\n' });
    const result = await toolGrep(
      { pattern: 'beta', path: join(dir, 'notes.txt') },
      ctx(dir),
    );
    expect(result).toContain('notes.txt:2: beta');
  });

  it('rejects potentially unsafe regular expressions', async () => {
    const result = await toolGrep(
      { pattern: '(a+)+$', path: process.cwd() },
      ctx(),
    );
    expect(result).toContain(
      '[Tool Error] grep: Pattern rejected as potentially unsafe',
    );
  });

  it('returns count in count mode', async () => {
    const dir = setup({ 'data.txt': 'foo\nbar\nfoo\nbaz\nfoo\n' });
    const result = await toolGrep(
      { pattern: 'foo', path: dir, output_mode: 'count' },
      ctx(dir),
    );
    expect(result).toBe('3 matches');
  });

  it('returns files in files_with_matches mode', async () => {
    const dir = setup({ 'a.txt': 'hello\n', 'b.txt': 'world\n' });
    const result = await toolGrep(
      { pattern: 'hello', path: dir, output_mode: 'files_with_matches' },
      ctx(dir),
    );
    expect(result).toContain('a.txt');
    expect(result).not.toContain('b.txt');
  });

  it('case insensitive search with ignore_case', async () => {
    const dir = setup({ 'mixed.txt': 'Alpha\nBETA\ngamma\n' });
    const result = await toolGrep(
      { pattern: 'beta', path: join(dir, 'mixed.txt'), ignore_case: true },
      ctx(dir),
    );
    expect(result).toContain('BETA');
  });

  it('defaults to executionCwd when path is omitted', async () => {
    const dir = setup({ 'target.txt': 'findme\n' });
    const result = await toolGrep({ pattern: 'findme' }, ctx(dir));
    expect(result).toContain('findme');
  });

  /* ---------- Context lines ---------- */

  it('shows after-context lines with -A', async () => {
    const dir = setup({
      'code.ts': 'line1\nMATCH\nafter1\nafter2\nline5\n',
    });
    const result = await toolGrep(
      { pattern: 'MATCH', path: join(dir, 'code.ts'), '-A': 2 },
      ctx(dir),
    );
    expect(result).toContain(':2: MATCH');
    expect(result).toContain('-3- after1');
    expect(result).toContain('-4- after2');
    expect(result).not.toContain('line5');
  });

  it('shows before-context lines with -B', async () => {
    const dir = setup({
      'code.ts': 'before1\nbefore2\nMATCH\nline4\n',
    });
    const result = await toolGrep(
      { pattern: 'MATCH', path: join(dir, 'code.ts'), '-B': 2 },
      ctx(dir),
    );
    expect(result).toContain('-1- before1');
    expect(result).toContain('-2- before2');
    expect(result).toContain(':3: MATCH');
    expect(result).not.toContain('line4');
  });

  it('shows both-direction context with -C/context', async () => {
    const dir = setup({
      'code.ts': 'a\nb\nMATCH\nd\ne\n',
    });
    const result = await toolGrep(
      { pattern: 'MATCH', path: join(dir, 'code.ts'), context: 1 },
      ctx(dir),
    );
    expect(result).toContain('-2- b');
    expect(result).toContain(':3: MATCH');
    expect(result).toContain('-4- d');
  });

  it('separates non-contiguous context groups with --', async () => {
    const dir = setup({
      'code.ts': 'a\nMATCH1\nb\nc\nd\ne\nMATCH2\nf\n',
    });
    const result = await toolGrep(
      { pattern: 'MATCH', path: join(dir, 'code.ts'), '-C': 1 },
      ctx(dir),
    );
    expect(result).toContain(':2: MATCH1');
    expect(result).toContain('--');
    expect(result).toContain(':7: MATCH2');
  });

  it('merges overlapping context regions', async () => {
    const dir = setup({
      'code.ts': 'a\nMATCH1\nb\nMATCH2\nc\n',
    });
    const result = await toolGrep(
      { pattern: 'MATCH', path: join(dir, 'code.ts'), '-C': 1 },
      ctx(dir),
    );
    // No separator between overlapping groups
    expect(result).not.toContain('--');
    expect(result).toContain(':2: MATCH1');
    expect(result).toContain(':4: MATCH2');
  });

  /* ---------- Multiline ---------- */

  it('matches patterns spanning multiple lines in multiline mode', async () => {
    const dir = setup({
      'multi.txt': 'start\nfoo\nbar\nend\n',
    });
    const result = await toolGrep(
      { pattern: 'foo.bar', path: join(dir, 'multi.txt'), multiline: true },
      ctx(dir),
    );
    expect(result).toContain(':2:');
    expect(result).toContain(':3:');
  });

  it('multiline files_with_matches works', async () => {
    const dir = setup({
      'multi.txt': 'hello\nworld\n',
    });
    const result = await toolGrep(
      {
        pattern: 'hello.world',
        path: join(dir, 'multi.txt'),
        multiline: true,
        output_mode: 'files_with_matches',
      },
      ctx(dir),
    );
    expect(result).toContain('multi.txt');
  });

  it('multiline count mode', async () => {
    const dir = setup({
      'multi.txt': 'ab\ncd\nab\ncd\n',
    });
    const result = await toolGrep(
      {
        pattern: 'ab.cd',
        path: join(dir, 'multi.txt'),
        multiline: true,
        output_mode: 'count',
      },
      ctx(dir),
    );
    expect(result).toBe('2 matches');
  });

  /* ---------- File type filter ---------- */

  it('filters by file type', async () => {
    const dir = setup({
      'app.ts': 'target\n',
      'app.js': 'target\n',
      'style.css': 'target\n',
    });
    const result = await toolGrep(
      { pattern: 'target', path: dir, type: 'ts' },
      ctx(dir),
    );
    expect(result).toContain('app.ts');
    expect(result).not.toContain('app.js');
    expect(result).not.toContain('style.css');
  });

  it('rejects unknown file type', async () => {
    const result = await toolGrep(
      { pattern: 'x', path: process.cwd(), type: 'cobol' },
      ctx(),
    );
    expect(result).toContain('[Tool Error] grep: Unknown file type "cobol"');
  });

  /* ---------- Glob filter ---------- */

  it('filters files by glob pattern', async () => {
    const dir = setup({
      'src/a.ts': 'match\n',
      'src/b.js': 'match\n',
      'lib/c.ts': 'match\n',
    });
    const result = await toolGrep(
      { pattern: 'match', path: dir, glob: 'src/**/*.ts' },
      ctx(dir),
    );
    expect(result).toContain('a.ts');
    expect(result).not.toContain('b.js');
    expect(result).not.toContain('c.ts');
  });

  /* ---------- Offset / head_limit ---------- */

  it('skips entries with offset', async () => {
    const dir = setup({
      'data.txt': 'line1\nline2\nline3\nline4\nline5\n',
    });
    const result = await toolGrep(
      { pattern: 'line', path: join(dir, 'data.txt'), offset: 2, head_limit: 2 },
      ctx(dir),
    );
    expect(result).not.toContain('line1');
    expect(result).not.toContain('line2');
    expect(result).toContain('line3');
    expect(result).toContain('line4');
    expect(result).not.toContain('line5');
  });

  it('head_limit caps output entries', async () => {
    const dir = setup({
      'data.txt': 'a\nb\nc\nd\ne\nf\n',
    });
    const result = await toolGrep(
      { pattern: '[a-f]', path: join(dir, 'data.txt'), head_limit: 3 },
      ctx(dir),
    );
    const lines = result.split('\n').filter(Boolean);
    expect(lines.length).toBe(3);
  });

  it('head_limit 0 returns all matches (unlimited)', async () => {
    const dir = setup({
      'data.txt': 'a\nb\nc\nd\ne\n',
    });
    const result = await toolGrep(
      { pattern: '[a-e]', path: join(dir, 'data.txt'), head_limit: 0 },
      ctx(dir),
    );
    expect(result).toContain(':1: a');
    expect(result).toContain(':5: e');
  });

  it('offset beyond total matches returns no-matches message', async () => {
    const dir = setup({ 'data.txt': 'a\nb\n' });
    const result = await toolGrep(
      { pattern: '[ab]', path: join(dir, 'data.txt'), offset: 100 },
      ctx(dir),
    );
    expect(result).toContain('No matches');
    expect(result).toContain('offset=100');
  });

  /* ---------- Error handling ---------- */

  it('returns error for invalid output mode', async () => {
    const result = await toolGrep(
      { pattern: 'x', path: process.cwd(), output_mode: 'invalid' },
      ctx(),
    );
    expect(result).toContain('Unsupported output mode');
  });

  it('returns error for non-existent path', async () => {
    const result = await toolGrep(
      { pattern: 'x', path: '/nonexistent/path/xyz' },
      ctx(),
    );
    expect(result).toContain('[Tool Error] grep: Path not found');
  });
});
