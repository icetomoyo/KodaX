/**
 * Serves v2 view subscriptions from the views the v1 implementation produces.
 * v1 sends the whole view each time it changes; this turns each one into the
 * operations that bring a client's copy up to date, and sends nothing when
 * what the client is shown did not change.
 *
 * A Session's view also carries its workflows. v1 reports that they changed
 * on a subscription of its own, and the Host then reads them again.
 */
import type { ClientInteraction, ClientSession, ClientSessionView, ClientViewItem } from '@kodax-ai/coding/client-contract';

import { HostProtocolError, hostRpcNotification } from '../host-protocol/codec.js';
import type { LocalSessionView, SessionView } from '../host-protocol/view.js';
import { diffSessionView, type SyncItem, type SyncView } from '../host-protocol/view-sync.js';
import type { RuntimeWorkflowSummary } from '../sdk-runtime.js';
import { STREAMING_RUN_PHASES, type ItemBoundedSessionView } from '../session-view.js';
import { noticeKind } from '../session-view-notices.js';
import type { RuntimeDaemonMethod, RuntimeDaemonNotification } from './protocol.js';
import { within, type HostWorkspace } from './workspace.js';

type View = SyncView<SyncItem>;

/** A view as the client is shown it, and the history it belongs to. */
interface Shown {
  readonly epoch: string;
  readonly view: View;
}

/** One subscription. A new object each time the id is subscribed, so a late event can tell it was replaced. */
interface Stream {
  readonly subscriptionId: string;
  readonly sessionId: string;
  /** Asks v1 as the client who subscribed. */
  readonly v1: V1Call;
  /** The Host workspace, which the Session's `project` is named inside. */
  readonly workspaceRoot: string | undefined;
  /** What the client holds and where it stands. Absent until the subscription is answered. */
  copy?: { epoch: string; seq: number; view: View };
  /** The answer is on the wire, so what follows it may be sent. */
  answered: boolean;
  /** The newest view the client was not sent yet. */
  pending?: Shown;
  /** Why the Host ended the subscription before its answer was on the wire. */
  ended?: string;
  /** The newest view v1 sent. */
  base?: ItemBoundedSessionView;
  /** The Session's workflows as last read, in v2 terms. */
  workflows: readonly Readonly<Record<string, unknown>>[];
  /** The v1 subscription that reports a change to the Session's workflows. */
  workflowSubscription?: string;
  /** The workflows are being read; `rereadWorkflows` asks for one more read after this one. */
  readingWorkflows: boolean;
  rereadWorkflows: boolean;
}

/** As many workflows as a view carries; `workflow.list` reads the rest. */
const VIEW_WORKFLOWS = 50;

type V1Call = (method: RuntimeDaemonMethod, params?: Readonly<Record<string, unknown>>) => Promise<unknown>;

export interface HostViewStreamsOptions {
  /** The view contract of the connection: the local one, for the Host's own machine, carries Host paths. */
  readonly contract: typeof SessionView | typeof LocalSessionView;
  /** Where the Sessions in a view name their project. Without it they name none. */
  readonly workspace?: HostWorkspace;
  readonly send: (frame: string) => void;
  /** Whether the link is holding back what was already sent to it. */
  readonly congested: () => boolean;
  /** Ends the v1 observation behind a subscription. Succeeds when there is none. */
  readonly closeObservation: (subscriptionId: string) => Promise<void>;
  readonly onInternalError: (method: string, error: unknown) => void;
}

export interface HostViewSubscription {
  /** The whole view, as the answer to subscribing. */
  readonly answer: Readonly<Record<string, unknown>>;
  /** Call once the answer is on the wire. Changes are held back until then, so none overtakes it. */
  answered(): void;
}

export interface HostViewStreams {
  /** Subscribing under an id already in use replaces that subscription. `v1` observes as the client's request. */
  subscribe(subscriptionId: string, sessionId: string, v1: V1Call): Promise<HostViewSubscription>;
  /** Succeeds whether or not the subscription exists. */
  unsubscribe(subscriptionId: string): Promise<void>;
  /** Takes every notification v1 sends this connection. */
  receive(notification: RuntimeDaemonNotification): void;
  /** The link can take frames again. */
  drained(): void;
  close(): void;
}

export function createHostViewStreams(options: HostViewStreamsOptions): HostViewStreams {
  const streams = new Map<string, Stream>();
  /** Streams by the v1 subscription that follows their workflows. */
  const workflowStreams = new Map<string, Stream>();
  const { contract } = options;
  const notify = (method: string, params: Readonly<Record<string, unknown>>): void => {
    options.send(JSON.stringify(hostRpcNotification(method, params)));
  };
  /** Throws when the view breaks the contract. */
  const shown = (stream: Stream, view: ItemBoundedSessionView): Shown => ({
    epoch: view.epoch,
    view: contract.parse(toSessionView(view, stream.workspaceRoot, stream.workflows)) as View,
  });
  /**
   * Brings the client's copy up to the newest view. While the link is congested
   * views replace each other here unsent, so a slow client costs the Host one
   * view and catches up in one step.
   */
  const flush = (stream: Stream): void => {
    const { copy, pending } = stream;
    if (copy === undefined || pending === undefined || !stream.answered || options.congested()) return;
    stream.pending = undefined;
    const position = { subscriptionId: stream.subscriptionId, epoch: pending.epoch, seq: copy.seq + 1 };
    if (pending.epoch !== copy.epoch) {
      // History was rebuilt: nothing the client holds is known to still be there.
      stream.copy = { epoch: pending.epoch, seq: position.seq, view: pending.view };
      notify('view.reset', { ...position, snapshot: pending.view });
      return;
    }
    const ops = diffSessionView(copy.view, pending.view);
    if (ops.length === 0) return;
    copy.seq = position.seq;
    copy.view = pending.view;
    notify('view.patch', { ...position, ops });
  };
  /** The Host ended the subscription. The client learns it and may subscribe again. */
  const end = (stream: Stream, reason: string): void => {
    if (streams.get(stream.subscriptionId) !== stream) return;
    streams.delete(stream.subscriptionId);
    unfollowWorkflows(stream);
    if (stream.answered) notify('view.closed', { subscriptionId: stream.subscriptionId, reason });
    else stream.ended = reason;
  };
  /** Something the client would be shown cannot be. Ending the subscription beats leaving the client stale. */
  const fail = (stream: Stream, error: unknown): void => {
    options.onInternalError('view.subscribe', error);
    if (streams.get(stream.subscriptionId) !== stream) return;
    end(stream, 'internal');
    options.closeObservation(stream.subscriptionId)
      .catch((failure: unknown) => options.onInternalError('view.subscribe', failure));
  };
  const unfollowWorkflows = (stream: Stream): void => {
    const followed = stream.workflowSubscription;
    if (followed === undefined) return;
    stream.workflowSubscription = undefined;
    workflowStreams.delete(followed);
    stream.v1('workflow.unsubscribe', { subscriptionId: followed })
      .catch((error: unknown) => options.onInternalError('view.subscribe', error));
  };
  /** Drops the subscription under an id, if there is one. */
  const release = (subscriptionId: string): void => {
    const stream = streams.get(subscriptionId);
    streams.delete(subscriptionId);
    if (stream !== undefined) unfollowWorkflows(stream);
  };
  const listWorkflows = async (stream: Stream): Promise<readonly Readonly<Record<string, unknown>>[]> => (
    sessionWorkflows(await stream.v1('workflow.list', { sessionId: stream.sessionId }) as readonly RuntimeWorkflowSummary[])
  );
  /**
   * Reads the workflows again after a change. Changes that come during a read
   * cost one more read, not one each, and no read overtakes a later one.
   */
  const readWorkflows = (stream: Stream): void => {
    if (stream.readingWorkflows) {
      stream.rereadWorkflows = true;
      return;
    }
    stream.readingWorkflows = true;
    void (async () => {
      try {
        do {
          stream.rereadWorkflows = false;
          const workflows = await listWorkflows(stream);
          if (streams.get(stream.subscriptionId) !== stream) return;
          stream.workflows = workflows;
          if (stream.base !== undefined && stream.copy !== undefined) {
            stream.pending = shown(stream, stream.base);
            flush(stream);
          }
        } while (stream.rereadWorkflows);
      } catch (error: unknown) {
        fail(stream, error);
      } finally {
        stream.readingWorkflows = false;
      }
    })();
  };

  /** Subscribing and unsubscribing under one id take turns, so a replaced subscription is gone before its successor starts. */
  const turns = new Map<string, Promise<void>>();
  const inTurn = <Result>(subscriptionId: string, run: () => Promise<Result>): Promise<Result> => {
    const result = (turns.get(subscriptionId) ?? Promise.resolve()).then(run);
    const done = result.then(() => undefined, () => undefined);
    turns.set(subscriptionId, done);
    void done.then(() => {
      if (turns.get(subscriptionId) === done) turns.delete(subscriptionId);
    });
    return result;
  };

  return {
    subscribe: (subscriptionId, sessionId, v1) => inTurn(subscriptionId, async () => {
      release(subscriptionId);
      await options.closeObservation(subscriptionId);
      const stream: Stream = {
        subscriptionId, sessionId, v1, workspaceRoot: await options.workspace?.root(), answered: false,
        workflows: [], readingWorkflows: true, rereadWorkflows: false,
      };
      // Registered before v1 observes, so a view that arrives ahead of v1's answer is kept.
      streams.set(subscriptionId, stream);
      try {
        // Followed before they are read, so no change falls between the two.
        const { subscriptionId: followed } = await v1('workflow.subscribe', {
          filter: { sessionId }, reportErrors: true,
        }) as { readonly subscriptionId: string };
        stream.workflowSubscription = followed;
        workflowStreams.set(followed, stream);
        try {
          stream.workflows = await listWorkflows(stream);
        } finally {
          stream.readingWorkflows = false;
        }
        if (stream.rereadWorkflows) readWorkflows(stream);
        const { view: first } = await v1('session.view.observe', { sessionId, subscriptionId, bounds: 'item' }) as
          { readonly view: unknown };
        if (stream.ended !== undefined) {
          throw new HostProtocolError('unavailable', 'The Host ended the subscription before answering it.', {
            reason: stream.ended,
          });
        }
        // A view that arrived ahead of the answer is newer than the answer's.
        stream.base ??= first as ItemBoundedSessionView;
        const { epoch, view } = shown(stream, stream.base);
        stream.pending = undefined;
        stream.copy = { epoch, seq: 0, view };
        return {
          answer: { subscriptionId, epoch, seq: 0, snapshot: view },
          answered: () => {
            if (stream.ended !== undefined) {
              notify('view.closed', { subscriptionId, reason: stream.ended });
              return;
            }
            stream.answered = true;
            flush(stream);
          },
        };
      } catch (error: unknown) {
        if (streams.get(subscriptionId) === stream) streams.delete(subscriptionId);
        unfollowWorkflows(stream);
        await options.closeObservation(subscriptionId);
        throw error;
      }
    }),
    unsubscribe: subscriptionId => inTurn(subscriptionId, async () => {
      release(subscriptionId);
      await options.closeObservation(subscriptionId);
    }),
    receive(notification) {
      if (notification.method === 'event' || notification.method === 'subscription.error') {
        const stream = workflowStreams.get((notification.params as { readonly subscriptionId: string }).subscriptionId);
        if (stream === undefined) return;
        if (notification.method === 'event') readWorkflows(stream);
        else fail(stream, new Error('The Host stopped reporting changes to the workflows of the Session.'));
        return;
      }
      if (notification.method !== 'session.view') return;
      const params = notification.params as {
        readonly subscriptionId: string;
        readonly view?: unknown;
        readonly status?: { readonly state: string; readonly reason?: string };
      };
      const stream = streams.get(params.subscriptionId);
      if (stream === undefined) return;
      if (params.view !== undefined) {
        stream.base = params.view as ItemBoundedSessionView;
        // Before the answer the view waits here; the answer is made from the newest one.
        if (stream.copy === undefined) return;
        try {
          stream.pending = shown(stream, stream.base);
          flush(stream);
        } catch (error: unknown) {
          // A view the contract cannot carry would leave the client stale without knowing.
          fail(stream, error);
        }
      } else if (params.status?.state === 'closed' && params.status.reason !== 'client') {
        end(stream, params.status.reason ?? 'unavailable');
      }
    },
    drained() {
      for (const stream of streams.values()) flush(stream);
    },
    close() {
      streams.clear();
      workflowStreams.clear();
    },
  };
}

/** The Session's newest workflows, as many as its view carries. */
function sessionWorkflows(listed: readonly RuntimeWorkflowSummary[]): readonly Readonly<Record<string, unknown>>[] {
  return [...listed].sort((left, right) => right.startedAt - left.startedAt).slice(0, VIEW_WORKFLOWS).map(toWorkflow);
}

/** A v1 workflow summary in v2 terms. */
export function toWorkflow(summary: RuntimeWorkflowSummary): Readonly<Record<string, unknown>> {
  const { runId, workflow, totalSpawned, updatedAt, ...facts } = summary;
  return { ...facts, id: runId, name: workflow, spawnedAgents: totalSpawned, updatedAt: utcMilliseconds(updatedAt) };
}

/**
 * A v1 view in v2 terms. Host paths stay in; the contract of the connection's
 * role decides whether they are sent. `workspaceRoot` is the Host workspace
 * the Session's `project` is named inside. `workflows` are the Session's, in v2
 * terms; v1 keeps them out of its view.
 */
export function toSessionView(
  view: ClientSessionView, workspaceRoot?: string, workflows: readonly unknown[] = [],
): Readonly<Record<string, unknown>> {
  const streaming = new Set(view.runs.filter(run => STREAMING_RUN_PHASES.has(run.phase)).map(run => run.runId));
  const seen = new Map<string, number>();
  return {
    items: view.items.map((item) => {
      // Display history saved by old builds can repeat an id; a client's copy is keyed by it.
      const repeats = seen.get(item.id) ?? 0;
      seen.set(item.id, repeats + 1);
      return toViewItem(item, repeats === 0 ? item.id : `${item.id}~${repeats}`, streaming);
    }),
    session: toSessionResource(view.session, workspaceRoot !== undefined && view.session.workspaceRoot !== undefined
      ? within(workspaceRoot, view.session.workspaceRoot) : undefined),
    runs: view.runs.map(({ runId, ...run }) => ({ ...run, id: runId })),
    queue: view.queue.map(({ inputId, ...input }) => ({ ...input, id: inputId })),
    interactions: view.interactions.map(toInteraction),
    settings: view.settings,
    activity: view.activity,
    contextBudget: view.contextBudget,
    parentContextTokens: view.parentContextTokens,
    sandbox: view.sandbox,
    workflows,
  };
}

/** A v1 Session in v2 terms. `project` names where it works inside the Host workspace, when it does. */
export function toSessionResource(session: ClientSession, project: string | undefined): Readonly<Record<string, unknown>> {
  const { msgCount, metadataRevision, createdAt, lastMessageAt, recovery, ...facts } = session;
  return {
    ...facts,
    archived: session.archived === true,
    project,
    messageCount: msgCount,
    revision: metadataRevision,
    createdAt: utcMilliseconds(createdAt),
    lastMessageAt: utcMilliseconds(lastMessageAt),
    recovery: recovery && { ...recovery, since: utcMilliseconds(recovery.since) },
  };
}

export function utcMilliseconds(time: string | undefined): number | undefined {
  const milliseconds = time === undefined ? Number.NaN : Date.parse(time);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

/** A pending question or approval in v2 terms. */
export function toInteraction(interaction: ClientInteraction): Readonly<Record<string, unknown>> {
  return {
    id: interaction.requestId,
    sessionId: interaction.sessionId,
    runId: interaction.runId,
    createdAt: Date.parse(interaction.createdAt),
    expiresAt: interaction.expiresAt === undefined ? undefined : Date.parse(interaction.expiresAt),
    kind: interaction.kind,
    request: interaction.options,
  };
}

/**
 * A v1 item in v2 terms. `streaming` names the Runs that may still write; without
 * it the item comes from saved history, where nothing changes any more.
 */
export function toViewItem(
  item: ClientViewItem, id: string = item.id, streaming?: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  const { tool } = item;
  const notice = noticeKind(item.icon);
  // A draft outlives an interrupted Run, so being a draft alone does not make an item live.
  const live = streaming !== undefined && (tool !== undefined
    ? tool.status === 'running' || tool.status === 'awaiting_approval'
    : item.outputState === 'draft' && item.sourceRunId !== undefined && streaming.has(item.sourceRunId));
  return {
    id,
    type: item.type,
    state: live ? 'live' : 'settled',
    text: item.text,
    textTotal: item.totalTextLength,
    at: wholeNumber(item.timestamp),
    runId: item.sourceRunId,
    inputIds: item.inputIds ?? (item.inputId !== undefined ? [item.inputId] : undefined),
    attachments: item.attachments?.map((attachment, index) => ({ ...attachment, blobId: attachmentBlobId(item.id, index) })),
    tool: tool === undefined ? undefined : {
      callId: tool.callId,
      name: tool.name,
      status: tool.status,
      inputText: tool.inputText,
      inputTotal: tool.totalInputLength,
      outputSaved: tool.outputPath !== undefined ? true : undefined,
      progress: tool.progress,
      startedAt: wholeNumber(tool.startedAt),
      endedAt: wholeNumber(tool.endedAt),
    },
    notice: notice === undefined ? undefined : { kind: notice },
  };
}

/**
 * Names an item's attachment for `blob.read`. It holds the item v1 knows and the
 * attachment's place in it, so reading it goes through v1 like any item read.
 */
export function attachmentBlobId(itemId: string, index: number): string {
  return `a_${Buffer.from(JSON.stringify([itemId, index])).toString('base64url')}`;
}

/** The item and place an attachment's blobId names. Undefined for any other blobId. */
export function parseAttachmentBlobId(blobId: string): { readonly itemId: string; readonly index: number } | undefined {
  if (!blobId.startsWith('a_')) return undefined;
  let named: unknown;
  try {
    named = JSON.parse(Buffer.from(blobId.slice(2), 'base64url').toString('utf8'));
  } catch {
    // Not one this Host made; the caller reports it as no such blob.
    return undefined;
  }
  if (!Array.isArray(named) || named.length !== 2) return undefined;
  const [itemId, index] = named as [unknown, unknown];
  return typeof itemId === 'string' && Number.isSafeInteger(index) && (index as number) >= 0
    ? { itemId, index: index as number } : undefined;
}

/** Times reach the view from several clocks; one that is not a number is left out. */
function wholeNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}
