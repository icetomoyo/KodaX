import { describe, expect, it, vi } from 'vitest';
import type { KodaXSessionData, KodaXSessionMessageEntry } from '../index.js';
import {
  applySessionCompaction,
  createSessionLineage,
  getSessionMessagesFromLineage,
} from './kodax-session-lineage.js';
import {
  COMPACTED_HISTORY_RECOVERY_GUIDANCE,
  COMPACTION_SUMMARY_PREFIX,
} from './compaction/compaction.js';
import { persistCompactedSessionHistory } from './compaction-persistence.js';

describe('persistCompactedSessionHistory', () => {
  it('does not mistake an old retained entry for a committed context replacement', async () => {
    vi.useFakeTimers();
    try {
      const messages = [{ role: 'user' as const, content: 'A' }, { role: 'assistant' as const, content: 'B' }];
      let current: KodaXSessionData = { title: 'retained', gitRoot: '', messages,
        lineage: createSessionLineage(messages) };
      const save = vi.fn(async (_id: string, data: KodaXSessionData) => {
        if (save.mock.calls.length === 1) throw Object.assign(new Error('not committed'), { code: 'EIO' });
        current = data;
      });
      const pending = persistCompactedSessionHistory({ sessionId: 'retained', storage: { load: async () => current, save },
        compactedMessages: messages.slice(0, 1), update: { preCompactionMessages: messages } });
      await vi.runAllTimersAsync();
      await pending;
      expect(save).toHaveBeenCalledTimes(2);
      expect(current.messages).toEqual(messages.slice(0, 1));
    } finally { vi.useRealTimers(); }
  });

  it('retries one exact transaction after transient save failures without duplicating history', async () => {
    vi.useFakeTimers();
    try {
      let current: KodaXSessionData = { title: 'recovery', gitRoot: '', messages: [] };
      const attempts: KodaXSessionData[] = [];
      const save = vi.fn(async (_id: string, data: KodaXSessionData) => {
        attempts.push(structuredClone(data));
        if (attempts.length < 3) throw Object.assign(new Error('temporary I/O failure'), { code: 'EIO' });
        current = structuredClone(data);
      });
      const pending = persistCompactedSessionHistory({
        sessionId: 'recovery', storage: { load: async () => current, save },
        compactedMessages: [{ role: 'user', content: 'checkpoint' }],
        update: { preCompactionMessages: [
          { role: 'user', content: 'Never change the database' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'done', name: 'read', input: { path: 'schema' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'done', content: 'already inspected' }] },
        ], anchor: { summary: 'checkpoint' } },
      });
      const assertion = expect(pending).resolves.toBeDefined();
      await vi.runAllTimersAsync();
      await assertion;
      expect(attempts).toHaveLength(3);
      expect(attempts[1]).toEqual(attempts[0]);
      expect(attempts[2]).toEqual(attempts[0]);
      expect(JSON.stringify(current.lineage)).toContain('Never change the database');
      expect(JSON.stringify(current.lineage)).toContain('already inspected');
    } finally { vi.useRealTimers(); }
  });

  it('retries a transient load but never retries permission failures', async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn().mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
        .mockResolvedValue({ title: 'recovery', gitRoot: '', messages: [] });
      const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
      const save = vi.fn().mockRejectedValue(denied);
      const pending = persistCompactedSessionHistory({ sessionId: 'recovery',
        storage: { load, save }, compactedMessages: [], update: { preCompactionMessages: [] } });
      const assertion = expect(pending).rejects.toBe(denied);
      await vi.runAllTimersAsync();
      await assertion;
      expect(load).toHaveBeenCalledTimes(2);
      expect(save).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('Stop cancels a storage retry and prevents another write', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const save = vi.fn().mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
      const pending = persistCompactedSessionHistory({ sessionId: 'recovery', signal: controller.signal,
        storage: { load: async () => ({ title: 'recovery', gitRoot: '', messages: [] }), save },
        compactedMessages: [], update: { preCompactionMessages: [] } });
      const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(0);
      expect(save).toHaveBeenCalledOnce();
      controller.abort();
      await assertion;
      await vi.runAllTimersAsync();
      expect(save).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('persists active-run exact messages before the compacted replacement', async () => {
    const initial: KodaXSessionData = {
      title: 'durable',
      gitRoot: 'C:/repo',
      messages: [{ role: 'user', content: 'old query' }],
      lineage: createSessionLineage([{ role: 'user', content: 'old query' }]),
    };
    const save = vi.fn<(id: string, data: KodaXSessionData) => Promise<void>>()
      .mockResolvedValue(undefined);
    const lineage = await persistCompactedSessionHistory({
      storage: {
        save,
        load: async () => initial,
      },
      sessionId: 'root-session',
      compactedMessages: [{ role: 'user', content: 'checkpoint' }],
      update: {
        preCompactionMessages: [
          { role: 'user', content: 'old query' },
          { role: 'assistant', content: 'active-run exact detail ZX-4401' },
        ],
        anchor: {
          summary: 'checkpoint',
          entriesRemoved: 2,
          reason: 'automatic_compaction',
        },
      },
    });

    expect(lineage.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({ content: 'active-run exact detail ZX-4401' }),
      }),
    ]));
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[1]).toMatchObject({
      messages: [{ role: 'user', content: 'checkpoint' }],
      lineage,
    });
  });

  it('inherits retained provenance across reload and prior inline attachments', async () => {
    const base = createSessionLineage([{ role: 'assistant', content: 'retained exact tail' }]);
    const source = base.entries[0]!;
    const sourceLineage = {
      ...base,
      entries: [{
        ...source,
        logicalId: 'logical_retained_origin',
        sourceEntryId: 'entry_retained_origin',
      }],
    };
    const sourceMessage = sourceLineage.entries[0];
    if (sourceMessage?.type !== 'message') {
      throw new Error('expected source message');
    }
    const firstCompaction = applySessionCompaction(
      sourceLineage,
      [
        {
          role: 'user',
          content: `${COMPACTION_SUMMARY_PREFIX}first checkpoint${COMPACTED_HISTORY_RECOVERY_GUIDANCE}`,
          _synthetic: true,
          _source: 'compaction-checkpoint',
        },
        sourceMessage.message,
      ],
      { summary: 'first checkpoint' },
      [{
        role: 'user',
        content: '[Post-compact: recent operations]\nread file',
        _synthetic: true,
        _source: 'compaction-context',
      }],
    );
    const firstCompactionClone = firstCompaction.entries
      .filter((entry): entry is KodaXSessionMessageEntry =>
        entry.type === 'message' && entry.message.content === 'retained exact tail')
      .at(-1);
    if (!firstCompactionClone) {
      throw new Error('expected the first-compaction retained clone');
    }
    const persisted: KodaXSessionData = {
      title: 'reloaded provenance',
      gitRoot: 'C:/repo',
      messages: getSessionMessagesFromLineage(firstCompaction),
      lineage: firstCompaction,
    };
    const preCompactionMessages = structuredClone(persisted.messages);
    expect(preCompactionMessages.map((message) => message._source)).toEqual([
      'compaction-checkpoint',
      'compaction-context',
      undefined,
    ]);
    const retainedCopy = preCompactionMessages.at(-1)!;
    const lineage = await persistCompactedSessionHistory({
      storage: {
        save: async () => {},
        load: async () => structuredClone(persisted),
      },
      sessionId: 'reloaded-session',
      compactedMessages: [
        {
          role: 'user',
          content: `${COMPACTION_SUMMARY_PREFIX}second checkpoint${COMPACTED_HISTORY_RECOVERY_GUIDANCE}`,
          _synthetic: true,
          _source: 'compaction-checkpoint',
        },
        retainedCopy,
      ],
      update: {
        preCompactionMessages,
        anchor: { summary: 'second checkpoint' },
      },
    });
    const rematerialized = lineage.entries
      .filter((entry) =>
        entry.type === 'message' && entry.message.content === 'retained exact tail')
      .at(-1);

    expect(rematerialized).toEqual(expect.objectContaining({
      logicalId: 'logical_retained_origin',
      // Direct addressing: the post-reload compaction clone names the
      // reloaded entry's own physical id, not the collapsed archived
      // original's 'entry_retained_origin'.
      sourceEntryId: firstCompactionClone.id,
    }));
    expect(rematerialized?.id).not.toBe(source.id);
    expect(lineage.entries).not.toContainEqual(expect.objectContaining({
      type: 'message',
      message: expect.objectContaining({ _source: 'compaction-context' }),
    }));
  });

  it('rejects a missing session instead of inventing incomplete metadata', async () => {
    await expect(persistCompactedSessionHistory({
      storage: {
        save: async () => {},
        load: async () => null,
      },
      sessionId: 'missing',
      compactedMessages: [],
      update: { preCompactionMessages: [] },
    })).rejects.toThrow(/missing session/i);
  });

  it('creates a first durable snapshot from explicit run metadata and exact history', async () => {
    const save = vi.fn<(id: string, data: KodaXSessionData) => Promise<void>>()
      .mockResolvedValue(undefined);
    await persistCompactedSessionHistory({
      storage: { save, load: async () => null },
      sessionId: 'new-root',
      compactedMessages: [{ role: 'user', content: 'checkpoint' }],
      update: {
        preCompactionMessages: [{ role: 'user', content: 'first-run exact BRAVO-204' }],
      },
      initialSessionData: {
        title: 'First run',
        gitRoot: 'C:/repo',
        scope: 'user',
      },
    });

    expect(save).toHaveBeenCalledWith('new-root', expect.objectContaining({
      title: 'First run',
      gitRoot: 'C:/repo',
      scope: 'user',
      messages: [{ role: 'user', content: 'checkpoint' }],
      lineage: expect.objectContaining({
        entries: expect.arrayContaining([
          expect.objectContaining({
            type: 'message',
            message: expect.objectContaining({ content: 'first-run exact BRAVO-204' }),
          }),
        ]),
      }),
    }));
  });
});
