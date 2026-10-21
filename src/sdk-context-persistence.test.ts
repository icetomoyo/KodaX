import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { persistCompactedSessionHistory, type KodaXSessionData } from '@kodax-ai/agent';
import { FileSessionStorage } from '@kodax-ai/repl';

it('recognizes a committed history after a lost acknowledgement without overwriting newer metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-context-commit-'));
  try {
    const storage = new FileSessionStorage({ sessionsDir: root });
    await storage.save('pending', { title: 'original', gitRoot: root,
      messages: [{ role: 'user', content: 'Preserve my constraints' }] });
    const before = await storage.load('pending');
    if (!before) throw new Error('Missing test session');
    const save = vi.fn(async (id: string, data: KodaXSessionData) => {
      await storage.save(id, data);
      if (save.mock.calls.length === 1) {
        const committed = await storage.load(id);
        if (!committed) throw new Error('Missing committed session');
        await storage.save(id, { ...committed, title: 'newer user title' });
        throw Object.assign(new Error('acknowledgement lost'), { code: 'EIO' });
      }
    });
    const lineage = await persistCompactedSessionHistory({ sessionId: 'pending',
      storage: { load: id => storage.load(id), save },
      compactedMessages: [{ role: 'user', content: 'checkpoint' }],
      update: { preCompactionMessages: before.messages, anchor: { summary: 'checkpoint',
        tokensBefore: 20, tokensAfter: 2, entriesRemoved: 1, reason: 'capacity_recovery' } } });
    const reloaded = await storage.load('pending');
    expect(reloaded?.title).toBe('newer user title');
    expect(save).toHaveBeenCalledOnce();
    expect(reloaded?.lineage?.activeEntryId).toBe(lineage.activeEntryId);
    expect(reloaded?.lineage?.entries.filter(entry => entry.type === 'compaction')).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
});
