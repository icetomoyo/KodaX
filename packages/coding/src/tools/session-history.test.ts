import { describe, expect, it, vi } from 'vitest';
import { applySessionCompaction, createSessionLineage, forkSessionLineage, getSessionMessagesFromLineage } from '@kodax-ai/agent';
import type { KodaXToolExecutionContext } from '../types.js';
import {
  activateSessionHistoryTools,
  canActivateSessionHistoryTools,
  createSessionHistoryLoader,
  toolSessionHistoryRead,
  toolSessionHistorySearch,
} from './session-history.js';

function context(): KodaXToolExecutionContext {
  const lineage = applySessionCompaction(
    createSessionLineage([
      { role: 'system', content: 'private host instruction SYS-991' },
      { role: 'user', content: 'remember exact ticket USER-882' },
      { role: 'assistant', content: 'ticket USER-882 was resolved by patch seven' },
    ]),
    [{ role: 'user', content: 'active tail' }],
    { summary: 'ticket resolved' },
  );
  return { backups: new Map(), loadSessionHistory: vi.fn().mockResolvedValue(lineage) };
}

describe('session history tools', () => {
  it('uses entry versions through normal persisted appends and recovers an explicit stale read without another search', async () => {
    const ctx = context();
    let lineage = (await ctx.loadSessionHistory!())!;
    ctx.loadSessionHistory = async () => lineage;
    const search = JSON.parse(await toolSessionHistorySearch({ query: 'USER-882', role: 'user' }, ctx)) as {
      revision: string; hits: { entryId: string; entryRevision: string }[];
    };
    const hit = search.hits[0]!;
    lineage = createSessionLineage([...getSessionMessagesFromLineage(lineage),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'lookup', name: 'session_history_search', input: { query: 'USER-882' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'lookup', content: JSON.stringify(search) }] },
    ], lineage);
    const legacy = JSON.parse(await toolSessionHistoryRead({ entry_id: hit.entryId, revision: search.revision }, ctx)) as {
      status: string; entryRevision: string;
    };
    expect(legacy.status).toBe('stale');
    expect(legacy.entryRevision).toBe(hit.entryRevision);
    expect(JSON.parse(await toolSessionHistoryRead({ entry_id: hit.entryId, revision: hit.entryRevision }, ctx)))
      .toMatchObject({ status: 'ok', content: 'remember exact ticket USER-882', entryRevision: hit.entryRevision });
  });

  it('keeps a readonly child loader bound to its own Session when given parent entry versions', async () => {
    const parent = createSessionLineage([{ role: 'user', content: 'parent evidence CHILD-42' }]);
    const child = forkSessionLineage(parent)!;
    const storage = { save: vi.fn(), load: vi.fn(), loadFullLineage: vi.fn(async (id: string) => id === 'child-session' ? child : parent) };
    const loadSessionHistory = createSessionHistoryLoader({ sessionId: 'child-session', currentAgentId: '/root/readonly',
      sessionScope: 'managed-task-worker', storage });
    const ctx: KodaXToolExecutionContext = { backups: new Map(), loadSessionHistory };
    const parentCtx: KodaXToolExecutionContext = { backups: new Map(), loadSessionHistory: async () => parent };
    const hit = (JSON.parse(await toolSessionHistorySearch({ query: 'CHILD-42', scope: 'all' }, parentCtx)) as {
      hits: { entryId: string; entryRevision: string }[];
    }).hits[0]!;
    const result = JSON.parse(await toolSessionHistoryRead({ entry_id: hit.entryId, revision: hit.entryRevision }, ctx));
    expect(result).toMatchObject({ status: 'not_found' });
    expect(result).not.toHaveProperty('content');
    expect(storage.loadFullLineage.mock.calls).toEqual([['child-session']]);
  });

  it('activates the pair atomically and removes it from unsupported contexts', () => {
    expect(activateSessionHistoryTools(['read'], true)).toEqual([
      'read', 'session_history_search', 'session_history_read',
    ]);
    expect(activateSessionHistoryTools(['read', 'session_history_search'], false)).toEqual(['read']);
    const storage = {
      save: vi.fn(),
      load: vi.fn(),
      loadFullLineage: vi.fn(),
    };
    expect(canActivateSessionHistoryTools({
      activeTools: ['session_history_search', 'session_history_read'],
      sessionId: 'root',
      storage,
    })).toBe(true);
    expect(canActivateSessionHistoryTools({
      activeTools: ['session_history_search', 'session_history_read'],
      sessionId: 'root',
      currentAgentId: 'child-1',
      storage,
    })).toBe(false);
    expect(canActivateSessionHistoryTools({
      activeTools: ['session_history_search', 'session_history_read'],
      sessionId: 'worker-1',
      currentAgentId: 'child-1',
      sessionScope: 'managed-task-worker',
      storage,
    })).toBe(true);
    expect(canActivateSessionHistoryTools({
      activeTools: ['session_history_search'],
      sessionId: 'root',
      storage,
    })).toBe(false);
    expect(canActivateSessionHistoryTools({
      activeTools: ['session_history_search', 'session_history_read'],
      sessionId: 'root',
      storage: { save: vi.fn(), load: vi.fn() },
    })).toBe(false);
  });

  it('searches and reads cited exact evidence while hiding system messages', async () => {
    const ctx = context();
    const search = JSON.parse(await toolSessionHistorySearch({ query: 'USER-882' }, ctx));
    const userHit = search.hits.find((hit: { role?: string }) => hit.role === 'user');
    expect(userHit).toMatchObject({ role: 'user', active: false });
    const read = JSON.parse(await toolSessionHistoryRead({
      entry_id: userHit.entryId,
      revision: search.revision,
    }, ctx));
    expect(read).toMatchObject({ status: 'ok' });
    expect(read.content).toContain('USER-882');

    const system = JSON.parse(await toolSessionHistorySearch({ query: 'SYS-991' }, ctx));
    expect(system.hits).toEqual([]);
  });
});
