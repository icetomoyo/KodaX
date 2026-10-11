import { describe, expect, it } from 'vitest';
import { createSessionLineage, type KodaXSessionData } from '@kodax-ai/agent';
import { buildSessionGoalRuntimeBinding } from './session-binding.js';

describe('Host session goal binding', () => {
  it('only exposes goal tools when atomic journal storage is available', async () => {
    const common = { sessionId: 'session', hasPendingUserInput: () => false,
      getPermissionMode: () => undefined, assertWritable() {} };
    expect(await buildSessionGoalRuntimeBinding({ ...common, storage: { load: async () => null } })).toBeUndefined();
    await expect(buildSessionGoalRuntimeBinding({ ...common, storage: {
      load: async () => null, mutateLineage: async () => false,
    } })).rejects.toThrow('Session unavailable while binding goal tools');
  });

  it('refreshes current state and rejects missing reads or failed journal commits', async () => {
    const messages = [{ role: 'user' as const, content: 'Task.' }];
    let data: KodaXSessionData | null = { messages, title: '', gitRoot: '' };
    let found = true;
    const binding = await buildSessionGoalRuntimeBinding({ sessionId: 'session',
      storage: { load: async () => data, mutateLineage: async (_id, mutate) => {
        if (found && data) data = { ...data, lineage: mutate(data.lineage ?? createSessionLineage(data.messages)) };
        return found;
      } }, hasPendingUserInput: () => false, getPermissionMode: () => undefined, assertWritable() {} });
    found = false;
    await expect(binding!.goalContext.createGoal({ objective: 'Verify.' })).rejects.toThrow('Session unavailable while persisting goal state');
    expect(binding!.lifecycleCtx.getGoal()).toBeNull();
    found = true;
    await binding!.goalContext.createGoal({ objective: 'Verify.' });
    expect(await binding!.goalContext.requestBlocked('missing-evidence')).toMatchObject({ ok: false });
    await binding!.refresh!();
    expect(binding!.lifecycleCtx.getGoal()?.blockerTurnCount).toBe(1);
    data = null;
    await expect(binding!.goalContext.readGoal()).rejects.toThrow('Session unavailable while reading goal state');
  });

  it('serializes parallel goal claims so only one active goal is created', async () => {
    const messages = [{ role: 'user' as const, content: 'Task.' }];
    let data: KodaXSessionData = { messages, title: '', gitRoot: '', lineage: createSessionLineage(messages) };
    const binding = await buildSessionGoalRuntimeBinding({ sessionId: 'session',
      storage: { load: async () => data, mutateLineage: async (_id, mutate) => {
        data = { ...data, lineage: mutate(data.lineage!) }; return true;
      } }, hasPendingUserInput: () => false, getPermissionMode: () => 'full-access', assertWritable() {} });
    const results = await Promise.allSettled([
      binding!.goalContext.createGoal({ objective: 'First.' }),
      binding!.goalContext.createGoal({ objective: 'Second.' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });
  it('mutates the latest lineage without replacing intervening transcript or UI state', async () => {
    let data: KodaXSessionData = { messages: [{ role: 'user', content: 'Original task.' }],
      title: 'Original', gitRoot: '', lineage: createSessionLineage([{ role: 'user', content: 'Original task.' }]) };
    const binding = await buildSessionGoalRuntimeBinding({ sessionId: 'session',
      storage: { load: async () => data, mutateLineage: async (_id, mutate) => {
        data = { ...data, lineage: mutate(data.lineage!) }; return true;
      } }, hasPendingUserInput: () => false, getPermissionMode: () => 'full-access', assertWritable() {} });
    data = { ...data, messages: [...data.messages, { role: 'assistant', content: 'Concurrent result.' }],
      uiHistory: [{ type: 'info', text: 'Concurrent notice.' }] };
    await binding!.goalContext.createGoal({ objective: 'Check all requirements.' });
    expect(data.messages.at(-1)?.content).toBe('Concurrent result.');
    expect(data.uiHistory?.[0]).toMatchObject({ text: 'Concurrent notice.' });
    expect(await binding!.goalContext.requestComplete()).toEqual({ ok: true });
    expect((await binding!.goalContext.readGoal())?.status).toBe('complete');
  });

  it('keeps cached state unchanged when a journal commit fails and propagates cancellation', async () => {
    const messages = [{ role: 'user' as const, content: 'Task.' }];
    const data: KodaXSessionData = { messages, title: '', gitRoot: '', lineage: createSessionLineage(messages) };
    let cancelled = false;
    const binding = await buildSessionGoalRuntimeBinding({ sessionId: 'session',
      storage: { load: async () => data, mutateLineage: async (_id, mutate) => {
        mutate(data.lineage!); throw new Error('Journal write failed');
      } }, hasPendingUserInput: () => false, getPermissionMode: () => 'full-access',
      assertWritable() { if (cancelled) throw new Error('Cancelled'); } });
    await expect(binding!.goalContext.createGoal({ objective: 'Verify.' })).rejects.toThrow('Journal write failed');
    expect(binding!.lifecycleCtx.getGoal()).toBeNull();
    cancelled = true;
    await expect(binding!.goalContext.createGoal({ objective: 'Verify.' })).rejects.toThrow('Cancelled');
    expect(binding!.lifecycleCtx.getGoal()).toBeNull();
  });
});
