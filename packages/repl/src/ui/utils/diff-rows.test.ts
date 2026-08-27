/**
 * Diff display-row builder tests.
 *
 * Locks the parsing contract of `buildDiffRows`: it turns the raw
 * edit / write / multi_edit / insert_after_anchor tool-result text
 * (preamble + summary + embedded unified diff + optional LSP suffix)
 * into flat display rows with a line-number gutter, correct
 * add/remove classification, and changed-lines-first folding.
 *
 * Fixture shapes mirror the real producers:
 *   - packages/coding/src/tools/edit.ts:184-198
 *   - packages/coding/src/tools/write.ts:71-78
 *   - packages/coding/src/tools/multi-edit.ts:131-133
 *   - packages/coding/src/tools/insert-after-anchor.ts:70-71
 *   - active-file-warning banner prepended before the preamble
 *   - LSP diagnostics appended after the diff body
 */

import { describe, expect, it } from 'vitest';
import { buildDiffRows } from './diff-rows.js';

const EDIT_OUTPUT = [
  'File edited: src/foo.ts',
  '  (+2 lines, -1 lines)',
  '',
  '--- src/foo.ts',
  '+++ src/foo.ts',
  '@@ -10,3 +10,4 @@',
  '  ctx-one',
  '-old-line',
  '+new-line-one',
  '+new-line-two',
  '  ctx-two',
].join('\n');

describe('buildDiffRows — standard edit output', () => {
  it('emits guttered rows with correct kinds and line numbers', () => {
    const result = buildDiffRows(EDIT_OUTPUT);
    expect(result).not.toBeNull();
    expect(result?.rows.map((r) => `${r.kind}|${r.text}`)).toEqual([
      'context|10 │   ctx-one',
      'remove|11 │ - old-line',
      'add|11 │ + new-line-one',
      'add|12 │ + new-line-two',
      'context|13 │   ctx-two',
    ]);
    expect(result?.hiddenRowCount).toBe(0);
  });

  it('drops preamble, summary, ---/+++ headers and @@ headers', () => {
    const result = buildDiffRows(EDIT_OUTPUT);
    const texts = result?.rows.map((r) => r.text).join('\n') ?? '';
    expect(texts).not.toContain('File edited');
    expect(texts).not.toContain('+2 lines');
    expect(texts).not.toContain('---');
    expect(texts).not.toContain('@@');
  });

  it('resets counters at each @@ header across multiple hunks', () => {
    const output = [
      'File edited: src/foo.ts',
      '  (+2 lines, -2 lines)',
      '',
      '--- src/foo.ts',
      '+++ src/foo.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '@@ -50,2 +50,2 @@',
      '  late-ctx',
      '-c',
      '+d',
    ].join('\n');
    const result = buildDiffRows(output);
    // Gutter width is uniform across the whole diff (max = 51 → width 2),
    // so early-hunk single-digit numbers are right-aligned.
    expect(result?.rows.map((r) => `${r.kind}|${r.text}`)).toEqual([
      'remove| 1 │ - a',
      'add| 1 │ + b',
      'context|50 │   late-ctx',
      'remove|51 │ - c',
      'add|51 │ + d',
    ]);
  });

  it('pads the gutter to the widest line number', () => {
    const output = [
      'File edited: src/foo.ts',
      '  (+1 lines, -1 lines)',
      '',
      '--- src/foo.ts',
      '+++ src/foo.ts',
      '@@ -9,3 +9,4 @@',
      '  ctx',
      '-old',
      '+new',
    ].join('\n');
    // Max line number 11 → width 2 → single-digit numbers right-aligned.
    expect(buildDiffRows(output)?.rows.map((r) => r.text)).toEqual([
      ' 9 │   ctx',
      '10 │ - old',
      '10 │ + new',
    ]);
  });
});

describe('buildDiffRows — real-world output shapes', () => {
  it('handles the headerless single-line edit body without a gutter', () => {
    const output = [
      'File edited: src/foo.ts',
      '  (+1 lines, -1 lines)',
      '',
      '-old single line',
      '+new single line',
    ].join('\n');
    expect(buildDiffRows(output)?.rows.map((r) => `${r.kind}|${r.text}`)).toEqual([
      'remove|- old single line',
      'add|+ new single line',
    ]);
  });

  it('renders banner lines before the preamble as dim notes, not removals', () => {
    const output = [
      '⚠ concurrent edit detected',
      '- pid 123 is editing src/foo.ts',
      '',
      'File edited: src/foo.ts',
      '  (+1 lines, -1 lines)',
      '',
      '--- src/foo.ts',
      '+++ src/foo.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    const rows = buildDiffRows(output)?.rows ?? [];
    expect(rows[0]).toEqual({ kind: 'note', text: '⚠ concurrent edit detected' });
    expect(rows[1]).toEqual({ kind: 'note', text: '- pid 123 is editing src/foo.ts' });
    // The banner's "- pid" line must not be classified as a diff removal.
    expect(rows.filter((r) => r.kind === 'remove')).toHaveLength(1);
    expect(rows[rows.length - 1]?.text).toBe('1 │ + new');
  });

  it('renders LSP diagnostics appended after the diff as trailing notes', () => {
    const output = [
      'File edited: src/foo.ts',
      '  (+1 lines, -1 lines)',
      '',
      '--- src/foo.ts',
      '+++ src/foo.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
      'LSP errors detected in this file, please fix:',
      '<diagnostics file="src/foo.ts">',
      'ERROR [12:5] something bad',
      '</diagnostics>',
    ].join('\n');
    const rows = buildDiffRows(output)?.rows ?? [];
    const kinds = rows.map((r) => r.kind);
    expect(kinds.filter((k) => k === 'context')).toHaveLength(0);
    expect(rows.slice(-4).map((r) => r.text)).toEqual([
      'LSP errors detected in this file, please fix:',
      '<diagnostics file="src/foo.ts">',
      'ERROR [12:5] something bad',
      '</diagnostics>',
    ]);
    expect(rows.slice(-4).every((r) => r.kind === 'note')).toBe(true);
  });

  it('handles blank context lines ("  ") and blank changed lines', () => {
    const output = [
      'File edited: src/foo.ts',
      '  (+2 lines, -1 lines)',
      '',
      '--- src/foo.ts',
      '+++ src/foo.ts',
      '@@ -1,4 +1,5 @@',
      '  ',
      '-old',
      '+',
      '+after',
    ].join('\n');
    expect(buildDiffRows(output)?.rows.map((r) => `${r.kind}|${r.text}`)).toEqual([
      'context|1 │',
      'remove|2 │ - old',
      'add|2 │ +',
      'add|3 │ + after',
    ]);
  });

  it('parses a @@ header even when no preamble line exists', () => {
    const output = ['--- src/foo.ts', '+++ src/foo.ts', '@@ -5 +5 @@', '-old', '+new'].join('\n');
    expect(buildDiffRows(output)?.rows.map((r) => r.text)).toEqual([
      '5 │ - old',
      '5 │ + new',
    ]);
  });
});

describe('buildDiffRows — no-diff outputs', () => {
  it('returns null for a new-file write (no diff body)', () => {
    expect(buildDiffRows('File created: src/new.ts\n  (12 lines written)')).toBeNull();
  });

  it('returns null for a no-change write', () => {
    expect(buildDiffRows('File written: src/foo.ts (no changes)')).toBeNull();
  });

  it('returns null for output with no recognizable anchors', () => {
    expect(buildDiffRows('some random tool output\nnothing diff-like')).toBeNull();
  });
});

describe('buildDiffRows — folding', () => {
  function makeOutput(adds: number, contexts: number): string {
    const body: string[] = ['@@ -1,1 +1,1 @@'];
    for (let i = 0; i < adds; i++) body.push(`+add-${i}`);
    for (let i = 0; i < contexts; i++) body.push(`  ctx-${i}`);
    return ['File edited: src/foo.ts', '  (+1 lines, -1 lines)', '', ...body].join('\n');
  }

  it('keeps everything when within maxRows', () => {
    const result = buildDiffRows(makeOutput(12, 8), { maxRows: 20 });
    expect(result?.rows).toHaveLength(20);
    expect(result?.hiddenRowCount).toBe(0);
  });

  it('sheds context rows but keeps every changed row when over maxRows', () => {
    const result = buildDiffRows(makeOutput(15, 12), { maxRows: 20 });
    expect(result?.rows).toHaveLength(15);
    expect(result?.rows.every((r) => r.kind === 'add')).toBe(true);
    expect(result?.hiddenRowCount).toBe(0);
  });

  it('head-truncates and reports hidden rows when changed rows alone exceed maxRows', () => {
    const result = buildDiffRows(makeOutput(25, 8), { maxRows: 20 });
    expect(result?.rows).toHaveLength(20);
    expect(result?.rows.every((r) => r.kind === 'add')).toBe(true);
    expect(result?.hiddenRowCount).toBe(5);
  });

  it('keeps everything in showAll mode', () => {
    const result = buildDiffRows(makeOutput(25, 8), { maxRows: 20, showAll: true });
    expect(result?.rows).toHaveLength(33);
    expect(result?.hiddenRowCount).toBe(0);
  });

  it('caps trailing notes and counts them as hidden', () => {
    const diagnostics = Array.from({ length: 15 }, (_, i) => `ERROR [1:${i}] boom`).join('\n');
    const output = [
      'File edited: src/foo.ts',
      '  (+1 lines, -1 lines)',
      '',
      '--- src/foo.ts',
      '+++ src/foo.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
      'LSP errors detected in this file, please fix:',
      diagnostics,
    ].join('\n');
    const result = buildDiffRows(output);
    const notes = result?.rows.filter((r) => r.kind === 'note') ?? [];
    // Uniform cap over all trailing note rows ("LSP errors detected" line included).
    expect(notes).toHaveLength(10);
    expect(result?.hiddenRowCount).toBe(6);
  });
});
