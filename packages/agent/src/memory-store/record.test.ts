import { describe, expect, it } from 'vitest';

import { parseNote, serializeNote, type MemoryNote } from './record.js';

const full: MemoryNote = {
  id: 'test-command',
  type: 'feedback',
  scope: 'project',
  description: 'Run tests with `make check-fast`, never bare `npm test`',
  why: 'user said so in session s_1: "never bare npm test"',
  check: 'grep check-fast Makefile',
  status: 'active',
  used: 3,
  lastUsedAt: '2026-11-10T08:00:00.000Z',
  body: 'The integration setup is skipped by bare `npm test`.\n',
};

describe('memory note record', () => {
  it('round-trips every field', () => {
    expect(parseNote('test-command', serializeNote(full), 'project')).toEqual(full);
  });

  it('round-trips quotes, colons and Chinese text', () => {
    const note: MemoryNote = {
      ...full,
      description: '数据库迁移必须通过 "bun run migrate" 执行: 不要手写 SQL',
      why: "it's \"quoted\": yes",
    };
    expect(parseNote(note.id, serializeNote(note), 'project')).toEqual(note);
  });

  it('keeps values on one line', () => {
    const raw = serializeNote({ ...full, description: 'line one\nline two' });
    expect(parseNote('x', raw, 'project').description).toBe('line one line two');
  });

  it('treats a hand-edited file with only a description as an active note', () => {
    const note = parseNote('hand', '---\ndescription: use pnpm here\n---\nbody\n', 'user');
    expect(note).toMatchObject({
      id: 'hand',
      status: 'active',
      scope: 'user',
      type: 'project',
      description: 'use pnpm here',
      used: 0,
    });
    expect(note.lastUsedAt).toBeUndefined();
  });

  it('falls back to the first body line when there is no frontmatter', () => {
    const note = parseNote('plain', '\n# Heading\nuse pnpm\n', 'project');
    expect(note.description).toBe('# Heading');
    expect(note.status).toBe('active');
  });

  it('never activates a note whose status is unrecognised', () => {
    const note = parseNote('x', '---\ndescription: d\nstatus: trusted\n---\n', 'project');
    expect(note.status).toBe('candidate');
  });

  it('ignores a non-numeric used count', () => {
    expect(parseNote('x', '---\ndescription: d\nused: many\n---\n', 'project').used).toBe(0);
  });
});
