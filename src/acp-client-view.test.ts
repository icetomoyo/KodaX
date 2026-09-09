import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { createKodaXRuntime } from './sdk-runtime.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';
import { observeAcpClientPrompt } from './acp-client-view.js';

it('projects full current text and explicit revisions without replaying bounded prior history', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-acp-projection-'));
  const runtime = await createKodaXRuntime({ homeDir });
  const client = toKodaXProductClient(runtime);
  const session = await client.sessions.create({ projectPath: homeDir });
  let current: ClientSessionView | undefined;
  const initial = await client.sessions.observe(session.id, view => { current = view; });
  initial.close();
  if (!current) throw new Error('Missing initial Session view.');
  let view: ClientSessionView = { ...current, items: [{ id: 'old', type: 'assistant', text: 'tail', textOffset: 96, totalTextLength: 100 }] };
  let listener: ((next: ClientSessionView) => void) | undefined;
  vi.spyOn(client.sessions, 'observe').mockImplementation(async (_id, onView) => {
    listener ??= onView;
    onView(view);
    return { close() {} };
  });
  vi.spyOn(client.sessions, 'readItem').mockImplementation(async (_id, itemId, options) => {
    const text = itemId === 'old' ? 'old history'.repeat(10) : 'complete current answer';
    const offset = options?.offset ?? 0;
    const next = Math.min(offset + 8, text.length);
    return { id: itemId, text: text.slice(offset, next), offset, totalLength: text.length, ...(next < text.length ? { nextOffset: next } : {}) };
  });
  const updates: SessionNotification[] = [];
  const respond = vi.spyOn(client.interactions, 'respond');
  let rejectDelivery = false;
  const projection = await observeAcpClientPrompt(client, session.id, async notification => { if (rejectDelivery) throw new Error('Notification delivery failed'); updates.push(notification); },
    async () => ({ type: 'allow_once' }), () => ({}));
  try {
    view = { ...view, items: [...view.items, { id: 'new', type: 'assistant', text: 'answer', textOffset: 17, totalTextLength: 23 }] };
    listener!(view);
    await projection.flush();
    view = { ...view, items: [view.items[0]!, { id: 'new', type: 'assistant', text: 'Corrected answer' }] };
    listener!(view);
    await projection.flush();
    expect(updates.map(({ update }) => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? update.content.text : '')).toEqual([
      'complete current answer', '\n[Updated response]\nCorrected answer',
    ]);
    view = { ...view, interactions: [{ kind: 'question_input', requestId: 'question', sessionId: session.id,
      runId: 'run', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), options: { question: 'Choose input' } }] };
    listener!(view);
    await projection.flush();
    expect(updates.at(-1)).toMatchObject({ update: { content: { text: expect.stringContaining('Open this Session in a KodaX client') } } });
    expect(respond).not.toHaveBeenCalled();
    rejectDelivery = true;
    view = { ...view, items: [{ id: 'failure', type: 'assistant', text: 'New response' }] };
    listener!(view);
    await expect(projection.failed).resolves.toMatchObject({ message: 'Notification delivery failed' });
    await expect(projection.flush()).rejects.toThrow('Notification delivery failed');
  } finally {
    projection.close();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

it.each(['no-progress', 'disappeared'] as const)('fails promptly when a Host item page is %s', async scenario => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-acp-page-'));
  const runtime = await createKodaXRuntime({ homeDir });
  const client = toKodaXProductClient(runtime);
  const session = await client.sessions.create({ projectPath: homeDir });
  let view: ClientSessionView | undefined;
  const initial = await client.sessions.observe(session.id, current => { view = current; });
  initial.close();
  if (!view) throw new Error('Missing initial Session view.');
  const savedView = view;
  let listener: ((view: ClientSessionView) => void) | undefined;
  vi.spyOn(client.sessions, 'observe').mockImplementation(async (_id, onView) => {
    listener = onView;
    onView(savedView);
    return { close() {} };
  });
  const read = vi.spyOn(client.sessions, 'readItem').mockRejectedValue(new Error('Unexpected second page read'))
    .mockResolvedValueOnce(scenario === 'disappeared' ? null : { id: 'item', text: '', offset: 0, totalLength: 10, nextOffset: 0 });
  const projection = await observeAcpClientPrompt(client, session.id, async () => {}, async () => ({ type: 'allow_once' }), () => ({}));
  try {
    listener!({ ...savedView, items: [{ id: 'item', type: 'assistant', text: 'tail', textOffset: 6, totalTextLength: 10 }] });
    await expect(projection.failed).resolves.toMatchObject({ message: expect.stringContaining(scenario === 'disappeared' ? 'disappeared' : 'inconsistent page') });
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    projection.close();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
