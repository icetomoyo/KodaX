import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import fs from 'fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toolGrep } from './grep.js';

function ctx(cwd?: string) {
  return { backups: new Map(), executionCwd: cwd };
}

describe('toolGrep', () => {
  let tempDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('matches long literal strings directly without weakening regex safety', async () => {
    const pattern = 'Ab.[x](a+)+$\\'.repeat(24);
    const dir = setup({ '源 码/target.ts': `before\r\n${pattern}\r\nafter\r\n`, 'decoy.ts': 'AbXxaaaa\n' });
    const result = await toolGrep({ pattern, literal: true, path: dir }, ctx(dir));
    expect(result).toContain('target.ts:2:');
    expect(result).not.toContain('decoy.ts');
    expect(result).not.toContain('[Tool Error]');
    expect(await toolGrep({ pattern: pattern.toLowerCase(), literal: true, ignore_case: true, path: dir, output_mode: 'count' }, ctx(dir))).toBe('1 matches');
    expect(await toolGrep({ pattern, path: dir }, ctx(dir))).toContain('256-character safety limit');
    expect(await toolGrep({ pattern: '(a+)+$', literal: false, path: dir }, ctx(dir))).toContain('potentially unsafe');
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

  it('counts every multiline match instead of silently stopping at 200', async () => {
    const content = Array.from({ length: 240 }, () => 'ab\ncd').join('\n');
    const dir = setup({ 'multi.txt': content });
    const result = await toolGrep(
      {
        pattern: 'ab.cd',
        path: join(dir, 'multi.txt'),
        multiline: true,
        output_mode: 'count',
      },
      ctx(dir),
    );
    expect(result).toBe('240 matches');
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
    const matchLines = result.split('\n').filter((line) => /data\.txt:\d+:/.test(line));
    expect(matchLines).toHaveLength(3);
    expect(result).toContain('Continue with offset=3');
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

  it('rejects a negative head_limit instead of treating it as unlimited', async () => {
    const dir = setup({
      'data.txt': 'a\nb\nc\n',
    });
    const result = await toolGrep(
      { pattern: '[a-c]', path: join(dir, 'data.txt'), head_limit: -1 },
      ctx(dir),
    );

    expect(result).toBe('[Tool Error] grep: head_limit must be a non-negative finite number.');
    expect(result).not.toContain(':3: c');
  });

  it('head_limit 0 bypasses the entry cap but keeps the source byte budget', async () => {
    const content = Array.from({ length: 2_100 }, (_, index) => `match-${index + 1}`).join('\n');
    const dir = setup({ 'large.txt': content });
    const result = await toolGrep(
      { pattern: 'match-', path: join(dir, 'large.txt'), head_limit: 0 },
      ctx(dir),
    );
    expect(result).toContain(':1: match-1');
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThan(54 * 1024);
    expect(result).toContain('More matches available');
    expect(result).toContain('Continue with offset=');
  });

  it('searches beyond the former 100-file scan cap', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [
        `file-${index.toString().padStart(3, '0')}.txt`,
        `needle-${index}\n`,
      ]),
    );
    const dir = setup(files);
    const result = await toolGrep(
      { pattern: 'needle-', path: dir, head_limit: 0 },
      ctx(dir),
    );
    const matchLines = result.split('\n').filter((line) => /file-\d+\.txt:1:/.test(line));
    expect(matchLines).toHaveLength(120);
  });

  it('marks a bounded directory scan incomplete and continues with scan_offset', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 513 }, (_, index) => [
        `file-${index.toString().padStart(3, '0')}.txt`,
        'no match here\n',
      ]),
    );
    const dir = setup(files);

    const first = await toolGrep({ pattern: 'needle', path: dir }, ctx(dir));
    const second = await toolGrep({
      pattern: 'needle',
      path: dir,
      scan_offset: 512,
    }, ctx(dir));

    expect(first).toContain('SOURCE_INCOMPLETE');
    expect(first).toContain('scan_offset=512');
    expect(second).not.toContain('SOURCE_INCOMPLETE');
  });

  it('keeps a large result page inside the grep source byte budget', async () => {
    const content = Array.from(
      { length: 350 },
      (_, index) => `needle-${index}-${'x'.repeat(100)}`,
    ).join('\n');
    const dir = setup({ 'large.txt': content });
    const result = await toolGrep(
      { pattern: 'needle-', path: join(dir, 'large.txt'), head_limit: 0 },
      ctx(dir),
    );
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThan(54 * 1024);
    expect(result).toContain(':1: needle-0-');
    expect(result).toContain('More matches available');
    expect(result).toContain('Continue with offset=');
  });

  it('clips long match, context, and multiline entries with a read continuation hint', async () => {
    const contextLine = `context-${'c'.repeat(700)}`;
    const matchLine = `needle-${'m'.repeat(700)}`;
    const dir = setup({ 'long-lines.txt': `${contextLine}\n${matchLine}\n` });
    const filePath = join(dir, 'long-lines.txt');

    const direct = await toolGrep(
      { pattern: 'needle-', path: filePath },
      ctx(dir),
    );
    const withContext = await toolGrep(
      { pattern: 'needle-', path: filePath, '-B': 1 },
      ctx(dir),
    );
    const multiline = await toolGrep(
      { pattern: 'needle-', path: filePath, multiline: true },
      ctx(dir),
    );

    expect(direct).not.toContain(matchLine);
    expect(withContext).not.toContain(contextLine);
    expect(multiline).not.toContain(matchLine);
    expect(`${direct}\n${withContext}\n${multiline}`).toContain('line clipped');
    expect(`${direct}\n${withContext}\n${multiline}`).toContain('line_offset');
    for (const line of `${direct}\n${withContext}\n${multiline}`.split('\n')) {
      expect(Array.from(line).length).toBeLessThanOrEqual(500);
    }
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

  it('reports every unreadable file instead of hiding errors after a sample', async () => {
    const fileNames = Array.from({ length: 5 }, (_, index) => `unreadable-${index + 1}.txt`);
    const dir = setup(Object.fromEntries(fileNames.map((name) => [name, 'needle\n'])));
    const readFileSpy = vi.spyOn(fs, 'readFile').mockRejectedValue(
      new Error('simulated read failure'),
    );

    const result = await toolGrep(
      { pattern: 'needle', path: dir, head_limit: 0 },
      ctx(dir),
    );

    expect(readFileSpy).toHaveBeenCalledTimes(fileNames.length);
    for (const fileName of fileNames) {
      expect(result).toContain(join(dir, fileName));
    }
    expect(result).not.toContain('more');
  });

  it('revalidates every enumerated file through the host read policy', async () => {
    const dir = setup({
      'public.txt': 'needle public\n',
      'credentials': 'needle secret\n',
    });
    const checked: string[] = [];
    const result = await toolGrep(
      { pattern: 'needle', path: dir, head_limit: 0 },
      {
        backups: new Map(),
        executionCwd: dir,
        assertReadablePath(candidate) {
          checked.push(candidate);
          if (candidate.endsWith('credentials')) throw new Error('blocked');
        },
      },
    );

    expect(checked.map((candidate) => candidate.split(/[\\/]/).at(-1))).toEqual([
      'credentials',
      'public.txt',
    ]);
    expect(result).toContain('needle public');
    expect(result).not.toContain('needle secret');
    expect(result).not.toContain('credentials');
  });
});
