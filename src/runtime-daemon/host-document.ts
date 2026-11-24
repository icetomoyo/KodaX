/**
 * Serves v2 subscriptions to the Host document: what a client shows beside
 * its Sessions. The Host reads the whole document again when something it
 * shows may have changed, at most once a second, and sends the client only
 * what differs from its copy.
 */
import { randomUUID } from 'node:crypto';

import { hostRpcNotification, newHostIncident, type HostIncident } from '../host-protocol/codec.js';
import type { HostDocument, LocalHostDocument } from '../host-protocol/view.js';
import { diffSessionView, type SyncItem, type SyncView } from '../host-protocol/view-sync.js';
import type { HostViewSubscription } from './host-view.js';

type Document = SyncView<SyncItem>;

/** Reads go no closer together than this, however often something changes. */
const READ_INTERVAL_MS = 1000;

/** One subscription. A new object each time the id is subscribed, so a late read can tell it was replaced. */
interface Stream {
  readonly subscriptionId: string;
  readonly read: () => Promise<Readonly<Record<string, unknown>>>;
  /** What the client holds and where it stands. Absent until the subscription is answered. */
  copy?: { seq: number; document: Document };
  answered: boolean;
  /** The newest document the client was not sent yet. */
  pending?: Document;
  /** A read is running; `again` asks for one more after it. */
  reading: boolean;
  again: boolean;
  lastRead: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Why the Host ended the subscription before its answer was on the wire. */
  ended?: { readonly reason: string; readonly incidentId?: string };
}

export interface HostDocumentStreamsOptions {
  /** The document contract of the connection: the local one, for the Host's own machine, carries Host paths. */
  readonly contract: typeof HostDocument | typeof LocalHostDocument;
  readonly send: (frame: string) => void;
  /** Whether the link is holding back what was already sent to it. */
  readonly congested: () => boolean;
  /** Starts calling `changed` whenever what the document shows may have changed. Resolves with how to stop. */
  readonly follow: (changed: () => void) => Promise<() => void>;
  readonly onInternalError: (method: string, error: unknown, incident: HostIncident) => void;
}

export interface HostDocumentStreams {
  /** Subscribing under an id already in use replaces that subscription. `read` reads the document as the client may see it. */
  subscribe(subscriptionId: string, read: () => Promise<Readonly<Record<string, unknown>>>): Promise<HostViewSubscription>;
  /** Succeeds whether or not the subscription exists. */
  unsubscribe(subscriptionId: string): void;
  /** Something this connection did may show in its documents. */
  changed(): void;
  /** The link can take frames again. */
  drained(): void;
  close(): void;
}

export function createHostDocumentStreams(options: HostDocumentStreamsOptions): HostDocumentStreams {
  const streams = new Map<string, Stream>();
  // There are no items, so nothing a client keeps can go stale with the Host's ids: one epoch serves every subscription.
  const epoch = randomUUID();
  let following: Promise<() => void> | undefined;

  const notify = (method: string, params: Readonly<Record<string, unknown>>): void => {
    options.send(JSON.stringify(hostRpcNotification(method, params)));
  };
  const parse = (document: Readonly<Record<string, unknown>>): Document => options.contract.parse(document) as Document;
  const flush = (stream: Stream): void => {
    const { copy, pending } = stream;
    if (copy === undefined || pending === undefined || !stream.answered || options.congested()) return;
    stream.pending = undefined;
    const ops = diffSessionView(copy.document, pending);
    if (ops.length === 0) return;
    copy.seq += 1;
    copy.document = pending;
    notify('view.patch', { subscriptionId: stream.subscriptionId, epoch, seq: copy.seq, ops });
  };
  const release = (stream: Stream): void => {
    clearTimeout(stream.timer);
    if (streams.get(stream.subscriptionId) === stream) streams.delete(stream.subscriptionId);
    if (streams.size === 0) stopFollowing();
  };
  /** A document that cannot be read or sent ends the subscription, so the client is not left stale without knowing. */
  const fail = (stream: Stream, error: unknown): void => {
    const incident = newHostIncident();
    options.onInternalError('view.subscribe', error, incident);
    if (streams.get(stream.subscriptionId) !== stream) return;
    release(stream);
    const closed = { reason: 'internal', incidentId: incident.incidentId };
    if (stream.answered) notify('view.closed', { subscriptionId: stream.subscriptionId, ...closed });
    else stream.ended = closed;
  };
  /** Reads the document again, no sooner than a second after the last read. Changes during a read cost one more read. */
  const refresh = (stream: Stream): void => {
    if (streams.get(stream.subscriptionId) !== stream) return;
    if (stream.reading) {
      stream.again = true;
      return;
    }
    const wait = stream.lastRead + READ_INTERVAL_MS - Date.now();
    if (wait > 0) {
      stream.timer ??= setTimeout(() => {
        stream.timer = undefined;
        refresh(stream);
      }, wait);
      stream.timer.unref?.();
      return;
    }
    stream.reading = true;
    stream.again = false;
    stream.lastRead = Date.now();
    void stream.read()
      .then((document) => {
        if (streams.get(stream.subscriptionId) !== stream) return;
        stream.pending = parse(document);
        flush(stream);
      })
      .catch((error: unknown) => fail(stream, error))
      .finally(() => {
        stream.reading = false;
        if (stream.again) refresh(stream);
      });
  };
  const changed = (): void => {
    for (const stream of streams.values()) refresh(stream);
  };
  const stopFollowing = (): void => {
    const stopping = following;
    following = undefined;
    void stopping?.then(stop => stop(), () => undefined);
  };

  return {
    async subscribe(subscriptionId, read) {
      const previous = streams.get(subscriptionId);
      const stream: Stream = { subscriptionId, read, answered: false, reading: true, again: false, lastRead: Date.now() };
      streams.set(subscriptionId, stream);
      if (previous !== undefined) release(previous);
      try {
        // Followed before the first read, so no change falls between the two.
        if (following === undefined) {
          const started = options.follow(changed);
          following = started;
          // The subscription that started it fails with the error; the next one tries again.
          started.catch(() => { if (following === started) following = undefined; });
        }
        await following;
        const document = parse(await read());
        stream.copy = { seq: 0, document };
      } catch (error: unknown) {
        release(stream);
        throw error;
      } finally {
        stream.reading = false;
      }
      return {
        answer: { subscriptionId, epoch, seq: 0, snapshot: stream.copy.document },
        answered: () => {
          if (stream.ended !== undefined) {
            notify('view.closed', { subscriptionId, ...stream.ended });
            return;
          }
          stream.answered = true;
          flush(stream);
          if (stream.again) refresh(stream);
        },
      };
    },
    unsubscribe(subscriptionId) {
      const stream = streams.get(subscriptionId);
      if (stream !== undefined) release(stream);
    },
    changed,
    drained() {
      for (const stream of streams.values()) flush(stream);
    },
    close() {
      for (const stream of streams.values()) clearTimeout(stream.timer);
      streams.clear();
      stopFollowing();
    },
  };
}
