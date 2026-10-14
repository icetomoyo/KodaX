import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { FileSessionStorage } from './storage.js';

it('keeps draft edits and history boundaries isolated until meaningful input is saved', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-storage-draft-'));
  const sessionsDir = path.join(root, 'sessions');
  const owner = new FileSessionStorage({ sessionsDir });
  const reader = new FileSessionStorage({ sessionsDir });
  try {
    await owner.createDraft('draft', { title: '', messages: [] });
    await expect(owner.createDraft('draft', { title: 'Overwrite', messages: [] }))
      .rejects.toMatchObject({ code: 'conflict' });
    const before = await owner.readFullSnapshot('draft');
    expect(before?.sourceRevisionState.files).toEqual([]);
    before!.data.title = 'Detached mutation';
    expect((await owner.load('draft'))?.title).toBe('');
    await owner.save('draft', { title: 'Draft label', messages: [{ role: 'user', content: '   ' }] });
    const edited = await owner.readFullSnapshot('draft');
    expect(edited?.data.title).toBe('Draft label');
    expect(edited?.sourceRevision).not.toBe(before?.sourceRevision);
    expect(edited?.boundaryRevision).toBe(edited?.sourceRevision);
    expect(await owner.loadFullLineage('draft')).not.toBeNull();
    expect(await owner.list()).toEqual([]);
    expect(await reader.load('draft')).toBeNull();
    await owner.save('draft', { title: 'Draft label', messages: [
      { role: 'user', content: 'Accepted input', inputId: 'first-input' },
    ] });
    expect(owner.isDraft('draft')).toBe(false);
    expect((await reader.load('draft'))?.messages).toContainEqual(
      expect.objectContaining({ inputId: 'first-input', content: 'Accepted input' }),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});
