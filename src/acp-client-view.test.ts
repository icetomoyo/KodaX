import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ClientSessionView, ClientObservationStatus, ClientPermissionDecision } from '@kodax-ai/coding/client-contract';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { createKodaXRuntime } from './sdk-runtime.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';
import { observeAcpClientPrompt } from './acp-client-view.js';

it.each(['revision', 'state'] as const)('rejects mixed ACP pages when %s changes without replaying emitted content', async change => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-acp-page-identity-'));
  const runtime = await createKodaXRuntime({ homeDir });
  const client = toKodaXProductClient(runtime);
  const session = await client.sessions.create({ projectPath: homeDir });
  let view: ClientSessionView = { session, settings: {}, items: [], queue: [], interactions: [], runs: [] };
  vi.spyOn(client.sessions, 'observe').mockImplementation(async (_id, receive) => {
    receive(view);
    return { close() {} };
  });
  const read = vi.spyOn(client.sessions, 'readItem').mockImplementation(async (_session, id, options) => {
    const offset = options?.offset ?? 0;
    return { id, text: offset === 4 ? 'efgh' : 'tail', offset, totalLength: 12,
      ...(offset === 4 ? { nextOffset: 8 } : {}), textRevision: offset === 8 && change === 'revision' ? 1 : 0,
      ...{ outputState: offset === 8 && change === 'state' ? 'committed' as const : 'draft' as const },
    };
  });
  const updates: SessionNotification[] = [];
  const projection = await observeAcpClientPrompt(client, session.id, async update => { updates.push(update); },
    async () => ({ type: 'allow_once' }), () => ({}));
  try {
    const item = { id: 'output', type: 'assistant' as const, textRevision: 0, outputState: 'draft' as const };
    view = { ...view, items: [{ ...item, text: 'abcd' }] };
    await projection.flush();
    view = { ...view, items: [{ ...item, text: 'tail', textOffset: 8, totalTextLength: 12 }] };
    await expect(projection.flush()).rejects.toThrow('changed');
    expect(read).toHaveBeenCalledTimes(2);
    expect(updates.flatMap(({ update }) => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
      ? [update.content.text] : [])).toEqual(['abcd']);
  } finally {
    projection.close();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

it('projects continuous Host identities once through settlement and repeated snapshots, reading only revised bounded bodies', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-acp-identity-'));
  const runtime = await createKodaXRuntime({ homeDir });
  const client = toKodaXProductClient(runtime);
  const session = await client.sessions.create({ projectPath: homeDir });
  let view: ClientSessionView = { session, settings: {}, items: [], queue: [], interactions: [], runs: [] };
  let listener: ((next: ClientSessionView) => void) | undefined;
  vi.spyOn(client.sessions, 'observe').mockImplementation(async (_id, receive) => {
    listener ??= receive;
    receive(view);
    return { close() {} };
  });
  let body = 'abcdefgh';
  let bodyRevision = 0;
  let bodyState: 'draft' | 'committed' = 'draft';
  const read = vi.spyOn(client.sessions, 'readItem').mockImplementation(async (_id, itemId, options) => ({
    id: itemId, text: body.slice(options?.offset), offset: options?.offset ?? 0, totalLength: body.length,
    textRevision: bodyRevision, ...{ outputState: bodyState },
  }));
  const updates: SessionNotification[] = [];
  const projection = await observeAcpClientPrompt(client, session.id, async update => { updates.push(update); },
    async () => ({ type: 'allow_once' }), () => ({}));
  const push = async (items: ClientSessionView['items']) => {
    view = { ...view, items };
    listener!(view);
    await projection.flush();
  };
  try {
    const output = { id: 'output', outputId: 'logical-output', type: 'assistant' as const, textRevision: 0 };
    await push([{ ...output, text: 'abcdef', outputState: 'draft' }]);
    await push([{ ...output, text: 'fgh', textOffset: 5, totalTextLength: 8, outputState: 'draft' }]);
    expect(read).not.toHaveBeenCalled();
    body = 'XYZdefgh';
    bodyRevision = 1;
    const revised = { ...output, text: 'fgh', textOffset: 5, totalTextLength: 8, textRevision: 1, outputState: 'draft' as const };
    await push([revised]);
    await push([revised]);
    expect(read).toHaveBeenCalledOnce();
    // Missing append characters are fetched from the last emitted offset only;
    // a newer readItem body must not leak past this captured frame's length.
    body = 'XYZdefghijklmnop-not-in-this-frame';
    const extended = { ...revised, text: 'mnop', textOffset: 12, totalTextLength: 16 };
    await push([extended]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith(session.id, 'output', { part: 'text', offset: 8 });
    bodyState = 'committed';
    body = 'XYZdefghijklmnop';
    const committed = { ...extended, outputState: 'committed' as const };
    await push([committed]);
    await push([committed, { ...output, id: 'other', outputId: 'other-output', text: body }]);
    expect(read).toHaveBeenCalledTimes(3);
    expect(updates.flatMap(({ update }) => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
      ? [update.content.text] : [])).toEqual(['abcdef', 'gh', '\n[Updated response]\nXYZdefgh', 'ijklmnop', 'XYZdefghijklmnop']);
  } finally {
    projection.close();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

it.each(['interrupted', 'closed'] as const)('fails ACP projection when observation is %s and ignores a late permission answer', async state => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-acp-status-'));
  const runtime = await createKodaXRuntime({ homeDir });
  const client = toKodaXProductClient(runtime);
  const session = await client.sessions.create({ projectPath: homeDir });
  const view: ClientSessionView = { session, settings: {}, items: [], queue: [], interactions: [], runs: [] };
  let listener: ((view: ClientSessionView) => void) | undefined;
  let onStatus: ((status: ClientObservationStatus) => void) | undefined;
  vi.spyOn(client.sessions, 'observe').mockImplementation(async (_id, onView, options) => {
    listener = onView;
    onStatus = options?.onStatus;
    onView(view);
    options?.onStatus?.({ state: 'live' });
    return { close() { options?.onStatus?.({ state: 'closed', reason: 'client' }); } };
  });
  let answer: ((decision: ClientPermissionDecision) => void) | undefined;
  const pendingDecision = new Promise<ClientPermissionDecision>(resolve => { answer = resolve; });
  const permission = vi.fn(() => pendingDecision);
  const respond = vi.spyOn(client.interactions, 'respond');
  const projection = await observeAcpClientPrompt(client, session.id, async () => undefined, permission, () => ({}));
  const failures: unknown[] = [];
  void projection.failed.then(error => { failures.push(error); });
  try {
    listener?.({ ...view, interactions: [{ kind: 'permission', requestId: 'approval', sessionId: session.id,
      runId: 'run', createdAt: new Date().toISOString(), options: { toolName: 'read' } }] });
    expect(permission).toHaveBeenCalledOnce();
    onStatus?.(state === 'closed' ? { state, reason: 'unavailable' } : { state });
    await expect.poll(() => failures[0]).toMatchObject({ message: expect.stringContaining('observation') });
    answer?.({ type: 'allow_once' });
    await pendingDecision;
    await expect(projection.flush()).rejects.toThrow('observation');
    expect(respond).not.toHaveBeenCalled();
  } finally {
    answer?.({ type: 'reject' });
    projection.close();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

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
