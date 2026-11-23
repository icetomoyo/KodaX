/**
 * The REPL's session commands, goal and compaction over a v2 Host. The REPL
 * names them in v1 terms; each one here is the v2 call that does the same.
 */
import type { KodaXGoalState } from '@kodax-ai/agent';
import type {
  ClientLineageEntry,
  ClientLineageSummary,
  ClientSessionFilter,
  ClientSessionSettings,
  ClientSessionSummary,
} from '@kodax-ai/coding/client-contract';
import type { SessionCommandBinding, SessionCompactBinding, SessionGoalBinding } from '@kodax-ai/repl';

import { HostProtocolError } from '../host-protocol/codec.js';
import { createRequestId, type HostCallResult, type KodaXHostClient } from '../host-protocol/host-client.js';
import type { ReplLeases } from './leases.js';
import { toClientSession } from './view.js';

type HostGoal = NonNullable<HostCallResult<'session.goal.get', 'local'>['goal']>;
type HostTreeEntry = HostCallResult<'session.lineage.get', 'local'>['items'][number];

/** The most a v2 Host lists or reads of a tree in one call. */
const LIST_PAGE = 200;
const TREE_PAGE = 1_000;
/** What v1 listed when the REPL named no limit. */
const DEFAULT_LIST_LIMIT = 50;
/**
 * How often `/rewind` names the newest turn. A Run's memory review writes the
 * Session for a while after the Run ends, which makes a named turn stale.
 */
const REWIND_ATTEMPTS = 3;

/** v2 refuses an entry no tree entry matches with `conflict`, the same code it gives a running Session. */
function noSuchEntry(error: unknown): boolean {
  return error instanceof HostProtocolError && error.kodaxCode === 'conflict' && error.reason === 'entry_not_found';
}

/** The Session changed after the turn was named; the turn must be named again. */
function staleTurn(error: unknown): boolean {
  return error instanceof HostProtocolError && error.kodaxCode === 'resync_required';
}

/** v2 takes no blank text, where v1 read blank as absent. */
function text(value: string | undefined): string | undefined {
  return value !== undefined && /\S/.test(value) ? value : undefined;
}

function toLineageEntry({ parentId, createdAt, type, role, ...entry }: HostTreeEntry): ClientLineageEntry {
  return {
    ...entry,
    parentId: parentId ?? null,
    type: type as ClientLineageEntry['type'],
    timestamp: createdAt !== undefined ? new Date(createdAt).toISOString() : '',
    ...(role !== undefined ? { role: role as NonNullable<ClientLineageEntry['role']> } : {}),
  };
}

function toGoalState({ tokenBudget, blocker, ...goal }: HostGoal): KodaXGoalState {
  // v2 does not count how many turns in a row reported the blocker; the REPL shows only its kind.
  return { ...goal, version: 1, tokenBudget: tokenBudget ?? null, lastBlockerKind: blocker ?? null, blockerTurnCount: 0 };
}

export interface ReplSessionBindings {
  readonly sessions: SessionCommandBinding;
  readonly goal: SessionGoalBinding;
  readonly compact: SessionCompactBinding;
}

export function createReplSessionBindings(client: KodaXHostClient<'local'>, leases: ReplLeases): ReplSessionBindings {
  const fresh = (): { readonly requestId: string } => ({ requestId: createRequestId() });

  async function list(filter: ClientSessionFilter = {}): Promise<readonly ClientSessionSummary[]> {
    if (filter.scope !== undefined && filter.scope !== 'user') throw new Error('A v2 Host lists the Sessions people use, not task workers.');
    if (filter.before !== undefined) throw new Error('A v2 Host pages Sessions by cursor, not by time.');
    const wanted = filter.limit ?? DEFAULT_LIST_LIMIT;
    const found: ClientSessionSummary[] = [];
    let cursor = filter.cursor;
    do {
      const page = await client.call('session.list', {
        ...(filter.projectRoot !== undefined ? { projectRoot: filter.projectRoot } : {}),
        ...(filter.includeArchived !== undefined ? { includeArchived: filter.includeArchived } : {}),
        ...(filter.tag !== undefined ? { tag: filter.tag } : {}),
        ...(filter.surface !== undefined ? { surface: filter.surface } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        limit: Math.min(LIST_PAGE, wanted - found.length),
      });
      for (const session of page.items) found.push({ ...toClientSession(session), msgCount: session.messageCount ?? 0 });
      cursor = page.nextCursor;
    } while (cursor !== undefined && found.length < wanted);
    return found;
  }

  async function readLineage(sessionId: string): Promise<ClientLineageSummary | null> {
    const entries: ClientLineageEntry[] = [];
    let cursor: string | undefined;
    let activeEntryId: string | undefined;
    do {
      const page = await client.call('session.lineage.get', { sessionId, limit: TREE_PAGE, ...(cursor !== undefined ? { cursor } : {}) });
      entries.push(...page.items.map(toLineageEntry));
      activeEntryId = page.activeEntryId;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return entries.length === 0 && activeEntryId === undefined ? null : { activeEntryId: activeEntryId ?? null, entries };
  }

  /** Runs `change` and reads an entry no tree entry matches as `false`. */
  async function onEntry(change: () => Promise<unknown>): Promise<boolean> {
    try {
      await change();
      return true;
    } catch (error: unknown) {
      if (noSuchEntry(error)) return false;
      throw error;
    }
  }

  const sessions: SessionCommandBinding = {
    list,
    read: async sessionId => toClientSession((await client.call('session.get', { sessionId })).session),
    getSettings: async sessionId => (await client.call('session.settings.get', { sessionId })).settings as ClientSessionSettings,
    readLineage,
    async delete(sessionId) {
      await client.call('session.delete', { ...fresh(), sessionId });
    },
    async deleteAll({ gitRoot }) {
      // Listed in full first: deleting while paging would move the cursor's ground.
      const all = await list({ ...(gitRoot !== undefined ? { projectRoot: gitRoot } : {}), limit: Number.MAX_SAFE_INTEGER });
      for (const session of all) await client.call('session.delete', { ...fresh(), sessionId: session.id });
    },
    async setActiveEntry({ sessionId, selector, summarizeCurrentBranch }) {
      const { activeEntryId } = await client.call('session.lineage.get', { sessionId, limit: 1 });
      // A conversation with no entries yet has none to move to.
      if (activeEntryId === undefined) return false;
      return onEntry(() => client.call('session.branch.select', {
        ...fresh(), sessionId, entry: selector, ifActiveEntryId: activeEntryId,
        ...(summarizeCurrentBranch !== undefined ? { summarize: summarizeCurrentBranch } : {}),
      }));
    },
    setLabel: ({ sessionId, selector, label }) => onEntry(() => client.call('session.lineage.label', {
      ...fresh(), sessionId, entry: selector, ...(text(label) !== undefined ? { label } : {}),
    })),
    fork: async ({ sessionId, selector }) => (await client.call('session.fork', {
      ...fresh(), sessionId, ...(selector !== undefined ? { entry: selector } : {}),
    })).session.id,
    async rewind({ sessionId, selector, expectedHead }) {
      if (selector === undefined) {
        // Without a place named, the REPL takes back the newest turn: the conversation goes back to the end of the one before.
        for (let attempt = 1; ; attempt += 1) {
          const { turn } = await client.call('history.resolveTurn', { sessionId, turn: { kind: 'previous' } });
          if (turn === undefined) return false;
          try {
            await client.call('session.rewind', { ...fresh(), sessionId, turn: turn.ref });
            return true;
          } catch (error: unknown) {
            if (attempt >= REWIND_ATTEMPTS || !staleTurn(error)) throw error;
          }
        }
      }
      const head = expectedHead !== undefined ? expectedHead : (await readLineage(sessionId))?.activeEntryId ?? null;
      if (head === null) return false;
      return onEntry(() => client.call('session.rewind', { ...fresh(), sessionId, entry: selector, ifActiveEntryId: head }));
    },
    recover: async ({ sessionId, reason }) => (await client.call('session.recover', {
      ...fresh(), sessionId, ...(text(reason) !== undefined ? { reason } : {}),
    })).session.id,
    create: async ({ title, gitRoot, projectPath, surface }) => {
      const projectRoot = projectPath ?? gitRoot;
      return (await client.call('session.create', {
        ...fresh(), title, surface, draft: true, ...(projectRoot !== undefined ? { projectRoot } : {}),
      })).session.id;
    },
  };

  const goal: SessionGoalBinding = {
    read: async (sessionId) => {
      const found = (await client.call('session.goal.get', { sessionId })).goal;
      return found === undefined ? null : toGoalState(found);
    },
    create: async ({ sessionId, objective, tokenBudget }) => toGoalState((await client.call('session.goal.create', {
      ...fresh(), sessionId, objective, ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    })).goal),
    pause: async sessionId => toGoalState((await client.call('session.goal.pause', { ...fresh(), sessionId })).goal),
    resume: async sessionId => toGoalState((await client.call('session.goal.resume', { ...fresh(), sessionId })).goal),
    async clear(sessionId) {
      await client.call('session.goal.clear', { ...fresh(), sessionId });
    },
  };

  const compact: SessionCompactBinding = {
    async compact({ sessionId, customInstructions }) {
      const instructions = text(customInstructions);
      const leased = await leases({ kind: 'compaction', input: { sessionId, ...(instructions !== undefined ? { customInstructions: instructions } : {}) } });
      const { compacted, tokensBefore, tokensAfter } = await client.call('session.compact', {
        ...fresh(), sessionId,
        ...(instructions !== undefined ? { instructions } : {}),
        ...(leased !== undefined ? { leases: leased } : {}),
      });
      return { compacted, tokensBefore, tokensAfter };
    },
  };

  return { sessions, goal, compact };
}
