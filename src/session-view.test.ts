import { expect, it, vi } from 'vitest';
import { createWorkflowProcessTracker } from '@kodax-ai/agent';

it('retains inline workflow process facts and a readable saved child digest', async () => {
  const owner = new SessionViewOwner(async () => ({ session: { id: 'session', title: 'Workflow' },
    settings: {}, items: [], queue: [], interactions: [], runs: [] }), async () => undefined);
  const views: ClientSessionView[] = [];
  const observation = await owner.observe('session', view => views.push(view));
  try {
    const events = owner.events('session', 'parent');
    const snapshot = createWorkflowProcessTracker({ runId: 'workflow', workflowName: 'review' }).getSnapshot();
    events.onWorkflowProcessEvent?.({ type: 'workflow_updated', snapshot });
    events.onWorkflowAgentDigest?.({ runId: 'workflow', event: { type: 'agent_completed', seq: 1,
      data: { name: 'reviewer', status: 'completed', summary: 'Verified the complete source.', summaryKind: 'digest' } } });
    await expect.poll(() => views.at(-1)?.activity?.workflow?.runId).toBe('workflow');
    await expect.poll(() => views.at(-1)?.items.some(item => item.text.includes('Verified the complete source.'))).toBe(true);
  } finally { observation.close(); await owner.close(); }
});
import type { KodaXSessionData } from '@kodax-ai/agent';
import { runWithProviderCredential } from '@kodax-ai/llm';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { SessionViewOwner, restoreSessionViewItems, persistSessionViewItems, mergeSessionViewItems } from './session-view.js';

it('invalidates embedded observations when the Host releases the session', async () => {
  const owner = new SessionViewOwner(async () => ({
    session: { id: 'session', title: 'Observe' }, settings: {}, items: [], queue: [], interactions: [], runs: [],
  }), async () => undefined);
  const statuses: string[] = [];
  const observation = await owner.observe('session', () => undefined, {
    onStatus: (status) => statuses.push(status.state === 'closed' ? status.reason : status.state),
  });
  owner.release('session');
  observation.close();
  expect(statuses).toEqual(['live', 'unavailable']);
  await owner.close();
});

it('closes observations after all pending checkpoints settle even when a checkpoint fails', async () => {
  let rejectFirst: ((error: Error) => void) | undefined;
  let finishSecond: (() => void) | undefined;
  const firstSave = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
  const secondSave = new Promise<void>(resolve => { finishSecond = resolve; });
  const owner = new SessionViewOwner(async sessionId => ({
    session: { id: sessionId, title: 'Closing' }, settings: {}, items: [], queue: [], interactions: [], runs: [],
  }), async sessionId => sessionId === 'first' ? firstSave : secondSave);
  const statuses: string[] = [];
  for (const sessionId of ['first', 'second']) {
    await owner.observe(sessionId, () => undefined, { onStatus: status => statuses.push(`${sessionId}:${status.state}`) });
    owner.events(sessionId, 'run');
    owner.checkpoint(sessionId);
  }
  const failed = new Error('Checkpoint failed');
  const closing = owner.close();
  const settled = closing.catch(error => error);
  rejectFirst?.(failed);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(statuses).toEqual(['first:live', 'second:live']);
  finishSecond?.();
  expect(await settled).toBe(failed);
  expect(statuses).toEqual(['first:live', 'second:live', 'first:closed', 'second:closed']);
  await owner.close();
});

it('refreshes canonical history after an interrupted history read recovers', async () => {
  let failNextRead = false;
  let text = 'Before';
  const owner = new SessionViewOwner(async (_sessionId, includeHistory) => {
    if (failNextRead) { failNextRead = false; throw new Error('Temporary read failure'); }
    return { session: { id: 'session', title: 'Recovery' }, settings: {}, queue: [], interactions: [], runs: [],
      items: includeHistory ? [{ id: 'item', type: 'assistant' as const, text }] : [] };
  }, async () => undefined);
  const views: ClientSessionView[] = [];
  const statuses: string[] = [];
  const observation = await owner.observe('session', view => views.push(view), {
    onStatus: status => statuses.push(status.state),
  });
  try {
    text = 'After';
    failNextRead = true;
    owner.changed('session', true);
    await expect.poll(() => statuses.at(-1)).toBe('interrupted');
    owner.changed('session');
    await expect.poll(() => statuses.at(-1)).toBe('live');
    expect(views.at(-1)?.items[0]?.text).toBe('After');
  } finally { observation.close(); await owner.close(); }
});

it('does not pair one worker budget with another worker compaction count', async () => {
  const owner = new SessionViewOwner(async () => ({
    session: { id: 'session', title: 'Budget' }, settings: {}, items: [], queue: [], interactions: [], runs: [],
  }), async () => undefined);
  const views: ClientSessionView[] = [];
  const events = owner.events('session', 'run');
  const observation = await owner.observe('session', view => views.push(view));
  try {
    events.onContextBudgetSnapshot?.({
      contextId: 'worker-one', contextKind: 'child', provider: 'test', model: 'small',
      contextWindow: 32000, profile: 'off', smallWindow: true, pressure: 'low',
      usedTokens: 1900, availableTokens: 30100, usedRatio: 0.06, toolSchemaRatio: 0,
      recommendations: [], createdAt: '2026-09-12T00:00:00.000Z',
      tokenBreakdown: { systemPrompt: 0, toolSchemas: 0, skillCatalog: 0, mcpCatalog: 0,
        transcript: 900, pendingInput: 0, recentToolResults: 0, reservedResponse: 1000, total: 1900 },
      compactionBudget: { triggerPercent: 80, triggerTokens: 24000, physicalCapacityTokens: 30000,
        reservedResponseTokens: 1000, reservedMemoryTokens: 0 },
    });
    await expect.poll(() => views.at(-1)?.activity?.contextBudget?.contextId).toBe('worker-one');
    events.onCompactStats?.({ tokensBefore: 6000, tokensAfter: 1200, contextKind: 'child', contextId: 'worker-two' });
    await expect.poll(() => views.at(-1)?.activity?.context?.tokenCount).toBe(1200);
    expect(views.at(-1)?.activity?.contextBudget).toBeUndefined();
  } finally { observation.close(); await owner.close(); }
});

it('projects structured tool failure facts and preserves them when the session reopens', async () => {
  const data: KodaXSessionData = { title: 'Tools', gitRoot: '', messages: [] };
  const owner = new SessionViewOwner(async () => ({
    session: { id: 'session', title: data.title }, settings: {}, queue: [], interactions: [], runs: [], items: [],
  }), async (_sessionId, _runIds, items) => { data.uiHistory = persistSessionViewItems(items); });
  try {
    const events = owner.events('session', 'run');
    events.onToolUseStart?.({ id: 'failed', name: 'read', input: {} });
    events.onToolResult?.({ id: 'failed', name: 'read', content: 'Permission denied',
      toolResult: { type: 'tool_result', tool_use_id: 'failed', content: 'Permission denied', is_error: true } });
    events.onToolResult?.({ id: 'success', name: 'read', content: '[Error] is a literal example',
      toolResult: { type: 'tool_result', tool_use_id: 'success', content: '[Error] is a literal example', is_error: false } });
    const views: ClientSessionView[] = [];
    const observation = await owner.observe('session', view => views.push(view));
    expect(views.at(-1)?.items[0]).toMatchObject({ text: 'Permission denied', tool: { status: 'error' } });
    expect(views.at(-1)?.items[1]?.tool?.status).toBe('success');
    observation.close();
    await owner.flush('session');
    expect(restoreSessionViewItems('session', data)[0]).toMatchObject({ tool: { status: 'error' } });
    expect(restoreSessionViewItems('session', data)[1]?.tool?.status).toBe('success');
  } finally { await owner.close(); }
});

it('restores canonical tool outcome facts ahead of stale display status and error-like success text', () => {
  const cases = [
    { id: 'failure', content: 'Permission denied', is_error: true },
    { id: 'success', content: '[Error] is the literal marker requested', is_error: false },
    { id: 'cancelled', content: 'Stopped by user', is_error: true, metadata: { cancelled: true } },
  ];
  const data: KodaXSessionData = { title: 'Tools', gitRoot: '', messages: [
    { role: 'assistant', content: cases.map(result => ({ type: 'tool_use', id: result.id, name: 'read', input: {} })) },
    { role: 'user', content: cases.map(({ id, ...result }) => ({ type: 'tool_result', tool_use_id: id, ...result })) },
  ], uiHistory: [{ type: 'tool_group', tools: cases.map(result => ({ id: result.id, name: 'read', status: 'error', output: result.content })) }] };
  expect(restoreSessionViewItems('session', data).map(item => item.tool?.status)).toEqual(['error', 'success', 'cancelled']);
});

it('locally restores cancellation envelopes from sessions saved before structured cancellation metadata', () => {
  const data: KodaXSessionData = { title: 'Legacy tools', gitRoot: '', messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'cancelled', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cancelled', is_error: true,
      content: '[Cancelled] Operation cancelled by user' }] },
  ] };
  expect(restoreSessionViewItems('session', data)[0]?.tool?.status).toBe('cancelled');
});

it('retires checkpointed replacement output without removing other responses or retry notices', async () => {
  let saved: ClientSessionView['items'] = [];
  const createOwner = () => new SessionViewOwner(async () => ({
    session: { id: 'session', title: 'Replacement' }, settings: {}, queue: [], interactions: [], runs: [],
    items: structuredClone(saved),
  }), async (_sessionId, _runIds, items) => { saved = structuredClone(items); });
  const owner = createOwner();
  const events = owner.events('session', 'run');
  const views: ClientSessionView[] = [];
  try {
    events.onOutputSegmentStart?.({ responseId: 'earlier', providerRequestId: 'first', mode: 'append' });
    events.onTextDelta?.('Completed response', { providerRequestId: 'first' });
    events.onOutputSegmentStart?.({ responseId: 'current', providerRequestId: 'failed', mode: 'append' });
    events.onTextDelta?.('Failed partial answer', { providerRequestId: 'failed' });
    events.onThinkingDelta?.('Failed partial reasoning', { providerRequestId: 'failed' });
    events.onRetry?.('Retry this request', 1, 2);
    await owner.flush('session');
    const observation = await owner.observe('session', view => views.push(view));
    expect(views.at(-1)?.items.some(item => item.id === 'run:failed:assistant')).toBe(true);

    events.onOutputSegmentStart?.({ responseId: 'current', providerRequestId: 'replacement', mode: 'replace' });
    await owner.flush('session');
    // The replacement boundary itself retires persisted partial output, even
    // if the next provider request fails before emitting a new token.
    expect(saved.filter(item => item.id.startsWith('run:failed:'))).toEqual([]);
    events.onTextDelta?.('Replacement answer', { providerRequestId: 'replacement' });
    const second = await owner.observe('session', view => views.push(view));
    const expectedIds = ['run:first:assistant', expect.stringContaining('run:retry:'), 'run:replacement:assistant'];
    expect(views.at(-1)?.items.map(item => item.id)).toEqual(expectedIds);
    expect(views.at(-1)?.items[1]?.text).toContain('Retry this request');
    second.close();
    observation.close();
    owner.checkpoint('session');
    await owner.flush('session');
    const reopened = createOwner();
    try {
      const observation = await reopened.observe('session', view => views.push(view));
      expect(views.at(-1)?.items.map(item => item.id)).toEqual(expectedIds);
      observation.close();
    } finally { await reopened.close(); }
  } finally { await owner.close(); }
});

it('does not revive replacement output from an in-flight history read', async () => {
  let saved: ClientSessionView['items'] = [];
  let releaseRead: (() => void) | undefined;
  let startRead!: () => void;
  const readStarted = new Promise<void>(resolve => { startRead = resolve; });
  let holdRead = true;
  const owner = new SessionViewOwner(async () => {
    const items = structuredClone(saved);
    if (holdRead) {
      holdRead = false;
      startRead();
      await new Promise<void>(resolve => { releaseRead = resolve; });
    }
    return { session: { id: 'session', title: 'Replacement' }, settings: {}, queue: [], interactions: [], runs: [], items };
  }, async (_sessionId, _runIds, items) => { saved = structuredClone(items); });
  const events = owner.events('session', 'run');
  const views: ClientSessionView[] = [];
  try {
    events.onOutputSegmentStart?.({ responseId: 'response', providerRequestId: 'failed', mode: 'append' });
    events.onTextDelta?.('Failed partial answer', { providerRequestId: 'failed' });
    owner.checkpoint('session');
    await owner.flush('session');
    const observing = owner.observe('session', view => views.push(view));
    await readStarted;
    events.onOutputSegmentStart?.({ responseId: 'response', providerRequestId: 'replacement', mode: 'replace' });
    events.onTextDelta?.('Replacement answer', { providerRequestId: 'replacement' });
    releaseRead?.();
    const observation = await observing;
    expect(views.map(view => view.items.map(item => item.text))).toEqual([['Replacement answer']]);
    observation.close();
  } finally { releaseRead?.(); await owner.close(); }
});

it('waits for replacement persistence before starting a new history read', async () => {
  let saved: ClientSessionView['items'] = [];
  let holdSave = false;
  let releaseSave: (() => void) | undefined;
  const owner = new SessionViewOwner(async () => ({
    session: { id: 'session', title: 'Replacement' }, settings: {}, queue: [], interactions: [], runs: [],
    items: structuredClone(saved),
  }), async (_sessionId, _runIds, items) => {
    const snapshot = structuredClone(items);
    if (holdSave) {
      holdSave = false;
      await new Promise<void>(resolve => { releaseSave = resolve; });
    }
    saved = snapshot;
  });
  const events = owner.events('session', 'run');
  const views: ClientSessionView[] = [];
  try {
    events.onOutputSegmentStart?.({ responseId: 'response', providerRequestId: 'failed', mode: 'append' });
    events.onTextDelta?.('Failed partial answer', { providerRequestId: 'failed' });
    owner.checkpoint('session');
    await owner.flush('session');
    const baseline = await owner.observe('session', () => {});
    baseline.close();
    holdSave = true;
    events.onOutputSegmentStart?.({ responseId: 'response', providerRequestId: 'replacement', mode: 'replace' });
    events.onTextDelta?.('Replacement answer', { providerRequestId: 'replacement' });
    const observing = owner.observe('session', view => views.push(view));
    await expect.poll(() => releaseSave !== undefined).toBe(true);
    expect(views).toEqual([]);
    releaseSave?.();
    const observation = await observing;
    expect(views.map(view => view.items.map(item => item.text))).toEqual([['Replacement answer']]);
    observation.close();
  } finally { releaseSave?.(); await owner.close(); }
});

it('preserves managed harness and budget display facts in the public observation', async () => {
  const owner = new SessionViewOwner(async () => ({
    session: { id: 'session', title: 'Test' }, settings: {}, queue: [], interactions: [], runs: [], items: [],
  }), async () => {});
  owner.events('session', 'run').onManagedTaskStatus?.({ agentMode: 'ama', phase: 'worker',
    harnessProfile: 'H0_DIRECT', globalWorkBudget: 12, budgetUsage: 4, budgetApprovalRequired: true });
  const observed: ClientSessionView[] = [];
  try {
    const observation = await owner.observe('session', view => observed.push(view));
    expect(observed.at(-1)?.activity?.managedTask).toMatchObject({
      harnessProfile: 'H0_DIRECT', globalWorkBudget: 12, budgetUsage: 4, budgetApprovalRequired: true,
    });
    observation.close();
  } finally { await owner.close(); }
});

it('keeps canonical round order when saves precede display checkpoints, including equal answers', async () => {
  const data: KodaXSessionData = { title: 'Rounds', gitRoot: '', messages: [
    { role: 'user', content: 'First question', inputId: 'first', timestamp: new Date(500).toISOString() },
  ] };
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const owner = new SessionViewOwner(async (_sessionId, _history, _previous, liveItems) => ({
    session: { id: 'session', title: data.title }, settings: {}, queue: [], interactions: [], runs: [],
    items: restoreSessionViewItems('session', data, data.messages, liveItems),
  }), async (_sessionId, _runIds, items) => { data.uiHistory = persistSessionViewItems(items); });
  try {
    const first = owner.events('session', 'run-one');
    first.onOutputSegmentStart?.({ responseId: 'response-one', providerRequestId: 'request-one', mode: 'append' });
    first.onTextDelta?.('Same answer', { providerRequestId: 'request-one' });
    data.messages.push({ role: 'assistant', content: 'Same answer', timestamp: new Date(1500).toISOString() },
      { role: 'user', content: 'Second question', inputId: 'second', timestamp: new Date(1800).toISOString() });
    clock.mockReturnValue(2000);
    const second = owner.events('session', 'run-two');
    second.onOutputSegmentStart?.({ responseId: 'response-two', providerRequestId: 'request-two', mode: 'append' });
    second.onTextDelta?.('Same answer', { providerRequestId: 'request-two' });
    const views: ClientSessionView[] = [];
    const observation = await owner.observe('session', view => views.push(view));
    expect(views.at(-1)?.items.map(item => [item.type, item.text])).toEqual([
      ['user', 'First question'], ['assistant', 'Same answer'],
      ['user', 'Second question'], ['assistant', 'Same answer'],
    ]);
    expect(views.at(-1)?.items.filter(item => item.type === 'assistant').map(item => item.id))
      .toEqual(['run-one:request-one:assistant', 'run-two:request-two:assistant']);
    owner.checkpoint('session');
    await owner.flush('session');
    owner.changed('session', true);
    await owner.flush('session');
    await expect.poll(() => views.at(-1)?.items.map(item => item.id)).toEqual([
      expect.any(String), 'run-one:request-one:assistant', expect.any(String), 'run-two:request-two:assistant',
    ]);
    data.messages.push({ role: 'assistant', content: 'Same answer', timestamp: new Date(2500).toISOString() });
    owner.changed('session', true);
    await owner.flush('session');
    await expect.poll(() => views.at(-1)?.items.map(item => item.id)).toEqual([
      expect.any(String), 'run-one:request-one:assistant', expect.any(String), 'run-two:request-two:assistant',
    ]);
    observation.close();
  } finally { await owner.close(); clock.mockRestore(); }
});

it('retains a cancelled partial response after its accepted input across checkpoints and recovery', async () => {
  const data: KodaXSessionData = { title: 'Interrupted', gitRoot: '', messages: [
    { role: 'user', content: 'Earlier', inputId: 'earlier' },
    { role: 'assistant', content: 'Completed', timestamp: new Date(100).toISOString() },
    { role: 'user', content: 'Same query', inputId: 'stopped' },
  ] };
  const clock = vi.spyOn(Date, 'now').mockReturnValue(50);
  const owner = new SessionViewOwner(async (_id, _history, _previous, liveItems) => ({
    session: { id: 'session', title: data.title }, settings: {}, queue: [], interactions: [], runs: [],
    items: restoreSessionViewItems('session', data, data.messages, liveItems),
  }), async (_id, _runs, items) => { data.uiHistory = persistSessionViewItems(items); });
  const emit = (run: string, inputId: string, text: string) => {
    const events = owner.events('session', run, undefined, () => inputId);
    events.onOutputSegmentStart?.({ responseId: run, providerRequestId: run, mode: 'append' });
    events.onTextDelta?.(text, { providerRequestId: run });
  };
  try {
    emit('earlier', 'earlier', 'Completed');
    clock.mockReturnValue(200);
    emit('stopped', 'stopped', 'Partial');
    owner.checkpoint('session');
    await owner.flush('session');
    data.messages.push({ role: 'user', content: 'Same query', inputId: 'next' });
    clock.mockReturnValue(300);
    emit('next', 'next', 'Next answer');
    owner.checkpoint('session');
    await owner.flush('session');
    const observed: ClientSessionView[] = [];
    const observation = await owner.observe('session', view => observed.push(view));
    const expected = ['Earlier', 'Completed', 'Same query', 'Partial', 'Same query', 'Next answer'];
    expect(observed.at(-1)?.items.map(item => item.text)).toEqual(expected);
    data.messages.push({ role: 'assistant', content: 'Next answer', timestamp: new Date(400).toISOString() });
    owner.changed('session', true);
    await owner.flush('session');
    await expect.poll(() => observed.at(-1)?.items.map(item => item.text)).toEqual(expected);
    expect(restoreSessionViewItems('session', data, data.messages).map(item => item.text)).toEqual(expected);
    expect(restoreSessionViewItems('session', data, data.messages).find(item => item.text === 'Partial')?.id)
      .toBe('stopped:stopped:assistant');
    observation.close();
  } finally { await owner.close(); clock.mockRestore(); }
});

it.each(['initial', undefined])('captures delivered input changes only for new segments and tools (initial=%s)', async initial => {
  const owner = new SessionViewOwner(async () => ({
    session: { id: 'session', title: 'Steer' }, settings: {}, queue: [], interactions: [], runs: [], items: [],
  }), async () => {});
  let delivered = initial;
  const events = owner.events('session', 'run', undefined, () => delivered);
  events.onOutputSegmentStart?.({ responseId: 'a', providerRequestId: 'a', mode: 'append' });
  events.onToolUseStart?.({ id: 'old-tool', name: 'read', input: {} });
  delivered = 'steer';
  // The first delta can arrive after delivery although its segment began before it.
  events.onTextDelta?.('Old output', { providerRequestId: 'a' });
  events.onOutputSegmentStart?.({ responseId: 'b', providerRequestId: 'b', mode: 'append' });
  events.onTextDelta?.('New partial', { providerRequestId: 'b' });
  events.onToolResult?.({ id: 'old-tool', name: 'read', content: 'Late result' });
  events.onToolUseStart?.({ id: 'new-tool', name: 'read', input: {} });
  const views: ClientSessionView[] = [];
  try {
    const observation = await owner.observe('session', view => views.push(view));
    expect(views.at(-1)?.items.map(item => [item.id, item.afterInputId])).toEqual([
      ['run:tool:old-tool', initial], ['run:a:assistant', initial],
      ['run:b:assistant', 'steer'], ['run:tool:new-tool', 'steer'],
    ]);
    observation.close();
  } finally { await owner.close(); }
});

it('publishes API usage and rebases parent tokens after root compaction without child contamination', async () => {
  const owner = new SessionViewOwner(async () => ({
    session: { id: 'session', title: 'Test' }, settings: {}, queue: [], interactions: [], runs: [], items: [],
  }), async () => {});
  const observed: ClientSessionView[] = [];
  const events = owner.events('session', 'run');
  events.onIterationEnd?.({ iter: 1, maxIter: 20, tokenCount: 6000, tokenSource: 'api', contextKind: 'root',
    usage: { inputTokens: 5800, outputTokens: 200, totalTokens: 6000, cachedReadTokens: 400, cachedWriteTokens: 100 } });
  try {
    const observation = await owner.observe('session', view => observed.push(view));
    expect(observed.at(-1)?.activity).toMatchObject({ parentContextTokens: 6000,
      usage: { inputTokens: 5800, outputTokens: 200, totalTokens: 6000, cacheReadTokens: 400, cacheWriteTokens: 100 } });
    expect(observed.at(-1)?.activity?.usage).not.toHaveProperty('cachedReadTokens');
    expect(observed.at(-1)?.activity?.usage).not.toHaveProperty('cachedWriteTokens');
    events.onCompactStats?.({ tokensBefore: 6000, tokensAfter: 1200, contextKind: 'root' });
    await owner.flush('session');
    await expect.poll(() => observed.at(-1)?.activity?.parentContextTokens).toBe(1200);
    events.onIterationEnd?.({ iter: 1, maxIter: 4, tokenCount: 900, tokenSource: 'api', contextKind: 'child' });
    await owner.flush('session');
    await expect.poll(() => observed.at(-1)?.activity?.context?.tokenCount).toBe(900);
    expect(observed.at(-1)?.activity?.context?.scope).toBe('worker');
    expect(observed.at(-1)?.activity?.parentContextTokens).toBe(1200);
    events.onCompactStats?.({ tokensBefore: 900, tokensAfter: 300, contextKind: 'child' });
    await owner.flush('session');
    await expect.poll(() => observed.at(-1)?.activity?.context?.tokenCount).toBe(300);
    expect(observed.at(-1)?.activity?.parentContextTokens).toBe(1200);
    observation.close();
  } finally { await owner.close(); }
});

it('keeps transient AMA worker breadcrumbs in activity and only retains explicit history events', async () => {
  const owner = new SessionViewOwner(async () => ({
    session: { id: 'session', title: 'Test' }, settings: {}, queue: [], interactions: [], runs: [], items: [],
  }), async () => {});
  const events = owner.events('session', 'run');
  events.onManagedTaskStatus?.({ agentMode: 'ama', harnessProfile: 'PLANNED', phase: 'preflight',
    activeWorkerId: 'worker', activeWorkerTitle: 'Worker', note: 'Worker analyzing task' });
  const observed: ClientSessionView[] = [];
  try {
    const observation = await owner.observe('session', view => observed.push(view));
    expect(observed.at(-1)?.activity?.managedTask?.breadcrumb).toBe('AMA Worker - Worker analyzing task');
    expect(observed.at(-1)?.items).toEqual([]);
    events.onManagedTaskStatus?.({ agentMode: 'ama', harnessProfile: 'PLANNED', phase: 'worker', events: [{
      key: 'warning', kind: 'warning', summary: 'Budget requires attention', persistToHistory: true,
    }] });
    await owner.flush('session');
    await expect.poll(() => observed.at(-1)?.items.map(item => item.text))
      .toEqual(['Budget requires attention']);
    observation.close();
  } finally { await owner.close(); }
});

it('redacts display content and activity before the exact credential scope expires', async () => {
  const secret = 'display-scope-secret';
  const saved: string[] = [];
  const observed: ClientSessionView[] = [];
  const owner = new SessionViewOwner(async () => ({
    session: { id: 'session', title: 'Test' }, settings: {}, queue: [], interactions: [], runs: [], items: [],
  }), async (_sessionId, _runIds, items) => { saved.push(JSON.stringify(items)); });
  const events = owner.events('session', 'run');
  runWithProviderCredential('test', secret, () => {
    events.onRetry?.(`Retry ${secret}`, 1, 2);
    events.onTextDelta?.(secret, { providerRequestId: 'request' });
    events.onToolUseStart?.({ id: 'tool', name: 'read', input: { path: secret } });
    events.onToolProgress?.({ id: 'tool', message: secret });
    events.onTodoUpdate?.([{ id: 'todo', subject: secret, status: 'pending' }]);
    events.onTextDelta?.(secret, { contextKind: 'child', childAgentId: 'child-one' });
    owner.checkpoint('session');
  });
  // Another child's update must not republish raw details kept by the first.
  events.onTextDelta?.('Other child', { contextKind: 'child', childAgentId: 'child-two' });
  try {
    const observation = await owner.observe('session', view => observed.push(view));
    await owner.flush('session');
    expect(JSON.stringify(saved).includes(secret)).toBe(false);
    expect(JSON.stringify(observed).includes(secret)).toBe(false);
    expect(saved.join('')).toContain('[REDACTED_CREDENTIAL]');
    observation.close();
  } finally { await owner.close(); }
});

it('finishes an observation against the new branch when its initial read crosses a rewind', async () => {
  const view = (text: string): ClientSessionView => ({
    session: { id: 'session', title: 'Branch' }, settings: {}, queue: [], interactions: [], runs: [],
    items: [{ id: text, type: 'assistant', text, timestamp: 0 }],
  });
  let release = (_view: ClientSessionView) => {};
  const reading = new Promise<ClientSessionView>(resolve => { release = resolve; });
  let reads = 0;
  const owner = new SessionViewOwner(async () => ++reads === 1 ? reading : view('new branch'), async () => {});
  const observed: ClientSessionView[] = [];
  const observation = owner.observe('session', next => observed.push(next));
  owner.resetHistory('session');
  release(view('abandoned branch'));
  try {
    const handle = await observation;
    expect(observed.map(next => next.items[0]?.text)).toEqual(['new branch']);
    handle.close();
  } finally { await owner.close(); }
});

it('collapses a settled live output into its canonical copy when only whitespace diverges', () => {
  const history = [
    { id: 'u1', type: 'user' as const, text: 'query', inputId: 'input-1', timestamp: 1 },
    { id: 'c1', type: 'assistant' as const, text: 'END_SETTLED', timestamp: 2 },
  ];
  const live = [
    { id: 'run-1:req-1:assistant', type: 'assistant' as const, text: ' END_SETTLED',
      timestamp: 3, afterInputId: 'input-1' },
  ];
  const merged = mergeSessionViewItems(history, live);
  expect(merged.filter(item => item.type === 'assistant').map(item => item.id)).toEqual(['c1']);
});

it('keeps a still-streaming live output that has no canonical counterpart yet', () => {
  const history = [
    { id: 'u1', type: 'user' as const, text: 'query', inputId: 'input-1', timestamp: 1 },
  ];
  const live = [
    { id: 'run-1:req-1:assistant', type: 'assistant' as const, text: 'partial an',
      timestamp: 3, afterInputId: 'input-1' },
  ];
  const merged = mergeSessionViewItems(history, live);
  expect(merged.filter(item => item.type === 'assistant').map(item => item.id))
    .toEqual(['run-1:req-1:assistant']);
});
