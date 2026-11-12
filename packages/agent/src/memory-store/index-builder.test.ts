import { describe, expect, it } from 'vitest';

import { buildIndex, estimateTokens, INDEX_TOKEN_BUDGET } from './index-builder.js';
import type { MemoryNote, NoteStatus } from './record.js';

function note(id: string, over: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id,
    type: 'project',
    scope: 'project',
    description: `description of ${id}`,
    status: 'active',
    used: 0,
    body: '',
    ...over,
  };
}

describe('buildIndex', () => {
  it('is empty when there is nothing to list', () => {
    expect(buildIndex([])).toBe('');
    expect(buildIndex([note('a', { status: 'candidate' })])).toBe('');
  });

  it('lists active and disputed notes and leaves out candidate and archived', () => {
    const statuses: NoteStatus[] = ['active', 'disputed', 'candidate', 'archived'];
    const index = buildIndex(statuses.map((status) => note(status, { status })));
    expect(index).toContain('(active.md)');
    expect(index).toContain('(disputed.md)');
    expect(index).not.toContain('candidate.md');
    expect(index).not.toContain('archived.md');
  });

  it('marks a disputed note so the model verifies before relying on it', () => {
    const index = buildIndex([note('d', { status: 'disputed', description: 'use yarn' })]);
    expect(index).toMatch(/disputed.*use yarn/);
  });

  it('lists a Chinese-titled memory', () => {
    const index = buildIndex([note('测试命令', { description: '运行测试一律使用 just test-fast' })]);
    expect(index).toContain('测试命令.md');
    expect(index).toContain('运行测试一律使用 just test-fast');
  });

  it('is byte-identical for the same notes in any input order', () => {
    const notes = ['b', 'a', 'c'].map((id) => note(id));
    expect(buildIndex(notes)).toBe(buildIndex([...notes].reverse()));
  });

  it('stays under the token budget and demotes the least used notes first', () => {
    const notes = Array.from({ length: 400 }, (_, i) =>
      note(`n${String(i).padStart(3, '0')}`, {
        description: `a reasonably long description for note ${i} about project conventions`,
        used: i === 399 ? 50 : 0,
      }));
    const index = buildIndex(notes);
    expect(estimateTokens(index)).toBeLessThanOrEqual(INDEX_TOKEN_BUDGET);
    expect(index).toContain('(n399.md)');
    expect(index).toMatch(/\d+ more notes? not listed/);
  });

  it('does not mention overflow when everything fits', () => {
    expect(buildIndex([note('a'), note('b')])).not.toMatch(/not listed/);
  });

  it('bounds one very long description', () => {
    const index = buildIndex([note('a', { description: 'x'.repeat(5000) })]);
    expect(index.length).toBeLessThan(600);
  });
});
