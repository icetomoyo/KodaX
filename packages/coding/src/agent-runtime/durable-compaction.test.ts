import { describe, expect, it, vi } from 'vitest';
import {
  createSessionLineage,
  getSessionMessagesFromLineage,
  type KodaXSessionData,
} from '@kodax-ai/agent';
import { withDurableCompactionPersistence } from './durable-compaction.js';
import {
  createLiveTurnScope,
  withLiveTurnAttribution,
} from './event-emitter.js';

describe('withDurableCompactionPersistence', () => {
  it('binds recovery to canonical lineage metadata retained by file storage after a tool receipt', async () => {
    const messages = [{ role: 'user' as const, content: 'Never repeat the append.', inputId: 'original', timestamp: '2026-10-21T00:00:00Z' },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'append', name: 'bash', input: { command: 'append' } }], outputId: 'out' },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'append', content: 'done' }] }];
    let saved: KodaXSessionData = { title: 'root', gitRoot: '', messages, lineage: createSessionLineage(messages) };
    const blocked = vi.fn(async () => undefined);
    const events = withDurableCompactionPersistence({ sessionId: 'root', events: { onContextCapacityBlocked: blocked },
      storage: { load: async () => saved, save: async (_id, value) => {
        saved = { ...value, messages: getSessionMessagesFromLineage(value.lineage!) };
      } } });
    const runnerMessages = messages.map(({ role, content }) => ({ role, content }));
    await events.onCompactedMessages!(runnerMessages, { preCompactionMessages: runnerMessages });
    await events.onContextCapacityBlocked!({}, undefined);
    expect(blocked).toHaveBeenCalledOnce();
    expect(saved.messages).toEqual(messages);
    saved.messages = [...saved.messages, { role: 'user', content: 'New authoritative constraint' }];
    await expect(events.onContextCapacityBlocked!({}, undefined)).rejects.toThrow(/no longer matches/);
  });
  it('forwards a child boundary through its parent without comparing it to root history', async () => {
    const blocked = vi.fn(async () => undefined);
    const load = vi.fn(async () => null);
    const events = withDurableCompactionPersistence({ sessionId: 'root', events: { onContextCapacityBlocked: blocked },
      storage: { load, save: async () => {} } });
    const state = { checkpoint: { version: 1 as const, sessionId: 'worker', activeEntryId: null, messagesDigest: 'a'.repeat(64) } };
    const meta = { childAgentId: '/root/worker', turnId: 'original' };
    await events.onContextCapacityBlocked!(state, undefined, meta);
    expect(blocked).toHaveBeenCalledWith(state, undefined, meta);
    expect(load).not.toHaveBeenCalled();
  });
  it('binds a recovery checkpoint to the committed child transcript and active lineage', async () => {
    const messages = [{ role: 'user' as const, content: 'Never run migration twice.', turnId: 'child-turn' },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'once', name: 'edit', input: { path: 'a' } }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'once', content: 'done' }] }];
    let saved: KodaXSessionData = { title: 'child', gitRoot: '', messages: [] };
    const blocked = vi.fn(async () => undefined);
    const events = withDurableCompactionPersistence({ sessionId: 'worker-child', currentAgentId: '/root/child',
      sessionScope: 'managed-task-worker', events: { onContextCapacityBlocked: blocked },
      storage: { load: async () => saved, save: async (_id, value) => { saved = value; } } });
    const { waitForContextRecovery } = await import('../context-recovery-wait.js');
    const { ContextCapacityError } = await import('@kodax-ai/agent');
    await waitForContextRecovery(new ContextCapacityError({ contextWindow: 4096, currentTokens: 6000 }), messages, events,
      undefined, undefined, { remainingIterations: 1, remainingContinuationIterations: 0 });
    expect(blocked).toHaveBeenCalledWith(expect.objectContaining({ checkpoint: expect.objectContaining({
      version: 1, sessionId: 'worker-child', turnId: 'child-turn', activeEntryId: saved.lineage?.activeEntryId,
      messagesDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      remainingIterations: 1, remainingContinuationIterations: 0,
    }) }), undefined, undefined);
    expect(saved.messages).toEqual(messages);
  });
  it('keeps the pending commit private during I/O recovery and honors Stop', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const observer = vi.fn();
      const save = vi.fn().mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY' }));
      const events = withDurableCompactionPersistence({ sessionId: 'recovering',
        signal: controller.signal, events: { onCompactedMessages: observer },
        storage: { load: async () => ({ title: 'pending', gitRoot: '', messages: [] }), save } });
      const outcome = events.onCompactedMessages?.([{ role: 'user', content: 'summary' }],
        { preCompactionMessages: [{ role: 'user', content: 'Keep all constraints' }] });
      const assertion = expect(outcome).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(save).toHaveBeenCalledTimes(2);
      expect(observer).not.toHaveBeenCalled();
      controller.abort();
      await vi.runAllTimersAsync();
      await assertion;
      expect(save).toHaveBeenCalledTimes(2);
      expect(observer).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('publishes the root compaction callback only after exact storage succeeds', async () => {
    const initial: KodaXSessionData = {
      title: 'root',
      gitRoot: 'C:/repo',
      messages: [{ role: 'user', content: 'old' }],
      lineage: createSessionLineage([{ role: 'user', content: 'old' }]),
    };
    const order: string[] = [];
    const events = withDurableCompactionPersistence({
      events: {
        onCompactedMessages: () => {
          order.push('event');
        },
      },
      storage: {
        load: async () => initial,
        save: async () => {
          order.push('save');
        },
      },
      sessionId: 'root',
    });

    await events.onCompactedMessages?.(
      [{ role: 'user', content: 'checkpoint' }],
      {
        preCompactionMessages: [
          { role: 'user', content: 'old' },
          { role: 'assistant', content: 'exact active-run detail' },
        ],
      },
    );
    expect(order).toEqual(['save', 'event']);
  });

  it('does not roll back canonical revision when a post-commit observer fails', async () => {
    const initial: KodaXSessionData = {
      title: 'root',
      gitRoot: 'C:/repo',
      messages: [{ role: 'user', content: 'old' }],
      lineage: createSessionLineage([{ role: 'user', content: 'old' }]),
    };
    const save = vi.fn(async () => undefined);
    const scope = createLiveTurnScope({ sessionId: 'root-post-commit-observer' });
    const durableEvents = withDurableCompactionPersistence({
      events: {
        onCompactedMessages: async () => {
          throw new Error('observer unavailable');
        },
      },
      storage: { load: async () => initial, save },
      sessionId: 'root-post-commit-observer',
    });
    const events = withLiveTurnAttribution(durableEvents, scope);

    await expect(events.onCompactedMessages?.(
      [{ role: 'user', content: 'checkpoint' }],
      { preCompactionMessages: [{ role: 'user', content: 'old' }] },
    )).resolves.toBeUndefined();

    expect(save).toHaveBeenCalledOnce();
    expect(scope.nextMeta().contextRevision).toBe(1);
  });

  it('does not persist Runner-owned leading System messages', async () => {
    const saved: KodaXSessionData[] = [];
    const initial: KodaXSessionData = {
      title: 'root',
      gitRoot: 'C:/repo',
      messages: [{ role: 'user', content: 'old' }],
      lineage: createSessionLineage([{ role: 'user', content: 'old' }]),
    };
    const events = withDurableCompactionPersistence({
      events: {},
      storage: {
        load: async () => initial,
        save: async (_id, data) => {
          saved.push(data);
        },
      },
      sessionId: 'root',
    });

    await events.onCompactedMessages?.(
      [
        { role: 'system', content: 'stable worker instructions' },
        {
          role: 'user',
          content: '[对话历史摘要]\n\ncheckpoint',
          _synthetic: true,
          _source: 'compaction-checkpoint',
        },
      ],
      {
        preCompactionMessages: [
          { role: 'system', content: 'stable worker instructions' },
          { role: 'user', content: 'old' },
        ],
      },
    );

    expect(saved[0]?.messages).toEqual([expect.objectContaining({
      role: 'user',
      _source: 'compaction-checkpoint',
    })]);
    expect(getSessionMessagesFromLineage(saved[0]!.lineage!))
      .not.toContainEqual(expect.objectContaining({ role: 'system' }));
  });

  it('leaves host-owned and child persistence untouched', async () => {
    const save = vi.fn();
    const hostEvents = { onCompactedMessages: vi.fn() };
    expect(withDurableCompactionPersistence({
      events: hostEvents,
      storage: { load: async () => null, save },
      sessionId: 'root',
      persistedByHost: true,
    })).toBe(hostEvents);
    const childEvents = { onCompactedMessages: vi.fn() };
    expect(withDurableCompactionPersistence({
      events: childEvents,
      storage: { load: async () => null, save },
      sessionId: 'root',
      currentAgentId: 'child',
    })).toBe(childEvents);
    expect(save).not.toHaveBeenCalled();
  });

  it('persists child compaction only when the child owns an isolated worker session', async () => {
    const initial: KodaXSessionData = {
      title: 'child',
      gitRoot: 'C:/repo',
      scope: 'managed-task-worker',
      messages: [{ role: 'user', content: 'old child detail' }],
      lineage: createSessionLineage([{ role: 'user', content: 'old child detail' }]),
    };
    const save = vi.fn(async () => undefined);
    const events = withDurableCompactionPersistence({
      events: {},
      storage: { load: async () => initial, save },
      sessionId: 'worker-session',
      sessionScope: 'managed-task-worker',
      currentAgentId: 'child-1',
    });

    await events.onCompactedMessages?.(
      [{ role: 'user', content: 'child checkpoint' }],
      { preCompactionMessages: [{ role: 'user', content: 'old child detail' }] },
      { contextKind: 'child' },
    );

    expect(save).toHaveBeenCalledOnce();
  });

  it('does not persist an explicitly child-attributed compaction through the root session', async () => {
    const save = vi.fn();
    const original = vi.fn();
    const events = withDurableCompactionPersistence({
      events: { onCompactedMessages: original },
      storage: { load: async () => null, save },
      sessionId: 'root',
    });

    await events.onCompactedMessages?.(
      [{ role: 'user', content: 'child checkpoint' }],
      { preCompactionMessages: [{ role: 'user', content: 'child detail' }] },
      { contextKind: 'child' },
    );

    expect(save).not.toHaveBeenCalled();
    expect(original).toHaveBeenCalledOnce();
  });
});
