/**
 * The REPL's Learning Center over a v2 Host. v2 answers what happened to the
 * learned capabilities when asked, so the binding asks again at an interval
 * where v1 pushed each event.
 */
import type { LearningEvent } from '@kodax-ai/agent';
import type { LearningBinding, LearningCapabilityView } from '@kodax-ai/repl';

import { createRequestId, type HostCallResult, type KodaXHostClient } from '../host-protocol/host-client.js';

type HostCapability = HostCallResult<'learning.get', 'local'>['capability'];
type HostLearningEvent = HostCallResult<'learning.events', 'local'>['items'][number];

/**
 * How often the binding asks for new events. Capabilities change when a Session
 * ends and its learning review runs, so a notice a few seconds late is not missed.
 */
const POLL_MS = 5_000;

/** The fields the REPL reads, under their v1 names. v2 sends no `source`, so it stays absent. */
function toCapability({ id, name, slug, carrier, lifecycle }: HostCapability): LearningCapabilityView {
  return {
    capabilityId: id,
    displayName: name,
    slug,
    carrier: carrier as LearningCapabilityView['carrier'],
    lifecycle: lifecycle as LearningCapabilityView['lifecycle'],
  };
}

function toEvent({ id, name, createdAt, ...event }: HostLearningEvent): LearningEvent {
  return {
    ...event,
    schemaVersion: 1,
    eventId: id,
    displayName: name,
    kind: event.kind as LearningEvent['kind'],
    lifecycle: event.lifecycle as LearningEvent['lifecycle'],
    carrier: event.carrier as LearningEvent['carrier'],
    createdAt: new Date(createdAt).toISOString(),
  };
}

export function createReplLearning(client: KodaXHostClient<'local'>, pollMs = POLL_MS): LearningBinding {
  const decide = (method: 'learning.acknowledge' | 'learning.reject' | 'learning.disable' | 'learning.rollback' | 'learning.review' | 'learning.trust') =>
    async (nameOrSlug: string): Promise<void> => {
      await client.call(method, { requestId: createRequestId(), nameOrSlug });
    };
  return {
    getSnapshot: () => client.call('learning.snapshot', {}),
    async list(query) {
      const page = await client.call('learning.list', {
        ...(query?.search !== undefined ? { search: query.search } : {}),
        ...(query?.carrier !== undefined ? { carrier: query.carrier } : {}),
        ...(query?.lifecycle !== undefined ? { lifecycle: query.lifecycle } : {}),
        ...(query?.limit !== undefined ? { limit: Math.min(query.limit, 200) } : {}),
        ...(query?.cursor !== undefined ? { cursor: query.cursor } : {}),
      });
      return {
        items: page.items.map(toCapability), revision: page.revision,
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      };
    },
    get: async nameOrSlug => toCapability((await client.call('learning.get', { nameOrSlug })).capability),
    subscribe(listener, options, onError) {
      let after = options?.afterRevision;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let open = true;
      const poll = async (): Promise<void> => {
        const { items } = await client.call('learning.events', after !== undefined ? { afterRevision: after } : {});
        for (const event of items) {
          if (!open) return;
          after = Math.max(after ?? 0, event.sequence);
          listener(toEvent(event));
        }
      };
      const next = (): void => {
        if (!open) return;
        timer = setTimeout(() => {
          poll().then(next, (error: unknown) => {
            // The REPL reopens the subscription after an error, from the newest event it showed.
            if (open) onError?.(error);
          });
        }, pollMs);
        timer.unref?.();
      };
      const ready = poll().then(next);
      ready.catch((error: unknown) => { if (open) onError?.(error); });
      return {
        ready,
        close() {
          open = false;
          if (timer !== undefined) clearTimeout(timer);
        },
      };
    },
    acknowledge: decide('learning.acknowledge'),
    async snooze(nameOrSlug, until) {
      await client.call('learning.snooze', { requestId: createRequestId(), nameOrSlug, until: Date.parse(until) });
    },
    reject: decide('learning.reject'),
    disable: decide('learning.disable'),
    rollback: decide('learning.rollback'),
    async promote(nameOrSlug, scope) {
      await client.call('learning.promote', { requestId: createRequestId(), nameOrSlug, scope });
    },
    review: decide('learning.review'),
    trust: decide('learning.trust'),
  };
}
