/**
 * LineageExtension — SessionExtension façade over lineage semantics.
 *
 * FEATURE_081 (v0.7.23): expresses today's `KodaXSessionLineage` operations
 * (label, rewind, compaction ledger, branch summary) as a
 * `SessionExtension` over the base `Session` primitive.
 *
 * FEATURE_082 (v0.7.24): moved from `@kodax/coding/src/extensions/lineage.ts`
 * to this package. Depends on `@kodax/core` for `Session` / `SessionEntry` /
 * `SessionExtension`. `@kodax/coding` keeps a barrel re-export.
 *
 * Scope:
 *   - Declare the extension object.
 *   - Implement `label` and `attachArtifact` operators that append standard
 *     entries to a Session.
 *   - Implement a `buildLineageTree` reducer that projects an entry stream
 *     back to a navigable tree.
 *   - NOT re-implemented here: `branch`, `rewind`, full compaction. Those
 *     stay in `@kodax/agent/session-lineage.ts` for coding-preset use; the
 *     `LineageCompaction` policy in this package is the thin wrapper that
 *     adapts them to the Layer A `CompactionPolicy` contract.
 */

import type { Session, SessionEntry, SessionExtension } from '@kodax/core';

/**
 * Entry types claimed by `LineageExtension`. Mirrors the legacy
 * `KodaXSessionEntry` tagged union plus a `rewind_marker` placeholder (the
 * legacy lineage records rewinds via `activeEntryId` mutation; Session is
 * linear, so a marker entry is the equivalent).
 */
export const LINEAGE_ENTRY_TYPES = Object.freeze([
  'message',
  'label',
  'compaction',
  'branch_summary',
  'archive_marker',
  'rewind_marker',
  'artifact_ledger',
] as const);

export type LineageEntryType = (typeof LINEAGE_ENTRY_TYPES)[number];

/**
 * Payload shape for a `label` entry. Mirrors
 * `KodaXSessionLabelEntry.targetId`/`label` fields on the legacy lineage.
 */
export interface LineageLabelPayload {
  readonly targetId: string;
  readonly label?: string;
}

/**
 * Payload shape for an `artifact_ledger` entry. Mirrors a minimal subset of
 * `KodaXSessionArtifactLedgerEntry`; full semantic fidelity is kept on the
 * legacy side for now and normalised in FEATURE_082.
 */
export interface LineageArtifactLedgerPayload {
  readonly ref: string;
  readonly kind?: string;
  readonly summary?: string;
}

/**
 * Projected tree node. Mirrors the navigation shape of
 * `KodaXSessionTreeNode` from `@kodax/agent/types.ts`, restricted to the
 * fields the base Session can supply.
 */
export interface LineageTreeNode {
  readonly entry: SessionEntry;
  readonly children: LineageTreeNode[];
  readonly label?: string;
}

let _labelCounter = 0;
let _artifactCounter = 0;

const nextId = (prefix: string): string => {
  const counter = prefix === 'label' ? (++_labelCounter) : (++_artifactCounter);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${counter}-${suffix}`;
};

async function appendLabel(
  session: Session,
  targetId: string,
  label?: string,
): Promise<string> {
  const id = nextId('label');
  await session.append({
    id,
    ts: Date.now(),
    type: 'label',
    payload: { targetId, label } satisfies LineageLabelPayload,
  });
  return id;
}

async function appendArtifact(
  session: Session,
  ref: string,
  summary?: string,
): Promise<string> {
  const id = nextId('artifact');
  await session.append({
    id,
    ts: Date.now(),
    type: 'artifact_ledger',
    payload: { ref, summary } satisfies LineageArtifactLedgerPayload,
  });
  return id;
}

/**
 * Build a flat "linear tree" projection. Message entries form the spine;
 * label entries attach to their target by `targetId`. Non-message,
 * non-label entries (compaction / branch_summary / archive_marker /
 * rewind_marker / artifact_ledger) become children of the preceding
 * message on the spine, mirroring how the legacy lineage renders sidecar
 * records. If no message precedes them they become roots.
 */
function buildLineageTree(entries: readonly SessionEntry[]): LineageTreeNode[] {
  const roots: LineageTreeNode[] = [];
  const messageNodesById = new Map<string, LineageTreeNode>();
  const labels: Array<{ targetId: string; label?: string }> = [];

  let lastMessageNode: LineageTreeNode | null = null;
  for (const entry of entries) {
    if (entry.type === 'label') {
      const payload = entry.payload as LineageLabelPayload | undefined;
      if (payload?.targetId) {
        labels.push({ targetId: payload.targetId, label: payload.label });
      }
      continue;
    }
    const node: LineageTreeNode = { entry, children: [] };
    if (entry.type === 'message') {
      roots.push(node);
      messageNodesById.set(entry.id, node);
      lastMessageNode = node;
      continue;
    }
    if (lastMessageNode) {
      lastMessageNode.children.push(node);
    } else {
      roots.push(node);
    }
  }

  for (const { targetId, label } of labels) {
    const node = messageNodesById.get(targetId);
    if (node && label !== undefined) {
      (node as { label?: string }).label = label;
    }
  }

  return roots;
}

/**
 * The exported extension. Operators write standard-shaped entries; the
 * reducer projects an entry stream back to a navigable tree.
 *
 * Immutability: top-level object, `operators`, and `reducers` are all
 * frozen. Freezes are shallow — the functions stored inside `operators`
 * and `reducers` are immutable by nature (closures reference only
 * module-private state). External code must not mutate the extension;
 * doing so is a programmer error that the type-level `readonly` already
 * disallows without a cast.
 */
export const LineageExtension: SessionExtension = Object.freeze({
  name: 'lineage',
  entryTypes: LINEAGE_ENTRY_TYPES,
  operators: Object.freeze({
    label: (async (session, ...args) => {
      const [targetId, label] = args as [string, string | undefined];
      return appendLabel(session, targetId, label);
    }) as (session: Session, ...args: readonly unknown[]) => Promise<unknown>,
    attachArtifact: (async (session, ...args) => {
      const [ref, summary] = args as [string, string | undefined];
      return appendArtifact(session, ref, summary);
    }) as (session: Session, ...args: readonly unknown[]) => Promise<unknown>,
  }),
  reducers: Object.freeze({
    buildLineageTree: (entries: readonly SessionEntry[]) => buildLineageTree(entries),
  }),
});
