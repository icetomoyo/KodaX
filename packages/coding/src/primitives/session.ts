/**
 * Layer A Primitive: Session / SessionEntry / MessageEntry / SessionExtension
 *
 * FEATURE_081 (v0.7.23): Base Session shape. The thick
 * `KodaXSessionLineage` in `@kodax/agent` is re-expressed as a
 * `LineageExtension` over this base — see `packages/agent/src/extensions/lineage.ts`.
 *
 * Status: @experimental — API shape may be refined during v0.7.x. Will be
 * migrated to `@kodax/core` in FEATURE_082 (v0.7.24).
 *
 * Design intent:
 *   - Base Session is a minimal, linearly-appendable log of typed entries.
 *   - Extensions (lineage, artifacts, labels, compaction) layer on top by
 *     claiming additional `entry.type` values and contributing operators /
 *     reducers that read the entry stream.
 *   - coding preset composes LineageExtension + CompactionExtension +
 *     ArtifactExtension to reproduce today's `KodaXSessionLineage` behavior.
 */

import type { AgentMessage } from './agent.js';

/**
 * A single immutable entry in a Session log. `type` is the dispatch key used
 * by extensions to claim ownership of an entry kind.
 */
export interface SessionEntry {
  readonly id: string;
  readonly ts: number;
  readonly type: string;
  readonly payload: unknown;
}

/**
 * Canonical message entry type. All Layer A consumers can rely on
 * `type: 'message'` entries existing; extensions add more types.
 */
export interface MessageEntry extends SessionEntry {
  readonly type: 'message';
  readonly payload: {
    readonly role: AgentMessage['role'];
    readonly content: AgentMessage['content'];
    readonly synthetic?: boolean;
  };
}

/**
 * Options for forking a session.
 *
 * v0.7.23 exposes only `name` (label for the new fork); structural options
 * (branch-at-entry, shallow copy, etc.) are reserved for FEATURE_082.
 */
export interface SessionForkOptions {
  readonly name?: string;
}

/**
 * Minimal Session interface.
 *
 * Implementations must guarantee:
 *   - `append()` is atomic: either the entry is visible on next `entries()`
 *     iteration or it throws.
 *   - `entries()` yields entries in append order.
 *   - `metadata` is a readonly snapshot; mutations are made via extensions.
 *   - `fork()` returns a new Session with a snapshot of current entries; the
 *     two sessions diverge thereafter.
 */
export interface Session {
  readonly id: string;
  append(entry: SessionEntry): Promise<void>;
  entries(): AsyncIterable<SessionEntry>;
  fork(opts?: SessionForkOptions): Promise<Session>;
  readonly metadata: ReadonlyMap<string, unknown>;
}

/**
 * Extension contract for teaching a Session new entry types + operators +
 * reducers.
 *
 *   - `entryTypes`: which `entry.type` values this extension owns. Two
 *     extensions composed into one Session must not claim overlapping types.
 *   - `operators`: high-level imperative verbs exposed to callers (e.g.
 *     `branch`, `rewind`, `attachArtifact`).
 *   - `reducers`: pure projections over the entry stream (e.g. "build lineage
 *     tree").
 *
 * The exact dispatch mechanics (`ExtendedSession<T>` typing, operator
 * registration) land with the coding preset integration; v0.7.23 pins the
 * shape only.
 */
export interface SessionExtension {
  readonly name: string;
  readonly entryTypes: readonly string[];
  readonly operators?: Readonly<
    Record<string, (session: Session, ...args: readonly unknown[]) => Promise<unknown>>
  >;
  readonly reducers?: Readonly<
    Record<string, (entries: readonly SessionEntry[]) => unknown>
  >;
}

/**
 * Options for `createInMemorySession`.
 */
export interface InMemorySessionOptions {
  readonly id?: string;
  readonly metadata?: ReadonlyMap<string, unknown>;
  readonly initialEntries?: readonly SessionEntry[];
}

let _sessionCounter = 0;
const _nextSessionId = (): string => {
  _sessionCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `session-${Date.now()}-${_sessionCounter}-${rand}`;
};

/**
 * In-memory Session suitable for tests, examples, and embedded SDK use. Not
 * durable across process restarts — persistence is provided by coding-specific
 * adapters in `@kodax/session-lineage` (v0.7.24).
 */
export function createInMemorySession(opts: InMemorySessionOptions = {}): Session {
  const id = opts.id ?? _nextSessionId();
  const metadata = opts.metadata ?? new Map<string, unknown>();
  const entries: SessionEntry[] = opts.initialEntries
    ? opts.initialEntries.map((entry) => ({ ...entry }))
    : [];

  const session: Session = {
    id,
    async append(entry: SessionEntry): Promise<void> {
      entries.push({ ...entry });
    },
    async *entries(): AsyncIterable<SessionEntry> {
      for (const entry of entries.slice()) {
        yield entry;
      }
    },
    async fork(forkOpts?: SessionForkOptions): Promise<Session> {
      const forkedMetadata = new Map(metadata);
      if (forkOpts?.name) {
        forkedMetadata.set('name', forkOpts.name);
      }
      return createInMemorySession({
        metadata: forkedMetadata,
        initialEntries: entries,
      });
    },
    metadata,
  };
  return session;
}
