import { expect, it } from 'vitest';
import { runWithProviderCredential } from '@kodax-ai/llm';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { SessionViewOwner } from './session-view.js';

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
