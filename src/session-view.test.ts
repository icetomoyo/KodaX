import { expect, it, vi } from 'vitest';
import type { KodaXSessionData } from '@kodax-ai/agent';
import { runWithProviderCredential } from '@kodax-ai/llm';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { SessionViewOwner, restoreSessionViewItems, persistSessionViewItems } from './session-view.js';

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
  let holdRead = true;
  const owner = new SessionViewOwner(async () => {
    const items = structuredClone(saved);
    if (holdRead) {
      holdRead = false;
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

it('publishes API usage and rebases parent tokens after root compaction without child contamination', async () => {
  const owner = new SessionViewOwner(async () => ({
    session: { id: 'session', title: 'Test' }, settings: {}, queue: [], interactions: [], runs: [], items: [],
  }), async () => {});
  const observed: ClientSessionView[] = [];
  const events = owner.events('session', 'run');
  events.onIterationEnd?.({ iter: 1, maxIter: 20, tokenCount: 6000, tokenSource: 'api', contextKind: 'root',
    usage: { inputTokens: 5800, outputTokens: 200, totalTokens: 6000 } });
  try {
    const observation = await owner.observe('session', view => observed.push(view));
    expect(observed.at(-1)?.activity).toMatchObject({ parentContextTokens: 6000,
      usage: { inputTokens: 5800, outputTokens: 200, totalTokens: 6000 } });
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
