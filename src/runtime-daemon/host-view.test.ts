import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClientViewItem } from '@kodax-ai/coding/client-contract';
import { createRetryHistoryItem } from '@kodax-ai/repl';

import type { HostIncident } from '../host-protocol/connection.js';
import { LocalSessionView, SessionView } from '../host-protocol/view.js';
import { applyViewOps, type SyncItem, type SyncView, type ViewOp } from '../host-protocol/view-sync.js';
import type { RuntimeWorkflowSummary } from '../sdk-runtime.js';
import type { ItemBoundedSessionView } from '../session-view.js';
import { createSessionNoticeEvents } from '../session-view-notices.js';
import {
  attachmentBlobId, createHostViewStreams, parseAttachmentBlobId, toSessionView, type HostViewStreams,
} from './host-view.js';
import { createRuntimeDaemonNotification } from './protocol.js';

const HOME = '/home/someone/.kodax';

function v1View(items: readonly ClientViewItem[], rest: Partial<ItemBoundedSessionView> = {}): ItemBoundedSessionView {
  return {
    session: { id: 'session-1', title: 'View' }, settings: {}, interactions: [], queue: [], runs: [],
    items, epoch: 'epoch-1', ...rest,
  } as ItemBoundedSessionView;
}

interface Frame {
  readonly method: string;
  readonly params: {
    readonly subscriptionId: string;
    readonly epoch?: string;
    readonly seq?: number;
    readonly snapshot?: SyncView<SyncItem>;
    readonly ops?: readonly ViewOp<SyncItem>[];
    readonly reason?: string;
  };
}

interface Rig {
  readonly streams: HostViewStreams;
  readonly frames: Frame[];
  /** What v1 was asked about the view, in order. */
  readonly calls: string[];
  /** What v1 was asked about the Session's workflows, in order. */
  readonly workflowCalls: string[];
  /** What v1 lists as the Session's workflows. A test replaces it to hold the answer back. */
  listWorkflows: () => Promise<readonly RuntimeWorkflowSummary[]>;
  /** A change v1 reports to the workflow subscription `id`. */
  workflowChanged(id?: string): void;
  workflowFailed(id?: string): void;
  readonly errors: unknown[];
  readonly incidents: HostIncident[];
  congested: boolean;
  /** What v1 answers an observe with. A test replaces it to hold the answer back. */
  observe: () => Promise<{ readonly view: unknown }>;
  /** A view v1 sends after its answer. */
  push(view: unknown, subscriptionId?: string): void;
  status(status: { readonly state: string; readonly reason?: string }, subscriptionId?: string): void;
  /** Subscribes and puts the answer on the wire. */
  subscribe(first: ItemBoundedSessionView, subscriptionId?: string): Promise<Frame['params']>;
  readonly v1: (method: string, params?: Readonly<Record<string, unknown>>) => Promise<unknown>;
}

const workflow = (status: string): RuntimeWorkflowSummary => ({
  runId: 'run-1', workflow: 'review', status, totalSpawned: 2, eventCount: 9, startedAt: 1, runDir: `${HOME}/workflow-runs/run-1`,
} as RuntimeWorkflowSummary);

function rig(local = false): Rig {
  const self: Rig = {
    frames: [],
    calls: [],
    workflowCalls: [],
    errors: [],
    incidents: [],
    listWorkflows: async () => [],
    workflowChanged: (id = 'wf-1') => self.streams.receive(
      createRuntimeDaemonNotification('event', { subscriptionId: id, event: { type: 'agent_started' } }),
    ),
    workflowFailed: (id = 'wf-1') => self.streams.receive(
      createRuntimeDaemonNotification('subscription.error', { subscriptionId: id, message: 'lost' }),
    ),
    congested: false,
    observe: async () => ({ view: undefined }),
    streams: createHostViewStreams({
      contract: local ? LocalSessionView : SessionView,
      send: frame => self.frames.push(JSON.parse(frame) as Frame),
      congested: () => self.congested,
      closeObservation: async (subscriptionId) => { self.calls.push(`close ${subscriptionId}`); },
      onInternalError: (_method, error, incident) => { self.errors.push(error); self.incidents.push(incident); },
    }),
    v1: async (method, params) => {
      if (method === 'workflow.subscribe') {
        const id = `wf-${self.workflowCalls.filter(call => call.startsWith('subscribe')).length + 1}`;
        self.workflowCalls.push(`subscribe ${id} ${JSON.stringify(params)}`);
        return { subscriptionId: id };
      }
      if (method === 'workflow.unsubscribe') {
        self.workflowCalls.push(`unsubscribe ${String(params?.subscriptionId)}`);
        return { ok: true };
      }
      if (method === 'workflow.list') {
        self.workflowCalls.push(`list ${JSON.stringify(params)}`);
        return self.listWorkflows();
      }
      self.calls.push(method);
      return self.observe();
    },
    push: (view, subscriptionId = 'sub-1') => self.streams.receive(
      createRuntimeDaemonNotification('session.view', { subscriptionId, view }),
    ),
    status: (status, subscriptionId = 'sub-1') => self.streams.receive(
      createRuntimeDaemonNotification('session.view', { subscriptionId, status }),
    ),
    subscribe: async (first, subscriptionId = 'sub-1') => {
      self.observe = async () => ({ view: first });
      const subscription = await self.streams.subscribe(subscriptionId, 'session-1', self.v1);
      subscription.answered();
      return subscription.answer as Frame['params'];
    },
  };
  return self;
}

const hello: ClientViewItem = { id: 'a', type: 'user', text: 'hello' };
const reply = (text: string): ClientViewItem => ({ id: 'b', type: 'assistant', text });

describe('a view subscription', () => {
  it('answers with the whole view, then sends only what changed', async () => {
    const host = rig();
    const answer = await host.subscribe(v1View([hello, reply('Wor')]));
    expect(answer).toMatchObject({ subscriptionId: 'sub-1', epoch: 'epoch-1', seq: 0 });
    expect(answer.snapshot!.items.map(item => item.id)).toEqual(['a', 'b']);
    expect(host.calls).toEqual(['close sub-1', 'session.view.observe']);

    host.push(v1View([hello, reply('Working')]));
    host.push(v1View([hello, reply('Working'), { id: 'c', type: 'info', text: 'done' }]));

    expect(host.frames.map(frame => [frame.method, frame.params.seq])).toEqual([['view.patch', 1], ['view.patch', 2]]);
    expect(host.frames[0]!.params.ops).toEqual([{ op: 'item.append', id: 'b', field: 'text', text: 'king' }]);
    let copy = answer.snapshot!;
    for (const frame of host.frames) {
      const applied = applyViewOps(copy, frame.params.ops!);
      if (applied.view === undefined) throw new Error('The patch did not apply.');
      copy = applied.view;
    }
    expect(copy.items.map(item => item.text)).toEqual(['hello', 'Working', 'done']);
  });

  it('sends nothing when what the client is shown did not change', async () => {
    const host = rig();
    await host.subscribe(v1View([hello]));
    // Settings are not part of the view yet, and `icon` is not part of an item.
    host.push(v1View([{ ...hello, icon: '>' }], { settings: { reasoningMode: 'deep' } } as Partial<ItemBoundedSessionView>));
    expect(host.frames).toEqual([]);
  });

  it('holds a change back until the answer is on the wire', async () => {
    const host = rig();
    host.observe = async () => ({ view: v1View([hello]) });
    const subscription = await host.streams.subscribe('sub-1', 'session-1', host.v1);
    host.push(v1View([hello, reply('one')]));
    host.push(v1View([hello, reply('one two')]));
    expect(host.frames).toEqual([]);

    subscription.answered();
    expect(host.frames).toHaveLength(1);
    expect(host.frames[0]).toMatchObject({ method: 'view.patch', params: { seq: 1 } });
    expect(host.frames[0]!.params.ops).toEqual([{ op: 'item.put', item: expect.objectContaining({ id: 'b', text: 'one two' }) }]);
  });

  it('answers with a view that arrived while v1 was still answering', async () => {
    const host = rig();
    host.observe = async () => {
      host.push(v1View([hello, reply('newer')]));
      return { view: v1View([hello]) };
    };
    const subscription = await host.streams.subscribe('sub-1', 'session-1', host.v1);
    subscription.answered();
    expect((subscription.answer as Frame['params']).snapshot!.items.map(item => item.id)).toEqual(['a', 'b']);
    expect(host.frames).toEqual([]);
  });

  it('replaces the copy when history was rebuilt', async () => {
    const host = rig();
    await host.subscribe(v1View([hello, reply('first')]));
    host.push(v1View([hello], { epoch: 'epoch-2' }));
    host.push(v1View([hello, reply('again')], { epoch: 'epoch-2' }));

    expect(host.frames.map(frame => [frame.method, frame.params.epoch, frame.params.seq])).toEqual([
      ['view.reset', 'epoch-2', 1],
      ['view.patch', 'epoch-2', 2],
    ]);
    expect(host.frames[0]!.params.snapshot!.items.map(item => item.id)).toEqual(['a']);
  });

  it('keeps only the newest view for a client that is behind, and catches it up in one step', async () => {
    const host = rig();
    const answer = await host.subscribe(v1View([hello]));
    host.congested = true;
    for (const text of ['one', 'one two', 'one two three']) host.push(v1View([hello, reply(text)]));
    expect(host.frames).toEqual([]);

    host.congested = false;
    host.streams.drained();
    host.streams.drained();
    expect(host.frames).toHaveLength(1);
    expect(host.frames[0]).toMatchObject({ method: 'view.patch', params: { seq: 1 } });
    const applied = applyViewOps(answer.snapshot!, host.frames[0]!.params.ops!);
    expect(applied.view?.items.map(item => item.text)).toEqual(['hello', 'one two three']);
  });

  it('tells the client when the Host ends the subscription', async () => {
    const host = rig();
    await host.subscribe(v1View([hello]));
    host.status({ state: 'live' });
    host.status({ state: 'closed', reason: 'unavailable' });
    host.push(v1View([hello, reply('late')]));
    expect(host.frames).toEqual([{ jsonrpc: '2.0', method: 'view.closed', params: { subscriptionId: 'sub-1', reason: 'unavailable' } }]);
  });

  it('refuses a subscription the Host ended before answering it', async () => {
    const host = rig();
    host.observe = async () => {
      host.status({ state: 'closed', reason: 'unavailable' });
      return { view: v1View([hello]) };
    };
    await expect(host.streams.subscribe('sub-1', 'session-1', host.v1)).rejects.toMatchObject({
      kodaxCode: 'unavailable', reason: 'unavailable',
    });
    expect(host.frames).toEqual([]);
    expect(host.calls.at(-1)).toBe('close sub-1');
  });

  it('ends a subscription whose view breaks the contract instead of leaving the client stale', async () => {
    const host = rig();
    await host.subscribe(v1View([hello]));
    host.push(v1View([{ ...hello, text: 42 as unknown as string }]));
    expect(host.errors).toHaveLength(1);
    // The client is told which incident the Host log names.
    expect(host.frames).toEqual([expect.objectContaining({ method: 'view.closed',
      params: { subscriptionId: 'sub-1', reason: 'internal', incidentId: host.incidents[0]!.incidentId } })]);
    expect(host.incidents[0]!.incidentId).toEqual(expect.any(String));
    expect(host.calls.at(-1)).toBe('close sub-1');
  });

  it('replaces a subscription made again under the same id, one after the other', async () => {
    const host = rig();
    let answerFirst: (answer: { readonly view: unknown }) => void = () => undefined;
    host.observe = () => new Promise((resolve) => { answerFirst = resolve; });
    const first = host.streams.subscribe('sub-1', 'session-1', host.v1);
    await expect.poll(() => host.calls).toEqual(['close sub-1', 'session.view.observe']);

    const second = host.streams.subscribe('sub-1', 'session-1', host.v1);
    await Promise.resolve();
    expect(host.calls).toHaveLength(2);

    host.observe = async () => ({ view: v1View([hello, reply('second')]) });
    answerFirst({ view: v1View([hello]) });
    (await first).answered();
    const replaced = await second;
    replaced.answered();
    expect(host.calls).toEqual(['close sub-1', 'session.view.observe', 'close sub-1', 'session.view.observe']);

    host.push(v1View([hello, reply('second more')]));
    expect(host.frames).toHaveLength(1);
    expect(host.frames[0]!.params.ops).toEqual([{ op: 'item.append', id: 'b', field: 'text', text: ' more' }]);
  });

  it('unsubscribes whether or not the subscription exists', async () => {
    const host = rig();
    await host.subscribe(v1View([hello]));
    await host.streams.unsubscribe('sub-1');
    await host.streams.unsubscribe('sub-1');
    await host.streams.unsubscribe('never');
    host.push(v1View([hello, reply('late')]));
    expect(host.frames).toEqual([]);
    expect(host.calls.slice(2)).toEqual(['close sub-1', 'close sub-1', 'close never']);
  });

  it('keeps subscriptions apart', async () => {
    const host = rig();
    await host.subscribe(v1View([hello]), 'sub-1');
    await host.subscribe(v1View([hello]), 'sub-2');
    host.push(v1View([hello, reply('two')]), 'sub-2');
    expect(host.frames.map(frame => frame.params.subscriptionId)).toEqual(['sub-2']);
  });

  it('sends Host paths to the owner only', async () => {
    const withPaths = v1View([{
      id: 'shot', type: 'tool', text: 'saved',
      attachments: [{ kind: 'image', path: `${HOME}/media/shot.png`, mediaType: 'image/png' }],
      tool: { callId: 'c', name: 'screenshot', status: 'success', outputPath: `${HOME}/outputs/c.txt` },
    }], { sandbox: { state: 'degraded', degradedReadRoots: [`${HOME}/sandbox`] } } as unknown as Partial<ItemBoundedSessionView>);

    const owner = JSON.stringify(await rig(true).subscribe(withPaths));
    expect(owner).toContain(`${HOME}/media/shot.png`);
    expect(owner).toContain(`${HOME}/sandbox`);
    // Where the Host keeps a tool's complete output is its own business, for the owner too.
    expect(owner).not.toContain(`${HOME}/outputs`);

    const other = await rig().subscribe(withPaths);
    expect(JSON.stringify(other)).not.toContain(HOME);
    expect(other.snapshot!.items[0]).toMatchObject({ attachments: [{ kind: 'image', mediaType: 'image/png' }], tool: { outputSaved: true } });
    // Everyone reads the bytes by blobId, which names the item and the attachment's place in it.
    const { blobId } = (other.snapshot!.items[0] as unknown as { attachments: [{ blobId: string }] }).attachments[0];
    expect(parseAttachmentBlobId(blobId)).toEqual({ itemId: 'shot', index: 0 });
  });

  it('knows only the attachment blobIds it makes', () => {
    expect(parseAttachmentBlobId(attachmentBlobId('item~1', 3))).toEqual({ itemId: 'item~1', index: 3 });
    for (const blobId of ['b_abc', 'a_', 'a_!!', `a_${Buffer.from('[1,2]').toString('base64url')}`, `a_${Buffer.from('["x",-1]').toString('base64url')}`]) {
      expect(parseAttachmentBlobId(blobId)).toBeUndefined();
    }
  });
});

describe("a view of the Session's workflows", () => {
  it('carries them from the answer on, and sends a change as one key', async () => {
    const host = rig();
    host.listWorkflows = async () => [workflow('running')];
    const answer = await host.subscribe(v1View([hello]));
    expect(answer.snapshot).toMatchObject({
      workflows: [{ id: 'run-1', name: 'review', status: 'running', spawnedAgents: 2, startedAt: 1 }],
    });
    // Followed before it is read, so no change falls between the two.
    expect(host.workflowCalls).toEqual(['subscribe wf-1 {"filter":{"sessionId":"session-1"},"reportErrors":true}', 'list {"sessionId":"session-1"}']);
    expect(JSON.stringify(answer)).not.toContain('workflow-runs');

    host.listWorkflows = async () => [workflow('completed')];
    host.workflowChanged();
    await expect.poll(() => host.frames).toHaveLength(1);
    expect(host.frames[0]).toMatchObject({ method: 'view.patch', params: { seq: 1 } });
    expect(host.frames[0]!.params.ops).toEqual([
      { op: 'set', key: 'workflows', value: [expect.objectContaining({ id: 'run-1', status: 'completed' })] },
    ]);
  });

  it('reads them once more for any number of changes during a read', async () => {
    const host = rig();
    await host.subscribe(v1View([hello]));
    let finish: (workflows: readonly RuntimeWorkflowSummary[]) => void = () => undefined;
    host.listWorkflows = () => new Promise((resolve) => { finish = resolve; });
    for (let change = 0; change < 3; change += 1) host.workflowChanged();
    expect(host.workflowCalls.filter(call => call.startsWith('list'))).toHaveLength(2);

    host.listWorkflows = async () => [workflow('paused')];
    finish([workflow('running')]);
    await expect.poll(() => host.frames.at(-1)?.params.ops).toEqual([
      { op: 'set', key: 'workflows', value: [expect.objectContaining({ status: 'paused' })] },
    ]);
    expect(host.workflowCalls.filter(call => call.startsWith('list'))).toHaveLength(3);
  });

  it('stops following them when the subscription ends, however it ends', async () => {
    const host = rig();
    await host.subscribe(v1View([hello]));
    await host.subscribe(v1View([hello]));
    await host.streams.unsubscribe('sub-1');
    await host.subscribe(v1View([hello]));
    host.status({ state: 'closed', reason: 'unavailable' });
    await expect.poll(() => host.workflowCalls.filter(call => call.startsWith('unsubscribe')))
      .toEqual(['unsubscribe wf-1', 'unsubscribe wf-2', 'unsubscribe wf-3']);
    // A change reported to a subscription already let go of reads nothing.
    host.workflowChanged('wf-3');
    expect(host.workflowCalls.filter(call => call.startsWith('list'))).toHaveLength(3);
  });

  it('ends the view when they can no longer be followed, so the client is not left stale', async () => {
    const host = rig();
    await host.subscribe(v1View([hello]));
    host.workflowFailed();
    expect(host.frames).toEqual([expect.objectContaining({ method: 'view.closed',
      params: { subscriptionId: 'sub-1', reason: 'internal', incidentId: host.incidents[0]!.incidentId } })]);
    expect(host.calls.at(-1)).toBe('close sub-1');
  });
});

describe('a v1 view in v2 terms', () => {
  it('says which items may still change', () => {
    const view = SessionView.parse(toSessionView(v1View([
      { id: 'draft', type: 'assistant', text: 'streaming', outputState: 'draft', sourceRunId: 'run-live' },
      { id: 'left', type: 'assistant', text: 'interrupted', outputState: 'draft', sourceRunId: 'run-gone' },
      { id: 'done', type: 'assistant', text: 'saved', outputState: 'committed', sourceRunId: 'run-live' },
      { id: 'tool', type: 'tool', text: '', tool: { callId: 'c1', name: 'bash', status: 'running' } },
      { id: 'ask', type: 'tool', text: '', tool: { callId: 'c2', name: 'bash', status: 'awaiting_approval' } },
      { id: 'ran', type: 'tool', text: 'ok', tool: { callId: 'c3', name: 'bash', status: 'success' } },
    ] as ClientViewItem[], { runs: [{ runId: 'run-live', phase: 'running', provider: 'anthropic' }] })));
    expect(Object.fromEntries(view.items.map(item => [item.id, item.state]))).toEqual({
      draft: 'live', left: 'settled', done: 'settled', tool: 'live', ask: 'live', ran: 'settled',
    });
  });

  it('names the file of a proposed change inside the workspace, and its Host path for the owner only', () => {
    const workspace = path.resolve('host-workspace');
    const change = { added: 1, removed: 0, unified: '@@ -0,0 +1,1 @@\n+note' };
    const permission = (file: string) => ({
      requestId: `perm-${file}`, sessionId: 'session-1', runId: 'run-1', createdAt: '2026-11-22T10:00:00.000Z',
      kind: 'permission', options: { toolName: 'write', diff: { ...change, path: file } },
    });
    const inside = path.join(workspace, 'app', 'note.txt');
    const outside = path.resolve('elsewhere', 'note.txt');
    const source = v1View([], { interactions: [permission(inside), permission(outside)] } as unknown as Partial<ItemBoundedSessionView>);
    const requests = (contract: typeof SessionView | typeof LocalSessionView) =>
      contract.parse(toSessionView(source, workspace)).interactions.map(item => (item.request as { diff?: unknown }).diff);
    expect(requests(SessionView)).toEqual([{ ...change, path: 'app/note.txt' }, change]);
    expect(requests(LocalSessionView)).toEqual([{ ...change, path: 'app/note.txt', hostPath: inside }, { ...change, hostPath: outside }]);
  });

  it('gives every item its own id and leaves out a time that is not a number', () => {
    const view = SessionView.parse(toSessionView(v1View([
      { id: 'old', type: 'info', text: 'one', timestamp: Number.NaN },
      { id: 'old', type: 'info', text: 'two', timestamp: 1700000000000.5 },
      { id: 'old', type: 'info', text: 'three' },
    ])));
    expect(view.items.map(item => [item.id, item.at])).toEqual([['old', undefined], ['old~1', 1700000000000], ['old~2', undefined]]);
  });

  it('carries the Session, its quarantine in milliseconds and its project inside the workspace', () => {
    const workspace = path.resolve('host-workspace');
    const source = v1View([], {
      session: {
        id: 'session-1', title: 'View', workspaceRoot: path.join(workspace, 'app'),
        recovery: { state: 'stalled', since: '2026-11-21T10:00:00.000Z', code: 'actor_settlement_not_persisted' },
      },
    } as Partial<ItemBoundedSessionView>);
    const expected = {
      id: 'session-1', title: 'View', archived: false, project: 'app',
      recovery: { state: 'stalled', since: Date.parse('2026-11-21T10:00:00.000Z'), code: 'actor_settlement_not_persisted' },
    };
    expect(SessionView.parse(toSessionView(source, workspace)).session).toEqual(expected);
    expect(LocalSessionView.parse(toSessionView(source, workspace)).session)
      .toEqual({ ...expected, workspaceRoot: path.join(workspace, 'app') });
    expect(SessionView.parse(toSessionView(source)).session.project).toBeUndefined();
    expect(SessionView.parse(toSessionView(v1View([]))).session).toEqual({ id: 'session-1', title: 'View', archived: false });
  });

  it('names the inputs a user item stands for', () => {
    const view = SessionView.parse(toSessionView(v1View([
      { id: 'one', type: 'user', text: 'a', inputId: 'in-1' },
      { id: 'merged', type: 'user', text: 'b', inputId: 'in-2', inputIds: ['in-2', 'in-3'] },
    ])));
    expect(view.items.map(item => item.inputIds)).toEqual([['in-1'], ['in-2', 'in-3']]);
  });

  it('names the kind of a Host notice, so a client picks its own icon', () => {
    const notices: ClientViewItem[] = [];
    const events = createSessionNoticeEvents('session-1', notice => { notices.push({ id: `n${notices.length}`, ...notice }); });
    events.onRetryAfter?.({ provider: 'anthropic', waitMs: 2000, attempt: 1, maxAttempts: 3, source: 'retry-after-seconds', reason: 'rate-limit' });
    events.onProviderRateLimit?.(2, 3, 4000);
    events.onProviderRecovery?.({ stage: 'mid_stream_text', errorClass: 'stream_idle_timeout', attempt: 1, maxAttempts: 3,
      delayMs: 1000, recoveryAction: 'stable_boundary_retry', ladderStep: 1, fallbackUsed: false });
    events.onCompact?.(42000);
    const items: ClientViewItem[] = [
      ...notices,
      { id: 'retry', ...createRetryHistoryItem('Provider overloaded', 1, 3) },
      { id: 'plain', type: 'info', text: '[memory] noted' },
      { id: 'legacy', type: 'info', icon: '⚠', text: 'an icon from an old client' },
    ];
    const view = SessionView.parse(toSessionView(v1View(items)));
    expect(view.items.map(item => item.notice?.kind)).toEqual(
      ['retry', 'retry', 'retry', 'compaction', 'retry', undefined, undefined]);
  });
});
