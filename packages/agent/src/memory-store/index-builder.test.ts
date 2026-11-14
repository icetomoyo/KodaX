import { describe, expect, it } from 'vitest';

import { buildIndex, buildOverflowIndex, estimateTokens, INDEX_TOKEN_BUDGET, OVERFLOW_FILE } from './index-builder.js';
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
    expect(buildIndex([], 'project')).toBe('');
    expect(buildIndex([note('a', { status: 'candidate' })], 'project')).toBe('');
  });

  it('lists active and disputed notes and leaves out candidate and archived', () => {
    const statuses: NoteStatus[] = ['active', 'disputed', 'candidate', 'archived'];
    const index = buildIndex(statuses.map((status) => note(status, { status })), 'project');
    expect(index).toContain('(active.md)');
    expect(index).toContain('(disputed.md)');
    expect(index).not.toContain('candidate.md');
    expect(index).not.toContain('archived.md');
  });

  it('marks a disputed note so the model verifies before relying on it', () => {
    const index = buildIndex([note('d', { status: 'disputed', description: 'use yarn' })], 'project');
    expect(index).toMatch(/disputed.*use yarn/);
  });

  it('lists a Chinese-titled memory', () => {
    const index = buildIndex([note('测试命令', { description: '运行测试一律使用 just test-fast' })], 'project');
    expect(index).toContain('测试命令.md');
    expect(index).toContain('运行测试一律使用 just test-fast');
  });

  it('is byte-identical for the same notes in any input order', () => {
    const notes = ['b', 'a', 'c'].map((id) => note(id));
    expect(buildIndex(notes, 'project')).toBe(buildIndex([...notes].reverse(), 'project'));
  });

  it('stays under the token budget and demotes the least used notes first', () => {
    const notes = Array.from({ length: 400 }, (_, i) =>
      note(`n${String(i).padStart(3, '0')}`, {
        description: `a reasonably long description for note ${i} about project conventions`,
        used: i === 399 ? 50 : 0,
      }));
    const index = buildIndex(notes, 'project');
    expect(estimateTokens(index)).toBeLessThanOrEqual(INDEX_TOKEN_BUDGET.project);
    expect(index).toContain('(n399.md)');
    expect(index).toContain(`are indexed in [${OVERFLOW_FILE}]`);
    const overflow = buildOverflowIndex(notes, 'project');
    expect(overflow).toContain('(n398.md)');
    expect(overflow).not.toContain('(n399.md)');
    const lines = (text: string): string[] => text.split('\n').filter((item) => item.startsWith('- ['));
    expect(lines(index).length + lines(overflow).length).toBe(400);
  });

  it('gives the user index a smaller budget than the project index', () => {
    const notes = Array.from({ length: 100 }, (_, i) => note(`n${String(i).padStart(3, '0')}`, { description: `a preference about tone and formatting number ${i}` }));
    const listed = (text: string): number => text.split('\n').filter((item) => item.startsWith('- [n')).length;
    const user = buildIndex(notes, 'user');
    expect(estimateTokens(user)).toBeLessThanOrEqual(INDEX_TOKEN_BUDGET.user);
    expect(listed(user)).toBeLessThan(listed(buildIndex(notes, 'project')));
    expect(listed(user) + listed(buildOverflowIndex(notes, 'user'))).toBe(100);
  });

  it('does not mention overflow when everything fits', () => {
    expect(buildIndex([note('a'), note('b')], 'project')).not.toContain(OVERFLOW_FILE);
    expect(buildOverflowIndex([note('a'), note('b')], 'project')).toBe('');
  });

  it('bounds one very long description', () => {
    const index = buildIndex([note('a', { description: 'x'.repeat(5000) })], 'project');
    expect(index.length).toBeLessThan(600);
  });
});
