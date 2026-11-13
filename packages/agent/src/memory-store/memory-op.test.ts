import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyMemoryOperation, type MemoryOpInput } from './memory-op.js';
import { createNoteStore, type NoteStore } from './store.js';

let dirs: string[];
let project: NoteStore;
let user: NoteStore;

beforeEach(async () => {
  dirs = [
    await fs.mkdtemp(path.join(os.tmpdir(), 'op-project-')),
    await fs.mkdtemp(path.join(os.tmpdir(), 'op-user-')),
  ];
  project = createNoteStore(dirs[0]!, 'project');
  user = createNoteStore(dirs[1]!, 'user');
});
afterEach(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const MESSAGE = 'Please remember: always run  make check-fast,\nnever bare npm test. Thanks!';

function run(input: MemoryOpInput, userMessage = MESSAGE) {
  return applyMemoryOperation({ stores: { project, user }, userMessage }, input);
}

const write: MemoryOpInput = {
  operation: 'write',
  id: 'tests',
  type: 'feedback',
  description: 'Run tests with make check-fast',
  body: 'Bare npm test skips integration setup.',
};

describe('applyMemoryOperation', () => {
  describe('write', () => {
    it('stores an active note when the quote is in the current user message', async () => {
      const result = await run({ ...write, userQuote: 'always run make check-fast, never bare npm test' });
      expect(result.ok).toBe(true);
      const [note] = await project.list();
      expect(note).toMatchObject({ id: 'tests', status: 'active' });
      expect(note?.why).toContain('make check-fast');
    });

    it('stores a candidate, hidden from the index, when there is no quote', async () => {
      const result = await run({ ...write, why: 'seen in session s_1: tool output showed the failure' });
      expect(result.ok).toBe(true);
      expect((await project.list())[0]?.status).toBe('candidate');
      await expect(fs.stat(path.join(dirs[0]!, 'MEMORY.md'))).rejects.toThrow();
    });

    it('tells the model how to confirm a candidate and records who established the note', async () => {
      const candidate = await applyMemoryOperation({ stores: { project, user }, userMessage: MESSAGE, sessionId: 's9' }, { ...write, why: 'seen in tool output' });
      expect(candidate.message).toContain('call "edit" on this id');
      expect((await project.list())[0]).toMatchObject({ source: 'inferred', session: 's9' });
    });

    it('requires a why for a candidate so a later session can corroborate it', async () => {
      const result = await run(write);
      expect(result).toMatchObject({ ok: false });
      expect(await project.list()).toEqual([]);
    });

    it('rejects a quote that is not in the current user message and writes nothing', async () => {
      const result = await run({ ...write, userQuote: 'the user said to use yarn' });
      expect(result).toMatchObject({ ok: false });
      expect(await project.list()).toEqual([]);
    });

    it('rejects a trivially short quote', async () => {
      expect(await run({ ...write, userQuote: 'a' })).toMatchObject({ ok: false });
      expect(await run({ ...write, userQuote: 'yes' }, 'yes')).toMatchObject({ ok: false });
      expect(await run({ ...write, userQuote: '记住这个' }, '记住这个')).toMatchObject({ ok: true });
    });

    it('routes by scope', async () => {
      await run({ ...write, scope: 'user', userQuote: 'never bare npm test' });
      expect(await project.list()).toEqual([]);
      expect((await user.list())[0]?.scope).toBe('user');
    });

    it('rejects a secret and does not echo it', async () => {
      const secret = 'sk-live-9f8e7d6c5b4a39281716aabbccdd';
      const result = await run(
        { ...write, body: `key ${secret}`, userQuote: `use key ${secret}` },
        `use key ${secret}`,
      );
      expect(result.ok).toBe(false);
      expect(result.message).not.toContain('9f8e7d6c');
      expect(await project.list()).toEqual([]);
    });

    it('tells the model to use edit when the id exists', async () => {
      await run({ ...write, userQuote: 'never bare npm test' });
      const second = await run({ ...write, userQuote: 'never bare npm test' });
      expect(second.ok).toBe(false);
      expect(second.message).toMatch(/edit/);
    });
  });

  describe('edit and delete', () => {
    beforeEach(async () => {
      await run({ ...write, userQuote: 'never bare npm test' });
    });

    it('edits with a quote', async () => {
      const result = await run({ operation: 'edit', id: 'tests', description: 'Run tests with just test-fast', userQuote: 'never bare npm test' });
      expect(result.ok).toBe(true);
      expect((await project.list())[0]?.description).toBe('Run tests with just test-fast');
    });

    it('refuses to edit or delete without a quote', async () => {
      expect(await run({ operation: 'edit', id: 'tests', description: 'x' })).toMatchObject({ ok: false });
      expect(await run({ operation: 'delete', id: 'tests' })).toMatchObject({ ok: false });
      expect((await project.list())[0]?.description).toBe('Run tests with make check-fast');
    });

    it('deletes with a quote', async () => {
      expect((await run({ operation: 'delete', id: 'tests', userQuote: 'never bare npm test' })).ok).toBe(true);
      expect(await project.list()).toEqual([]);
    });

    it('finds the note in the user scope too', async () => {
      await run({ ...write, id: 'mine', scope: 'user', userQuote: 'never bare npm test' });
      expect((await run({ operation: 'delete', id: 'mine', scope: 'user', userQuote: 'never bare npm test' })).ok).toBe(true);
    });

    it('promotes a candidate to active when the user authorizes the edit', async () => {
      await run({ ...write, id: 'cand', why: 'inferred from session s_2' });
      expect((await project.list()).find((n) => n.id === 'cand')?.status).toBe('candidate');
      await run({ operation: 'edit', id: 'cand', userQuote: 'never bare npm test' });
      expect((await project.list()).find((n) => n.id === 'cand')?.status).toBe('active');
    });

    it('reports a missing id', async () => {
      expect(await run({ operation: 'delete', id: 'nope', userQuote: 'never bare npm test' })).toMatchObject({ ok: false });
    });
  });

  it('rejects an unknown operation', async () => {
    expect(await run({ operation: 'merge' } as never)).toMatchObject({ ok: false });
  });
});
