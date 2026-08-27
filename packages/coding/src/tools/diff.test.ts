import { describe, expect, it } from 'vitest';
import { generateDiff } from './diff.js';

/** Diff body ops only: drop the ---/+++/@@ framing lines. */
function bodyOps(diff: string): string[] {
  return diff
    .split('\n')
    .filter((line) => !line.startsWith('--- ') && !line.startsWith('+++ ') && !line.startsWith('@@ '));
}

describe('generateDiff', () => {
  it('groups a replacement as one remove run then one add run (no pairwise interleave)', () => {
    const diff = generateDiff('a\nb\nc\nd\ne', 'a\nx\ny\nz\nd\ne', 'f.txt');
    expect(bodyOps(diff)).toEqual([
      '  a',
      '- b',
      '- c',
      '+ x',
      '+ y',
      '+ z',
      '  d',
      '  e',
    ]);
  });

  it('keeps an identical line as context even when an insertion shifts its position', () => {
    const diff = generateDiff('# T\n\nA\nB\nkeep', '# T\n\nA2\nkeep', 'f.txt');
    expect(bodyOps(diff)).toEqual([
      '  # T',
      '  ',
      '- A',
      '- B',
      '+ A2',
      '  keep',
    ]);
  });

  it('renders a pure append as one add row', () => {
    const diff = generateDiff('a', 'a\nb', 'f.txt');
    expect(bodyOps(diff)).toEqual(['  a', '+ b']);
  });

  it('renders a pure deletion as one remove row', () => {
    const diff = generateDiff('a\nb', 'a', 'f.txt');
    expect(bodyOps(diff)).toEqual(['  a', '- b']);
  });

  it('returns an empty string when contents are identical', () => {
    expect(generateDiff('a\nb', 'a\nb', 'f.txt')).toBe('');
  });

  it('splits distant change regions into separate hunks with bounded context', () => {
    const oldText = ['a', 'X', 'b', 'c', 'd', 'e', 'f', 'Y', 'g'].join('\n');
    const newText = ['a', 'Q', 'b', 'c', 'd', 'e', 'f', 'R', 'g'].join('\n');
    const diff = generateDiff(oldText, newText, 'f.txt');
    expect(diff.split('\n').filter((line) => line.startsWith('@@'))).toEqual([
      '@@ -1,5 +1,5 @@',
      '@@ -6,4 +6,4 @@',
    ]);
    expect(bodyOps(diff)).toEqual([
      '  a',
      '- X',
      '+ Q',
      '  b',
      '  c',
      '  d',
      '  e',
      '  f',
      '- Y',
      '+ R',
      '  g',
    ]);
  });

  it('falls back to block replacement (all removes then all adds) above the LCS budget', () => {
    const oldText = Array.from({ length: 2000 }, (_, i) => `o${i}`).join('\n');
    const newText = Array.from({ length: 2000 }, (_, i) => `n${i}`).join('\n');
    const ops = bodyOps(generateDiff(oldText, newText, 'f.txt'));
    expect(ops.length).toBe(4000);
    expect(ops.slice(0, 2000).every((line) => line.startsWith('- '))).toBe(true);
    expect(ops.slice(2000).every((line) => line.startsWith('+ '))).toBe(true);
  });
});
