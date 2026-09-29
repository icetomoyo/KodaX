/**
 * Read-only recovery of legacy adjacent-only tool-pairing damage.
 *
 * Before the managed-context fix, `validateAndFixToolHistory` paired a tool_use
 * only with the IMMEDIATELY following message. A managed-run-context message
 * inserted between `assistant(tool_use...)` and `user(tool_result...)` made the
 * pair look orphaned, and the stripped copy was persisted as a new active
 * branch below the retained compaction copy.
 *
 * A damaged path entry is restored only when the proof is complete: a unique,
 * closed, explicit retained sibling chain was written first, and replaying the
 * frozen legacy transform over that chain reproduces the damaged branch exactly,
 * including the managed context between the pair. Anything else fails closed.
 * Nothing here writes lineage; callers render the proven content instead.
 */
import type { KodaXContentBlock, KodaXMessage } from '@kodax-ai/llm';
import type { KodaXSessionEntry, KodaXSessionMessageEntry } from '../index.js';

export interface LegacyToolPairingLookup {
  byId(id: string): KodaXSessionEntry | undefined;
  /** Navigable children in append order; side-state entries are excluded. */
  children(parentId: string): readonly KodaXSessionEntry[];
  /** Append position in `lineage.entries`, or -1 when unknown. */
  appendIndex(id: string): number;
}

export interface LegacyToolPairingRestoration {
  readonly message: KodaXMessage;
  /** Retained sibling entry whose content proves the restoration. */
  readonly evidenceEntryId: string;
  readonly logicalId: string;
  readonly sourceEntryId: string;
}

interface EvidenceStep {
  readonly member: KodaXSessionMessageEntry;
  /** Managed context the chain carried between the previous step and this one. */
  readonly contextBefore: readonly KodaXMessage[];
  /** Legacy adjacent-only projection of `member` inside its own chain. */
  readonly projected: KodaXMessage;
}

const MAX_EVIDENCE_CHAIN = 64;
const MAX_CONTEXT_BRIDGE = 8;
const INDEX_CHECKPOINT_INTERVAL = 256;
// Mirrors kodax-session-lineage `isNavigableEntry`: side-state never joins a thread.
const SIDE_STATE_TYPES: ReadonlySet<string> = new Set([
  'label',
  'goal',
  'client_notice',
  'memory_outcome_digest',
  'memory_review_receipt',
  'rewind_marker',
]);
const NO_RESTORATIONS: ReadonlyMap<string, LegacyToolPairingRestoration> = new Map();
const restoredMessages = new WeakMap<
  KodaXSessionEntry,
  { readonly content: KodaXMessage['content']; readonly message: KodaXMessage }
>();
/**
 * Index the lineage lazily: paths without a damaged candidate never pay for it,
 * and one lookup can be shared by every path of a single projection.
 */
export function createLegacyToolPairingLookup(
  entries: readonly KodaXSessionEntry[],
  checkpoint?: () => void,
): LegacyToolPairingLookup {
  let index: {
    byId: Map<string, KodaXSessionEntry>;
    children: Map<string, KodaXSessionEntry[]>;
    order: Map<string, number>;
  } | undefined;
  const built = () => {
    if (index) return index;
    const byId = new Map<string, KodaXSessionEntry>();
    const children = new Map<string, KodaXSessionEntry[]>();
    const order = new Map<string, number>();
    for (let position = 0; position < entries.length; position += 1) {
      if (position > 0 && position % INDEX_CHECKPOINT_INTERVAL === 0) checkpoint?.();
      const entry = entries[position]!;
      byId.set(entry.id, entry);
      order.set(entry.id, position);
      if (SIDE_STATE_TYPES.has(entry.type) || entry.parentId === null) continue;
      const bucket = children.get(entry.parentId);
      if (bucket) bucket.push(entry);
      else children.set(entry.parentId, [entry]);
    }
    index = { byId, children, order };
    return index;
  };
  return {
    byId: (id) => built().byId.get(id),
    children: (parentId) => built().children.get(parentId) ?? [],
    appendIndex: (id) => built().order.get(id) ?? -1,
  };
}

function isExplicitCopy(entry: KodaXSessionEntry): boolean {
  // sourceEntryId first: plain entries then never read logicalId at all.
  return (entry.sourceEntryId !== undefined && entry.sourceEntryId !== entry.id)
    || (entry.logicalId !== undefined && entry.logicalId !== entry.id);
}

function isManagedContext(message: KodaXMessage): boolean {
  return message._source === 'managed-run-context'
    || message._source === 'managed-runtime-context';
}

function asMessageEntry(
  entry: KodaXSessionEntry | undefined,
): KodaXSessionMessageEntry | undefined {
  return entry?.type === 'message' ? entry : undefined;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const fields = Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sameMessage(left: KodaXMessage, right: KodaXMessage): boolean {
  return left === right || canonicalJson(left) === canonicalJson(right);
}
function blockType(block: unknown): string | undefined {
  return block !== null && typeof block === 'object' && 'type' in block
    ? String((block as { type: unknown }).type)
    : undefined;
}

function isUsableId(id: unknown): id is string {
  return typeof id === 'string' && id.trim() !== '';
}

function blockIds(
  message: KodaXMessage | undefined,
  role: KodaXMessage['role'],
  type: 'tool_use' | 'tool_result',
  field: 'id' | 'tool_use_id',
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (message?.role !== role || !Array.isArray(message.content)) return ids;
  for (const block of message.content) {
    const id = blockType(block) === type
      ? (block as { id?: unknown; tool_use_id?: unknown })[field]
      : undefined;
    if (typeof id === 'string' && id) ids.add(id);
  }
  return ids;
}

function hasSubstantiveBlock(content: readonly KodaXContentBlock[]): boolean {
  return content.some((block) => {
    const type = blockType(block);
    if (type === undefined) return false;
    if (type === 'text') return !!(block as { text?: string }).text;
    if (type === 'thinking') return !!(block as { thinking?: string }).thinking;
    return true;
  });
}

/**
 * Frozen copy of the pre-fix adjacent-only `validateAndFixToolHistory` rule for
 * one message. It must stay byte-compatible with what legacy builds persisted;
 * never "fix" it alongside the live cleanup.
 */
export function legacyAdjacentToolPairingProjection(
  message: KodaXMessage,
  previous?: KodaXMessage,
  next?: KodaXMessage,
): KodaXMessage {
  if (!Array.isArray(message.content)) return message;
  let kept: KodaXContentBlock[] = [...message.content];
  if (message.role === 'assistant') {
    const results = blockIds(next, 'user', 'tool_result', 'tool_use_id');
    kept = kept.filter((block) =>
      blockType(block) !== 'tool_use'
      || (isUsableId((block as { id?: unknown }).id) && results.has((block as { id: string }).id)));
  } else if (message.role === 'user') {
    const uses = blockIds(previous, 'assistant', 'tool_use', 'id');
    kept = kept.filter((block) =>
      blockType(block) !== 'tool_result'
      || (isUsableId((block as { tool_use_id?: unknown }).tool_use_id)
        && uses.has((block as { tool_use_id: string }).tool_use_id)));
  }
  if (kept.length === 0 || (message.role === 'assistant' && !hasSubstantiveBlock(kept))) {
    return { ...message, content: [{ type: 'text', text: '' }] };
  }
  return { ...message, content: kept };
}
/**
 * The damage can only sit on the first live (non-copy) message after the
 * retained copies of a compaction root; it is found without the index.
 */
function firstDamagedCandidateIndex(path: readonly KodaXSessionEntry[]): number {
  const root = path[0];
  if (root?.type !== 'compaction' || root.reason === 'rewind' || !root.firstKeptEntryId) {
    return -1;
  }
  let index = 1;
  while (path[index]?.type === 'archive_marker') index += 1;
  if (path[index]?.id !== root.firstKeptEntryId) return -1;
  for (; index < path.length; index += 1) {
    const entry = path[index]!;
    if (entry.type === 'archive_marker') continue;
    if (entry.type !== 'message') return -1;
    if (isManagedContext(entry.message) || isExplicitCopy(entry)) continue;
    return Array.isArray(entry.message.content) ? index : -1;
  }
  return -1;
}

/**
 * The retained evidence is the damaged entry's only earlier sibling: an explicit
 * copy chain that no live message had continued when the damage was written.
 * Branches appended after the damage cannot change that proof, so they are
 * ignored; this keeps a proven restoration stable while other branches grow.
 */
function retainedEvidenceChain(
  anchor: KodaXSessionMessageEntry,
  damagedId: string,
  lookup: LegacyToolPairingLookup,
): KodaXSessionMessageEntry[] | undefined {
  const cutoff = lookup.appendIndex(damagedId);
  const writtenBefore = (entry: KodaXSessionEntry) => {
    const position = lookup.appendIndex(entry.id);
    return position >= 0 && position < cutoff;
  };
  const siblings = lookup.children(anchor.id).filter(writtenBefore);
  const first = asMessageEntry(siblings.length === 1 ? siblings[0] : undefined);
  if (!first || !isExplicitCopy(first) || isManagedContext(first.message)) return undefined;
  const chain = [first];
  for (;;) {
    const children = lookup.children(chain[chain.length - 1]!.id).filter(writtenBefore);
    if (children.length === 0) return chain;
    const child = asMessageEntry(children.length === 1 ? children[0] : undefined);
    if (!child || chain.length >= MAX_EVIDENCE_CHAIN) return undefined;
    chain.push(child);
  }
}

/** Replay the legacy transform over the chain exactly as it was sent. */
function evidenceSteps(
  anchor: KodaXSessionMessageEntry,
  chain: readonly KodaXSessionMessageEntry[],
): EvidenceStep[] | undefined {
  const steps: EvidenceStep[] = [];
  let contextBefore: KodaXMessage[] = [];
  let previous = anchor.message;
  for (let index = 0; index < chain.length; index += 1) {
    const member = chain[index]!;
    if (isManagedContext(member.message)) {
      contextBefore.push(member.message);
    } else {
      if (!isExplicitCopy(member)) return undefined;
      const projected = legacyAdjacentToolPairingProjection(
        member.message,
        previous,
        chain[index + 1]?.message,
      );
      steps.push({ member, contextBefore, projected });
      contextBefore = [];
    }
    previous = member.message;
  }
  return steps;
}
/** Ordinary path messages from the candidate on; managed context is skipped. */
function damagedPathSlots(
  path: readonly KodaXSessionEntry[],
  startIndex: number,
  limit: number,
): KodaXSessionMessageEntry[] {
  const slots: KodaXSessionMessageEntry[] = [];
  for (let index = startIndex; index < path.length && slots.length < limit; index += 1) {
    const entry = path[index]!;
    if (entry.type === 'archive_marker') continue;
    if (entry.type !== 'message') break;
    if (!isManagedContext(entry.message)) slots.push(entry);
  }
  return slots;
}

/**
 * A later path copy points back at the damaged original; a live slot is its
 * own original. The copy must be an unambiguous, content-equal alias.
 */
function damagedOriginalFor(
  slot: KodaXSessionMessageEntry,
  lookup: LegacyToolPairingLookup,
): KodaXSessionMessageEntry | undefined {
  if (!isExplicitCopy(slot)) return slot;
  const keys = new Set([slot.sourceEntryId, slot.logicalId]);
  keys.delete(undefined);
  keys.delete(slot.id);
  if (keys.size !== 1) return undefined;
  const original = asMessageEntry(lookup.byId(keys.values().next().value!));
  if (!original || isExplicitCopy(original) || isManagedContext(original.message)) return undefined;
  return sameMessage(original.message, slot.message) ? original : undefined;
}

/** The damaged original must sit below the previous one with the same context. */
function contextBridgeMatches(
  damaged: KodaXSessionMessageEntry,
  previousDamagedId: string,
  contextBefore: readonly KodaXMessage[],
  lookup: LegacyToolPairingLookup,
): boolean {
  const bridged: KodaXMessage[] = [];
  let parentId = damaged.parentId;
  while (parentId !== previousDamagedId) {
    const parent = asMessageEntry(parentId === null ? undefined : lookup.byId(parentId));
    if (!parent || !isManagedContext(parent.message) || bridged.length >= MAX_CONTEXT_BRIDGE) {
      return false;
    }
    bridged.unshift(parent.message);
    parentId = parent.parentId;
  }
  return bridged.length === contextBefore.length
    && bridged.every((message, index) => sameMessage(message, contextBefore[index]!));
}
function restorationFor(
  slot: KodaXSessionMessageEntry,
  evidence: KodaXSessionMessageEntry,
): LegacyToolPairingRestoration {
  // Only content is restored; the slot's own envelope (role, turn, source) stays.
  const cached = restoredMessages.get(slot);
  const message = cached?.content === evidence.message.content
    ? cached.message
    : { ...slot.message, content: evidence.message.content };
  restoredMessages.set(slot, { content: evidence.message.content, message });
  return {
    message,
    evidenceEntryId: evidence.id,
    logicalId: evidence.logicalId !== undefined && evidence.logicalId !== evidence.id
      ? evidence.logicalId
      : evidence.sourceEntryId!,
    sourceEntryId: evidence.sourceEntryId !== undefined && evidence.sourceEntryId !== evidence.id
      ? evidence.sourceEntryId
      : evidence.logicalId!,
  };
}

/**
 * Every step must replay exactly; one mismatch discards the whole chain. The
 * caller only passes paths that cover every step, so appending to a path can
 * never revoke a restoration it already rendered.
 */
function matchDamagedChain(
  steps: readonly EvidenceStep[],
  slots: readonly KodaXSessionMessageEntry[],
  anchorId: string,
  lookup: LegacyToolPairingLookup,
): Map<string, LegacyToolPairingRestoration> | undefined {
  const restorations = new Map<string, LegacyToolPairingRestoration>();
  let previousDamagedId = anchorId;
  for (let index = 0; index < slots.length; index += 1) {
    const step = steps[index]!;
    const slot = slots[index]!;
    const damaged = damagedOriginalFor(slot, lookup);
    if (
      !damaged
      || lookup.appendIndex(step.member.id) < 0
      || lookup.appendIndex(step.member.id) >= lookup.appendIndex(damaged.id)
      || !contextBridgeMatches(damaged, previousDamagedId, step.contextBefore, lookup)
      || !sameMessage(damaged.message, step.projected)
    ) {
      return undefined;
    }
    if (!sameMessage(step.projected, step.member.message)) {
      restorations.set(slot.id, restorationFor(slot, step.member));
    }
    previousDamagedId = damaged.id;
  }
  return restorations;
}

/**
 * Restorations for one navigable path, keyed by path entry id. Branch-isolated:
 * the result depends only on this path and the evidence that sits beside it.
 */
export function findLegacyToolPairingRestorations(
  path: readonly KodaXSessionEntry[],
  lookup: LegacyToolPairingLookup,
  checkpoint?: () => void,
): ReadonlyMap<string, LegacyToolPairingRestoration> {
  const damagedIndex = firstDamagedCandidateIndex(path);
  const anchor = asMessageEntry(damagedIndex > 0 ? path[damagedIndex - 1] : undefined);
  if (!anchor) return NO_RESTORATIONS;
  const chain = retainedEvidenceChain(anchor, path[damagedIndex]!.id, lookup);
  const steps = chain ? evidenceSteps(anchor, chain) : undefined;
  if (!steps || steps.length === 0) return NO_RESTORATIONS;
  checkpoint?.();
  const slots = damagedPathSlots(path, damagedIndex, steps.length);
  // A leaf inside the chain stays raw: a later append could still fail the proof.
  if (slots.length !== steps.length) return NO_RESTORATIONS;
  const restorations = matchDamagedChain(steps, slots, anchor.id, lookup);
  return restorations && restorations.size > 0 ? restorations : NO_RESTORATIONS;
}
