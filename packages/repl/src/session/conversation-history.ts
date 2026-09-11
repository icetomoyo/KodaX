import { createHash } from 'node:crypto';

import {
  forkSessionLineage,
  getSessionLineagePath,
} from '@kodax-ai/agent/session-lineage';
import type {
  KodaXMessage,
  KodaXSessionCompactionEntry,
  KodaXSessionEntry,
  KodaXSessionLineage,
  KodaXSessionMessageEntry,
} from '@kodax-ai/agent';

export type SessionConversationHistoryStatus =
  | 'resolved'
  | 'partial'
  | 'ambiguous';

export type SessionConversationHistoryIssueCode =
  | 'active_entry_missing'
  | 'compaction_boundary_invalid'
  | 'compaction_predecessor_ambiguous'
  | 'compaction_predecessor_missing'
  | 'legacy_overlap_ambiguous'
  | 'lineage_path_incomplete'
  | 'lineage_unavailable'
  | 'logical_identity_conflict';

export interface SessionConversationHistoryIssue {
  readonly code: SessionConversationHistoryIssueCode;
  readonly message: string;
  /** Number of diagnostics of this code represented by this bounded summary. */
  readonly occurrenceCount: number;
  /** Total evidence references before `entryIds` was bounded. */
  readonly entryCount: number;
  readonly entryIds: readonly string[];
}

/**
 * One SDK-resolved conversation item. `auditEntryIds` names every proven
 * physical copy represented by it; raw bodies remain in the audit API.
 */
export interface SessionConversationHistoryEntry {
  readonly boundaryId?: string;
  readonly auditEntryIds: readonly string[];
  readonly message: KodaXMessage;
}

export interface SessionConversationHistoryData {
  readonly sourceRevision: string;
  readonly status: SessionConversationHistoryStatus;
  readonly entries: readonly SessionConversationHistoryEntry[];
  readonly issues: readonly SessionConversationHistoryIssue[];
}

interface ThreadPath {
  readonly entries: readonly KodaXSessionEntry[];
  readonly complete: boolean;
}

interface ConversationEpoch {
  readonly root: KodaXSessionEntry;
  /** Ordinary projection: replaceable managed-context envelopes are excluded. */
  readonly messages: readonly KodaXSessionMessageEntry[];
  /**
   * First physical message entry on the epoch path, including
   * topology-transparent managed-context envelopes. This is the id that
   * must match the compaction writer's `firstKeptEntryId`; it deliberately
   * differs from `messages[0]?.id` when the retained suffix starts with a
   * managed envelope.
   */
  readonly firstPhysicalMessageEntryId?: string;
}

interface CompactionPredecessorCandidate {
  readonly leaf: KodaXSessionEntry;
  readonly path: ThreadPath;
}

interface MutableConversationEntry {
  readonly index: number;
  readonly source: KodaXSessionMessageEntry;
  readonly auditEntryIds: string[];
}

type PendingConversationHistoryIssue = Omit<
  SessionConversationHistoryIssue,
  'occurrenceCount' | 'entryCount'
>;

const MAX_CONVERSATION_ISSUE_ENTRY_IDS = 16;
const MAX_CONVERSATION_ISSUE_EVIDENCE_BYTES = 4 * 1024;
const MAX_CONVERSATION_ISSUE_MESSAGE_LENGTH = 512;
const CONVERSATION_ENTRY_CHAIN_DOMAIN = 'kodax-conversation-entry-chain-v1\0';
const CONVERSATION_HISTORY_REVISION_DOMAIN = 'kodax-conversation-history-v2\0';

export function emptyConversationEntryChain(): string {
  return `sha256:${createHash('sha256')
    .update(CONVERSATION_ENTRY_CHAIN_DOMAIN)
    .digest('hex')}`;
}

export function extendConversationEntryChain(
  previous: string,
  entries: readonly SessionConversationHistoryEntry[],
): string {
  let chain = previous;
  for (const entry of entries) {
    const encoded = JSON.stringify(entry);
    chain = `sha256:${createHash('sha256')
      .update(CONVERSATION_ENTRY_CHAIN_DOMAIN)
      .update(chain)
      .update(`${Buffer.byteLength(encoded, 'utf8')}:`)
      .update(encoded)
      .digest('hex')}`;
  }
  return chain;
}

export function createConversationEntryChain(
  entries: readonly SessionConversationHistoryEntry[],
): string {
  return extendConversationEntryChain(emptyConversationEntryChain(), entries);
}

export function createSessionConversationHistoryRevision(
  history: SessionConversationHistoryData,
  entryChain = createConversationEntryChain(history.entries),
): string {
  return `sha256:${createHash('sha256')
    .update(CONVERSATION_HISTORY_REVISION_DOMAIN)
    .update(entryChain)
    .update(JSON.stringify({
      sourceRevision: history.sourceRevision,
      status: history.status,
      issues: history.issues,
    }))
    .digest('hex')}`;
}

function isThreadEntry(entry: KodaXSessionEntry): boolean {
  return entry.type === 'message'
    || entry.type === 'compaction'
    || entry.type === 'branch_summary';
}

/**
 * Managed-context detection aligned with the compaction stripping side
 * (packages/coding .../managed-run-context.ts): the `_source` tag alone
 * identifies the two replaceable envelope kinds, independent of the
 * `_synthetic` flag.
 */
export function isManagedContextMessage(message: KodaXMessage): boolean {
  return message._source === 'managed-run-context'
    || message._source === 'managed-runtime-context';
}

export function isOrdinaryConversationMessageEntry(
  entry: KodaXSessionEntry,
): entry is KodaXSessionMessageEntry {
  if (entry.type !== 'message') return false;
  // Managed context is a replaceable LLM envelope, not a user conversation
  // record. The raw transcript API still exposes its physical audit entry.
  return !isManagedContextMessage(entry.message);
}

function threadPath(
  targetId: string,
  entriesById: ReadonlyMap<string, KodaXSessionEntry>,
  checkpoint?: () => void,
): ThreadPath {
  const reversed: KodaXSessionEntry[] = [];
  const visited = new Set<string>();
  let current = entriesById.get(targetId);
  let complete = current !== undefined;
  let visitedCount = 0;
  while (current !== undefined) {
    if (visitedCount % 256 === 0) checkpoint?.();
    visitedCount += 1;
    if (visited.has(current.id)) {
      complete = false;
      break;
    }
    visited.add(current.id);
    reversed.push(current);
    if (current.parentId === null) break;
    const parent = entriesById.get(current.parentId);
    if (parent === undefined) complete = false;
    current = parent;
  }
  return { entries: reversed.reverse(), complete };
}

function hasExplicitProvenance(entry: KodaXSessionMessageEntry): boolean {
  return explicitProvenanceKeys(entry).length > 0;
}

function explicitProvenanceKeys(entry: KodaXSessionMessageEntry): string[] {
  return [...new Set([
    ...(entry.logicalId !== undefined && entry.logicalId !== entry.id
      ? [entry.logicalId]
      : []),
    ...(entry.sourceEntryId !== undefined && entry.sourceEntryId !== entry.id
      ? [entry.sourceEntryId]
      : []),
  ])];
}

function provenanceMatches(
  prior: KodaXSessionMessageEntry,
  copy: KodaXSessionMessageEntry,
): boolean {
  const priorKeys = new Set([prior.id, prior.logicalId, prior.sourceEntryId]);
  return explicitProvenanceKeys(copy).every((key) => priorKeys.has(key));
}

function retainedSuffixMatches(
  prior: readonly KodaXSessionMessageEntry[],
  current: readonly KodaXSessionMessageEntry[],
  checkpoint?: () => void,
): boolean {
  let firstExplicitIndex = -1;
  for (let index = 0; index < current.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    if (hasExplicitProvenance(current[index]!)) {
      firstExplicitIndex = index;
      break;
    }
  }
  if (firstExplicitIndex < 0) {
    const priorFingerprints: string[] = [];
    const priorStart = Math.max(0, prior.length - current.length);
    for (let index = priorStart; index < prior.length; index += 1) {
      if (index > priorStart && index % 256 === 0) checkpoint?.();
      priorFingerprints.push(messageFingerprint(prior[index]!.message));
    }
    const currentFingerprints: string[] = [];
    for (let index = 0; index < current.length; index += 1) {
      if (index > 0 && index % 256 === 0) checkpoint?.();
      currentFingerprints.push(messageFingerprint(current[index]!.message));
    }
    return prefixSuffixOverlapLengths(
      priorFingerprints,
      currentFingerprints,
      checkpoint,
    ).length > 0;
  }
  const minStart = Math.max(0, prior.length - current.length);
  for (let priorIndex = 0; priorIndex < prior.length; priorIndex += 1) {
    if (priorIndex % 256 === 0) checkpoint?.();
    const entry = prior[priorIndex]!;
    const start = priorIndex - firstExplicitIndex;
    if (
      start < minStart
      || !provenanceMatches(entry, current[firstExplicitIndex]!)
    ) {
      continue;
    }
    const comparedLength = prior.length - start;
    let matches = comparedLength <= current.length;
    for (let index = 0; matches && index < comparedLength; index += 1) {
      if (index > 0 && index % 256 === 0) checkpoint?.();
      const candidate = prior[start + index]!;
      const copy = current[index]!;
      matches = hasExplicitProvenance(copy)
        ? provenanceMatches(candidate, copy)
        : messagesEqual(candidate.message, copy.message);
    }
    if (matches) return true;
  }
  return false;
}

function compactionPredecessorCandidates(
  priorEntries: readonly KodaXSessionEntry[],
  root: KodaXSessionCompactionEntry,
  epoch: ConversationEpoch,
  issues: PendingConversationHistoryIssue[],
  checkpoint?: () => void,
): CompactionPredecessorCandidate[] {
  const priorThreadEntries: KodaXSessionEntry[] = [];
  const entriesById = new Map<string, KodaXSessionEntry>();
  const appendIndex = new Map<string, number>();
  for (let index = 0; index < priorEntries.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const entry = priorEntries[index]!;
    if (!isThreadEntry(entry)) continue;
    appendIndex.set(entry.id, priorThreadEntries.length);
    priorThreadEntries.push(entry);
    entriesById.set(entry.id, entry);
  }
  const parents = new Set<string>();
  for (let index = 0; index < priorThreadEntries.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const parentId = priorThreadEntries[index]!.parentId;
    if (parentId !== null) parents.add(parentId);
  }
  const candidates: CompactionPredecessorCandidate[] = [];
  for (let index = 0; index < priorThreadEntries.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const leaf = priorThreadEntries[index]!;
    if (!parents.has(leaf.id)) {
      candidates.push({ leaf, path: threadPath(leaf.id, entriesById, checkpoint) });
    }
  }
  const incomplete: CompactionPredecessorCandidate[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    if (!candidates[index]!.path.complete) incomplete.push(candidates[index]!);
  }
  if (incomplete.length > 0) {
    issues.push({
      code: 'lineage_path_incomplete',
      message: `A candidate predecessor path for compaction ${root.id} is incomplete.`,
      entryIds: [root.id, ...incomplete.map((candidate) => candidate.leaf.id)],
    });
    return [];
  }
  const outOfOrder: CompactionPredecessorCandidate[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const candidate = candidates[index]!;
    if (!isAppendOrderedPriorPath(
      candidate.path,
      priorThreadEntries.length,
      appendIndex,
      checkpoint,
    )) outOfOrder.push(candidate);
  }
  if (outOfOrder.length > 0) {
    issues.push({
      code: 'lineage_path_incomplete',
      message: `A candidate predecessor path for compaction ${root.id} is not append ordered.`,
      entryIds: [root.id, ...outOfOrder.map((candidate) => candidate.leaf.id)],
    });
    return [];
  }
  if (root.firstKeptEntryId === undefined) return candidates;
  if (epoch.firstPhysicalMessageEntryId !== root.firstKeptEntryId) {
    issues.push({
      code: 'compaction_boundary_invalid',
      message: `Compaction ${root.id} does not identify its first retained message.`,
      entryIds: [root.id, root.firstKeptEntryId],
    });
    return [];
  }

  const matches: CompactionPredecessorCandidate[] = [];
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    if (candidateIndex > 0 && candidateIndex % 256 === 0) checkpoint?.();
    const candidate = candidates[candidateIndex]!;
    const messages: KodaXSessionMessageEntry[] = [];
    for (let index = 0; index < candidate.path.entries.length; index += 1) {
      if (index > 0 && index % 256 === 0) checkpoint?.();
      const entry = candidate.path.entries[index]!;
      if (isOrdinaryConversationMessageEntry(entry)) messages.push(entry);
    }
    if (retainedSuffixMatches(messages, epoch.messages, checkpoint)) {
      matches.push(candidate);
    }
  }
  if (matches.length === 0 && candidates.length > 0) {
    issues.push({
      code: 'compaction_boundary_invalid',
      message: `Compaction ${root.id} retained suffix conflicts with every predecessor branch.`,
      entryIds: [root.id, ...epoch.messages.map((entry) => entry.id)],
    });
  }
  return matches;
}

function resolveCompactionPredecessor(
  priorEntries: readonly KodaXSessionEntry[],
  root: KodaXSessionCompactionEntry,
  epoch: ConversationEpoch,
  issues: PendingConversationHistoryIssue[],
  checkpoint?: () => void,
): KodaXSessionEntry | undefined {
  const candidates = compactionPredecessorCandidates(
    priorEntries,
    root,
    epoch,
    issues,
    checkpoint,
  );
  const unique = [...new Map(candidates.map((candidate) => [
    candidate.leaf.id,
    candidate.leaf,
  ])).values()];
  if (unique.length === 1) return unique[0];
  issues.push({
    code: unique.length === 0
      ? 'compaction_predecessor_missing'
      : 'compaction_predecessor_ambiguous',
    message: unique.length === 0
      ? `No topology-proven predecessor was retained for compaction ${root.id}.`
      : `Compaction ${root.id} has multiple possible predecessor branches.`,
    entryIds: [root.id, ...unique.map((entry) => entry.id)],
  });
  return undefined;
}

function leadingExplicitRetainedCopies(
  root: KodaXSessionCompactionEntry,
  epoch: ConversationEpoch,
  checkpoint?: () => void,
): readonly KodaXSessionMessageEntry[] {
  if (epoch.firstPhysicalMessageEntryId !== root.firstKeptEntryId) return [];
  const currentMessages = epoch.messages;
  let firstNonExplicit = -1;
  for (let index = 0; index < currentMessages.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    if (!hasExplicitProvenance(currentMessages[index]!)) {
      firstNonExplicit = index;
      break;
    }
  }
  const prefixLength = firstNonExplicit < 0
    ? currentMessages.length
    : firstNonExplicit;
  if (prefixLength === 0) return [];
  for (let index = prefixLength; index < currentMessages.length; index += 1) {
    if (index > prefixLength && index % 256 === 0) checkpoint?.();
    if (hasExplicitProvenance(currentMessages[index]!)) return [];
  }
  const retained: KodaXSessionMessageEntry[] = [];
  for (let index = 0; index < prefixLength; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    retained.push(currentMessages[index]!);
  }
  return retained;
}

function isAppendOrderedPriorPath(
  path: ThreadPath,
  rootIndex: number,
  appendIndex: ReadonlyMap<string, number>,
  checkpoint?: () => void,
): boolean {
  let previousIndex = -1;
  for (let pathIndex = 0; pathIndex < path.entries.length; pathIndex += 1) {
    if (pathIndex > 0 && pathIndex % 256 === 0) checkpoint?.();
    const entry = path.entries[pathIndex]!;
    const index = appendIndex.get(entry.id);
    if (
      index === undefined
      || index >= rootIndex
      || index <= previousIndex
    ) {
      return false;
    }
    previousIndex = index;
  }
  return true;
}

function explicitCompactionPredecessorCandidates(
  root: KodaXSessionCompactionEntry,
  epoch: ConversationEpoch,
  rootIndex: number,
  entriesById: ReadonlyMap<string, KodaXSessionEntry>,
  appendIndex: ReadonlyMap<string, number>,
  messagesByIdentity: ReadonlyMap<string, readonly KodaXSessionMessageEntry[]>,
  checkpoint?: () => void,
): KodaXSessionMessageEntry[] {
  const retainedCopies = leadingExplicitRetainedCopies(
    root,
    epoch,
    checkpoint,
  );
  const lastCopy = retainedCopies.at(-1);
  const lookupKey = lastCopy === undefined
    ? undefined
    : explicitProvenanceKeys(lastCopy)[0];
  if (lastCopy === undefined || lookupKey === undefined) return [];
  const matches: KodaXSessionMessageEntry[] = [];
  const identityMatches = messagesByIdentity.get(lookupKey) ?? [];
  for (let candidateIndex = 0; candidateIndex < identityMatches.length; candidateIndex += 1) {
    checkpoint?.();
    const candidate = identityMatches[candidateIndex]!;
    if ((appendIndex.get(candidate.id) ?? Number.MAX_SAFE_INTEGER) >= rootIndex) {
      continue;
    }
    const path = threadPath(candidate.id, entriesById, checkpoint);
    const priorMessages: KodaXSessionMessageEntry[] = [];
    for (let index = 0; index < path.entries.length; index += 1) {
      if (index > 0 && index % 256 === 0) checkpoint?.();
      const entry = path.entries[index]!;
      if (isOrdinaryConversationMessageEntry(entry)) priorMessages.push(entry);
    }
    if (
      !path.complete
      || !isAppendOrderedPriorPath(path, rootIndex, appendIndex, checkpoint)
    ) {
      continue;
    }
    const suffixStart = Math.max(0, priorMessages.length - retainedCopies.length);
    const suffix: KodaXSessionMessageEntry[] = [];
    for (let index = suffixStart; index < priorMessages.length; index += 1) {
      if (index > suffixStart && index % 256 === 0) checkpoint?.();
      suffix.push(priorMessages[index]!);
    }
    let suffixMatches = suffix.length === retainedCopies.length;
    for (let index = 0; suffixMatches && index < suffix.length; index += 1) {
      if (index > 0 && index % 256 === 0) checkpoint?.();
      const entry = suffix[index]!;
      const copy = retainedCopies[index]!;
      suffixMatches = provenanceMatches(entry, copy)
        && messagesEqual(entry.message, copy.message);
    }
    if (suffixMatches) {
      matches.push(candidate);
    }
  }
  const unique = new Map<string, KodaXSessionMessageEntry>();
  for (let index = 0; index < matches.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const entry = matches[index]!;
    unique.set(entry.id, entry);
  }
  return [...unique.values()];
}

function indexMessagesByIdentity(
  entries: readonly KodaXSessionEntry[],
  checkpoint?: () => void,
): ReadonlyMap<string, readonly KodaXSessionMessageEntry[]> {
  const result = new Map<string, KodaXSessionMessageEntry[]>();
  for (let index = 0; index < entries.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const entry = entries[index]!;
    if (!isOrdinaryConversationMessageEntry(entry)) continue;
    for (const key of new Set([entry.id, entry.logicalId, entry.sourceEntryId])) {
      if (key === undefined) continue;
      const matches = result.get(key) ?? [];
      matches.push(entry);
      result.set(key, matches);
    }
  }
  return result;
}

function conversationEpochs(
  lineage: KodaXSessionLineage,
  issues: PendingConversationHistoryIssue[],
  checkpoint?: () => void,
): ConversationEpoch[] {
  const threadEntries: KodaXSessionEntry[] = [];
  const entriesById = new Map<string, KodaXSessionEntry>();
  const appendIndex = new Map<string, number>();
  const messageEntryIds: string[] = [];
  for (let index = 0; index < lineage.entries.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const entry = lineage.entries[index]!;
    appendIndex.set(entry.id, index);
    if (!isThreadEntry(entry)) continue;
    threadEntries.push(entry);
    entriesById.set(entry.id, entry);
    if (isOrdinaryConversationMessageEntry(entry)) messageEntryIds.push(entry.id);
  }
  if (lineage.activeEntryId === null && messageEntryIds.length > 0) {
    issues.push({
      code: 'active_entry_missing',
      message: 'Conversation lineage contains messages but has no active entry.',
      entryIds: messageEntryIds,
    });
    return [];
  }
  const messagesByIdentity = indexMessagesByIdentity(threadEntries, checkpoint);
  const priorEpochStartByCompactionId = new Map<string, number>();
  let epochStart = 0;
  for (let index = 0; index < lineage.entries.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const entry = lineage.entries[index]!;
    if (entry.type === 'compaction' && entry.parentId === null) {
      priorEpochStartByCompactionId.set(entry.id, epochStart);
      epochStart = index;
    }
  }
  const epochs: ConversationEpoch[] = [];
  const visitedRoots = new Set<string>();
  let path = lineage.activeEntryId === null
    ? { entries: [], complete: true }
    : threadPath(lineage.activeEntryId, entriesById, checkpoint);

  while (path.entries.length > 0) {
    const root = path.entries[0]!;
    if (visitedRoots.has(root.id)) {
      path = { entries: [], complete: false };
      break;
    }
    visitedRoots.add(root.id);
    const currentMessages: KodaXSessionMessageEntry[] = [];
    let firstPhysicalMessageEntryId: string | undefined;
    for (let index = 0; index < path.entries.length; index += 1) {
      if (index > 0 && index % 256 === 0) checkpoint?.();
      const entry = path.entries[index]!;
      // Physical track: any message entry — including topology-transparent
      // managed-context envelopes — anchors the compaction boundary check.
      if (entry.type === 'message' && firstPhysicalMessageEntryId === undefined) {
        firstPhysicalMessageEntryId = entry.id;
      }
      if (isOrdinaryConversationMessageEntry(entry)) currentMessages.push(entry);
    }
    const epoch: ConversationEpoch = {
      root,
      messages: currentMessages,
      ...(firstPhysicalMessageEntryId !== undefined
        ? { firstPhysicalMessageEntryId }
        : {}),
    };
    epochs.push(epoch);
    if (root.type !== 'compaction' || root.reason === 'rewind') break;
    const rootIndex = appendIndex.get(root.id) ?? 0;
    const priorEpochStart = priorEpochStartByCompactionId.get(root.id) ?? 0;
    const predecessorIssues: PendingConversationHistoryIssue[] = [];
    const priorEntries: KodaXSessionEntry[] = [];
    for (let index = priorEpochStart; index < rootIndex; index += 1) {
      if (index > priorEpochStart && index % 256 === 0) checkpoint?.();
      priorEntries.push(lineage.entries[index]!);
    }
    let predecessor = resolveCompactionPredecessor(
      priorEntries,
      root,
      epoch,
      predecessorIssues,
      checkpoint,
    );
    if (predecessor === undefined) {
      const explicitCandidates = explicitCompactionPredecessorCandidates(
        root,
        epoch,
        rootIndex,
        entriesById,
        appendIndex,
        messagesByIdentity,
        checkpoint,
      );
      if (explicitCandidates.length === 1) {
        [predecessor] = explicitCandidates;
      } else {
        issues.push(...predecessorIssues);
        if (explicitCandidates.length > 1) {
          issues.push({
            code: 'compaction_predecessor_ambiguous',
            message: `Compaction ${root.id} provenance identifies multiple predecessor copies.`,
            entryIds: [root.id, ...explicitCandidates.map((entry) => entry.id)],
          });
        }
      }
    }
    if (predecessor === undefined) {
      break;
    }
    path = threadPath(predecessor.id, entriesById, checkpoint);
  }

  if (!path.complete) {
    issues.push({
      code: 'lineage_path_incomplete',
      message: 'Conversation lineage contains a missing parent or parent cycle.',
      entryIds: path.entries.map((entry) => entry.id),
    });
  }
  return epochs.reverse();
}

function messageFingerprint(message: KodaXMessage): string {
  return JSON.stringify([
    message.role,
    message.content,
    message._synthetic === true,
    message._source,
    message._taskResult,
    message._taskResults,
  ]);
}

/** All non-empty suffix lengths of `prior` that equal a prefix of `current`. */
function prefixSuffixOverlapLengths(
  prior: readonly string[],
  current: readonly string[],
  checkpoint?: () => void,
): number[] {
  if (prior.length === 0 || current.length === 0) return [];
  const relevantPrior = prior.slice(Math.max(0, prior.length - current.length));
  const values: Array<string | undefined> = [
    ...current,
    undefined,
    ...relevantPrior,
  ];
  const prefixLengths = new Array<number>(values.length).fill(0);
  for (let index = 1; index < values.length; index += 1) {
    if (index % 256 === 0) checkpoint?.();
    let length = prefixLengths[index - 1]!;
    while (length > 0 && values[index] !== values[length]) {
      length = prefixLengths[length - 1]!;
    }
    if (values[index] === values[length]) length += 1;
    prefixLengths[index] = Math.min(length, current.length);
  }
  const overlaps: number[] = [];
  let length = prefixLengths.at(-1) ?? 0;
  while (length > 0) {
    overlaps.push(length);
    length = prefixLengths[length - 1] ?? 0;
  }
  return overlaps;
}

function messagesEqual(left: KodaXMessage, right: KodaXMessage): boolean {
  return left === right || messageFingerprint(left) === messageFingerprint(right);
}

function logicalIdentity(entry: KodaXSessionMessageEntry): string {
  return entry.logicalId ?? entry.id;
}

function explicitPriorGroups(
  entry: KodaXSessionMessageEntry,
  groupsByIdentity: ReadonlyMap<string, MutableConversationEntry>,
): readonly MutableConversationEntry[] {
  return explicitPriorGroupResolution(entry, groupsByIdentity).groups;
}

function explicitPriorGroupResolution(
  entry: KodaXSessionMessageEntry,
  groupsByIdentity: ReadonlyMap<string, MutableConversationEntry>,
): {
  readonly keys: readonly string[];
  readonly groups: readonly MutableConversationEntry[];
  readonly unresolvedKeys: readonly string[];
} {
  const keys = explicitProvenanceKeys(entry);
  const unresolvedKeys = keys.filter((key) => !groupsByIdentity.has(key));
  const groups = [...new Set(keys.flatMap((key) => {
    const group = groupsByIdentity.get(key);
    return group === undefined ? [] : [group];
  }))];
  return { keys, groups, unresolvedKeys };
}

function registerEntryIdentities(
  entry: KodaXSessionMessageEntry,
  group: MutableConversationEntry,
  groupsByIdentity: Map<string, MutableConversationEntry>,
): void {
  for (const key of [entry.id, logicalIdentity(entry), entry.sourceEntryId]) {
    if (key !== undefined && !groupsByIdentity.has(key)) {
      groupsByIdentity.set(key, group);
    }
  }
}

function physicalAuditEntryIds(
  entry: KodaXSessionMessageEntry,
  knownIdentities?: { has(identity: string): boolean },
): string[] {
  return entry.sourceEntryId !== undefined
    && entry.sourceEntryId !== entry.id
    && knownIdentities?.has(entry.sourceEntryId) !== true
    ? [entry.sourceEntryId, entry.id]
    : [entry.id];
}

/** Context rewrites can leave older physical copies outside the selected epochs. */
function expandPhysicalProvenance(
  group: MutableConversationEntry,
  entriesById: ReadonlyMap<string, KodaXSessionMessageEntry>,
  owners: ReadonlyMap<string, MutableConversationEntry>,
): string[] {
  const seen = new Set(group.auditEntryIds);
  const ancestors: string[] = [];
  for (const id of group.auditEntryIds) {
    let entry = entriesById.get(id);
    while (entry?.sourceEntryId !== undefined) {
      const source = entriesById.get(entry.sourceEntryId);
      if (!source || seen.has(source.id)) break;
      const owner = owners.get(source.id);
      if ((owner !== undefined && owner !== group)
        || !messagesEqual(entry.message, source.message)
        || (entry.logicalId !== undefined && entry.logicalId !== entry.id
          && logicalIdentity(entry) !== logicalIdentity(source))) break;
      seen.add(source.id);
      ancestors.push(source.id);
      entry = source;
    }
  }
  return [...ancestors.reverse(), ...group.auditEntryIds];
}

function resolvePhysicalProvenance(
  groups: readonly MutableConversationEntry[],
  entriesById: ReadonlyMap<string, KodaXSessionMessageEntry>,
  owners: ReadonlyMap<string, MutableConversationEntry>,
  issues: PendingConversationHistoryIssue[],
): string[][] {
  const candidates = groups.map((group) => expandPhysicalProvenance(group, entriesById, owners));
  const claims = new Map<string, number>();
  for (const ids of candidates) for (const id of ids) claims.set(id, (claims.get(id) ?? 0) + 1);
  const conflicts = new Set<string>();
  const resolved = candidates.map((ids, index) => {
    const existing = new Set(groups[index]!.auditEntryIds);
    return ids.filter((id) => {
      if (existing.has(id) || claims.get(id) === 1) return true;
      conflicts.add(id);
      return false;
    });
  });
  for (const id of conflicts) issues.push({
    code: 'logical_identity_conflict',
    message: `Physical provenance ${id} is claimed by multiple conversation records.`,
    entryIds: [id],
  });
  return resolved;
}

function provenLegacyOverlap(
  root: KodaXSessionCompactionEntry,
  epoch: ConversationEpoch,
  prior: readonly MutableConversationEntry[],
  groupsByIdentity: ReadonlyMap<string, MutableConversationEntry>,
  issues: PendingConversationHistoryIssue[],
  checkpoint?: () => void,
): ReadonlyMap<string, MutableConversationEntry> {
  const mappings = new Map<string, MutableConversationEntry>();
  const { messages } = epoch;
  const firstKeptId = root.firstKeptEntryId;
  if (firstKeptId === undefined || prior.length === 0 || messages.length === 0) {
    return mappings;
  }
  if (epoch.firstPhysicalMessageEntryId !== firstKeptId) {
    issues.push({
      code: 'compaction_boundary_invalid',
      message: `Compaction ${root.id} does not identify the first retained message.`,
      entryIds: [root.id, firstKeptId],
    });
    return mappings;
  }
  const overlapLengths = prefixSuffixOverlapLengths(
    prior.slice(-messages.length)
      .map((group) => messageFingerprint(group.source.message)),
    messages.map((entry) => messageFingerprint(entry.message)),
    checkpoint,
  );
  let provenanceConflict = false;
  const explicit = messages.flatMap((entry, index) => {
    const resolution = explicitPriorGroupResolution(entry, groupsByIdentity);
    return resolution.keys.length === 0 ? [] : [{ index, resolution }];
  });
  const firstExplicit = explicit[0];
  const shortLengths = firstExplicit === undefined
    ? overlapLengths
    : overlapLengths.filter((length) => length <= firstExplicit.index);
  let longLength: number | undefined;
  if (firstExplicit !== undefined) {
    const { index, resolution } = firstExplicit;
    const groupIndex = resolution.groups.length === 1
      ? resolution.groups[0]!.index
      : -1;
    const expectedLength = prior.length + index - groupIndex;
    longLength = resolution.unresolvedKeys.length === 0
      && resolution.groups.length === 1
      && groupIndex >= 0
      && overlapLengths.includes(expectedLength)
      && expectedLength > index
      ? expectedLength
      : undefined;
    if (
      longLength === undefined
      && overlapLengths.some((length) => length > index)
    ) {
      provenanceConflict = true;
    }
  }
  for (const item of explicit.slice(1)) {
    if (longLength === undefined || longLength <= item.index) continue;
    const { resolution } = item;
    const groupIndex = resolution.groups.length === 1
      ? resolution.groups[0]!.index
      : -1;
    if (
      resolution.unresolvedKeys.length > 0
      || resolution.groups.length !== 1
      || groupIndex < 0
      || prior.length + item.index - groupIndex !== longLength
    ) {
      provenanceConflict = true;
      longLength = undefined;
    }
  }
  const candidateLengths = [
    ...shortLengths,
    ...(longLength === undefined ? [] : [longLength]),
  ];
  const candidates = candidateLengths.map((length) => prior.length - length);
  const explicitGroups = explicitPriorGroups(messages[0]!, groupsByIdentity);
  if (
    candidates.length === 0
    && explicitGroups.length === 1
    && !messagesEqual(explicitGroups[0]!.source.message, messages[0]!.message)
  ) {
    return mappings;
  }
  if (provenanceConflict) {
    issues.push({
      code: 'logical_identity_conflict',
      message: `Compaction ${root.id} contains provenance keys that name different history records.`,
      entryIds: [root.id, ...messages.map((entry) => entry.id)],
    });
  }
  if (candidates.length !== 1) {
    issues.push({
      code: 'compaction_boundary_invalid',
      message: `Compaction ${root.id} has no unique retained suffix.`,
      entryIds: [root.id, ...messages.map((entry) => entry.id)],
    });
    return mappings;
  }
  const start = candidates[0]!;
  for (let index = start; index < prior.length; index += 1) {
    mappings.set(messages[index - start]!.id, prior[index]!);
  }
  return mappings;
}

function longestUnprovenOverlap(
  messages: readonly KodaXSessionMessageEntry[],
  prior: readonly MutableConversationEntry[],
  groupsByIdentity: ReadonlyMap<string, MutableConversationEntry>,
  checkpoint?: () => void,
): KodaXSessionMessageEntry[] {
  const [length = 0] = prefixSuffixOverlapLengths(
    prior.slice(-messages.length)
      .map((group) => messageFingerprint(group.source.message)),
    messages.map((entry) => messageFingerprint(entry.message)),
    checkpoint,
  );
  return messages.slice(0, length).filter((entry) =>
    explicitPriorGroups(entry, groupsByIdentity).length === 0);
}

function appendConversationMessage(
  entry: KodaXSessionMessageEntry,
  topologyMappings: ReadonlyMap<string, MutableConversationEntry>,
  groups: MutableConversationEntry[],
  groupsByIdentity: Map<string, MutableConversationEntry>,
  issues: PendingConversationHistoryIssue[],
): void {
  const topologyGroup = topologyMappings.get(entry.id);
  if (topologyGroup !== undefined) {
    const resolution = explicitPriorGroupResolution(entry, groupsByIdentity);
    if (
      resolution.unresolvedKeys.length > 0
      || resolution.groups.length > 1
      || (resolution.groups.length === 1 && resolution.groups[0] !== topologyGroup)
    ) {
      issues.push({
        code: 'logical_identity_conflict',
        message: `Transcript provenance for ${entry.id} does not identify its topology-proven record.`,
        entryIds: [topologyGroup.source.id, entry.id],
      });
      const group = {
        index: groups.length,
        source: entry,
        auditEntryIds: physicalAuditEntryIds(entry, groupsByIdentity),
      };
      groups.push(group);
      registerEntryIdentities(entry, group, groupsByIdentity);
      return;
    } else {
      topologyGroup.auditEntryIds.push(entry.id);
      registerEntryIdentities(entry, topologyGroup, groupsByIdentity);
      return;
    }
  }
  const resolution = explicitPriorGroupResolution(entry, groupsByIdentity);
  const priorGroups = resolution.groups;
  const priorGroup = resolution.keys.length > 0
    && resolution.unresolvedKeys.length === 0
    && priorGroups.length === 1
    ? priorGroups[0]
    : undefined;
  if (priorGroup !== undefined && messagesEqual(priorGroup.source.message, entry.message)) {
    priorGroup.auditEntryIds.push(entry.id);
    registerEntryIdentities(entry, priorGroup, groupsByIdentity);
    return;
  }
  if (
    priorGroups.length > 0
    && (
      resolution.unresolvedKeys.length > 0
      || priorGroups.length !== 1
      || priorGroup === undefined
      || !messagesEqual(priorGroup.source.message, entry.message)
    )
  ) {
    issues.push({
      code: 'logical_identity_conflict',
      message: `Transcript provenance for ${entry.id} is conflicting or has a different payload.`,
      entryIds: [...priorGroups.map((group) => group.source.id), entry.id],
    });
  }
  const group = {
    index: groups.length,
    source: entry,
    auditEntryIds: physicalAuditEntryIds(entry, groupsByIdentity),
  };
  groups.push(group);
  registerEntryIdentities(entry, group, groupsByIdentity);
}

function historyStatus(
  issues: readonly PendingConversationHistoryIssue[],
): SessionConversationHistoryStatus {
  if (issues.some((issue) => issue.code === 'legacy_overlap_ambiguous'
    || issue.code === 'compaction_boundary_invalid'
    || issue.code === 'compaction_predecessor_ambiguous'
    || issue.code === 'logical_identity_conflict')) {
    return 'ambiguous';
  }
  return issues.length > 0 ? 'partial' : 'resolved';
}

function summarizeConversationIssues(
  issues: readonly PendingConversationHistoryIssue[],
): SessionConversationHistoryIssue[] {
  const byCode = new Map<SessionConversationHistoryIssueCode, {
    message: string;
    occurrenceCount: number;
    entryCount: number;
    entryIds: string[];
    evidenceBytes: number;
  }>();
  for (const issue of issues) {
    const current = byCode.get(issue.code) ?? {
      message: issue.message,
      occurrenceCount: 0,
      entryCount: 0,
      entryIds: [],
      evidenceBytes: 0,
    };
    current.occurrenceCount += 1;
    current.entryCount += issue.entryIds.length;
    for (const entryId of issue.entryIds) {
      if (
        current.entryIds.length < MAX_CONVERSATION_ISSUE_ENTRY_IDS
        && !current.entryIds.includes(entryId)
        && current.evidenceBytes + Buffer.byteLength(entryId, 'utf8')
          <= MAX_CONVERSATION_ISSUE_EVIDENCE_BYTES
      ) {
        current.entryIds.push(entryId);
        current.evidenceBytes += Buffer.byteLength(entryId, 'utf8');
      }
    }
    byCode.set(issue.code, current);
  }
  return [...byCode.entries()].map(([code, summary]) => ({
    code,
    message: summary.message.length <= MAX_CONVERSATION_ISSUE_MESSAGE_LENGTH
      ? summary.message
      : `${summary.message.slice(0, MAX_CONVERSATION_ISSUE_MESSAGE_LENGTH - 1)}…`,
    occurrenceCount: summary.occurrenceCount,
    entryCount: summary.entryCount,
    entryIds: summary.entryIds,
  }));
}

export function buildSessionConversationHistory(
  lineage: KodaXSessionLineage,
  sourceRevision: string,
  checkpoint?: () => void,
): SessionConversationHistoryData {
  const issues: PendingConversationHistoryIssue[] = [];
  checkpoint?.();
  const epochs = conversationEpochs(lineage, issues, checkpoint);
  const unreliableTopology = issues.some((issue) =>
    issue.code === 'active_entry_missing'
    || issue.code === 'compaction_boundary_invalid'
    || issue.code === 'compaction_predecessor_ambiguous'
    || issue.code === 'compaction_predecessor_missing'
    || issue.code === 'lineage_path_incomplete');
  const messageEntries = lineage.entries.filter(
    isOrdinaryConversationMessageEntry,
  );
  const unreliableKnownOrAmbiguousSourceIds = new Set(
    messageEntries.map((entry) => entry.id),
  );
  if (unreliableTopology) {
    const missingSourceClaims = new Map<string, number>();
    for (const entry of messageEntries) {
      const sourceEntryId = entry.sourceEntryId;
      if (sourceEntryId === undefined || unreliableKnownOrAmbiguousSourceIds.has(sourceEntryId)) {
        continue;
      }
      missingSourceClaims.set(sourceEntryId, (missingSourceClaims.get(sourceEntryId) ?? 0) + 1);
    }
    for (const [sourceEntryId, claims] of missingSourceClaims) {
      if (claims > 1) unreliableKnownOrAmbiguousSourceIds.add(sourceEntryId);
    }
  }
  const groups: MutableConversationEntry[] = unreliableTopology
    ? messageEntries.map((source, index) => ({
          index,
          source,
          auditEntryIds: physicalAuditEntryIds(source, unreliableKnownOrAmbiguousSourceIds),
        }))
    : [];
  const groupsByIdentity = new Map<string, MutableConversationEntry>();
  if (unreliableTopology) {
    for (const group of groups) {
      registerEntryIdentities(group.source, group, groupsByIdentity);
    }
  }
  for (const epoch of epochs) {
    if (unreliableTopology) break;
    const root = epoch.root;
    const topologyMappings = root.type === 'compaction' && root.reason !== 'rewind'
      ? provenLegacyOverlap(
          root,
          epoch,
          groups,
          groupsByIdentity,
          issues,
          checkpoint,
        )
      : new Map<string, MutableConversationEntry>();
    if (root.type === 'compaction' && root.firstKeptEntryId === undefined) {
      const overlap = longestUnprovenOverlap(
        epoch.messages,
        groups,
        groupsByIdentity,
        checkpoint,
      );
      if (overlap.length > 0) {
        issues.push({
          code: 'legacy_overlap_ambiguous',
          message: `Legacy compaction ${root.id} overlaps earlier history without durable provenance.`,
          entryIds: overlap.map((entry) => entry.id),
        });
      }
    }
    for (let index = 0; index < epoch.messages.length; index += 1) {
      if (index % 256 === 0) checkpoint?.();
      const entry = epoch.messages[index]!;
      appendConversationMessage(
        entry,
        topologyMappings,
        groups,
        groupsByIdentity,
        issues,
      );
    }
  }

  const entriesById = new Map(messageEntries.map((entry) => [entry.id, entry]));
  const auditIds = unreliableTopology ? groups.map((group) => group.auditEntryIds)
    : resolvePhysicalProvenance(groups, entriesById, groupsByIdentity, issues);
  const entries = groups.map((group, index): SessionConversationHistoryEntry => ({
    boundaryId: group.source.id,
    auditEntryIds: auditIds[index]!,
    message: group.source.message,
  }));
  return {
    sourceRevision,
    status: historyStatus(issues),
    entries,
    issues: summarizeConversationIssues(issues),
  };
}

/**
 * Fork a revision-fenced conversation boundary without expanding the model's
 * compacted active context. A short, disconnected provenance seed preserves
 * the proven pre-compaction conversation for ordinary-history projection.
 */
export function forkSessionConversationLineage(
  lineage: KodaXSessionLineage,
  targetId: string,
  sourceRevision: string,
  checkpoint?: () => void,
): KodaXSessionLineage | null {
  checkpoint?.();
  const targetLineage: KodaXSessionLineage = {
    ...lineage,
    activeEntryId: targetId,
  };
  const activePath = getSessionLineagePath(targetLineage, targetId, checkpoint);
  if (activePath.at(-1)?.id !== targetId) return null;
  const initialFork = forkSessionLineage(targetLineage, targetId, checkpoint);
  if (initialFork === null) return null;
  const forkPath = getSessionLineagePath(
    initialFork,
    initialFork.activeEntryId,
    checkpoint,
  );
  if (forkPath.length !== activePath.length) return null;
  const forkIdBySourceId = new Map(activePath.map((entry, index) => {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    return [entry.id, forkPath[index]!.id];
  }));
  const forked: KodaXSessionLineage = {
    ...initialFork,
    entries: initialFork.entries.map((entry, index) => {
      if (index > 0 && index % 256 === 0) checkpoint?.();
      const source = activePath[index];
      return entry.type === 'compaction'
        && source?.type === 'compaction'
        && source.firstKeptEntryId !== undefined
        ? {
            ...entry,
            firstKeptEntryId: forkIdBySourceId.get(source.firstKeptEntryId),
          }
        : entry;
    }),
  };
  const root = activePath[0];
  if (root?.type !== 'compaction' || root.reason === 'rewind') return forked;

  const history = buildSessionConversationHistory(
    targetLineage,
    sourceRevision,
    checkpoint,
  );
  if (history.status !== 'resolved' || root.firstKeptEntryId === undefined) {
    return null;
  }
  const activeMessages: KodaXSessionMessageEntry[] = [];
  const activeMessageIds = new Set<string>();
  let firstKeptIndex = -1;
  let reachedFirstKept = false;
  for (let index = 0; index < activePath.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const entry = activePath[index]!;
    if (entry.id === root.firstKeptEntryId) reachedFirstKept = true;
    if (!isOrdinaryConversationMessageEntry(entry)) continue;
    if (reachedFirstKept && firstKeptIndex < 0) firstKeptIndex = activeMessages.length;
    activeMessages.push(entry);
    activeMessageIds.add(entry.id);
  }
  if (firstKeptIndex < 0) return null;
  const historyIndexByAuditId = new Map<string, number>();
  for (let index = 0; index < history.entries.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const auditEntryIds = history.entries[index]!.auditEntryIds;
    for (let auditIndex = 0; auditIndex < auditEntryIds.length; auditIndex += 1) {
      if (auditIndex > 0 && auditIndex % 256 === 0) checkpoint?.();
      const auditEntryId = auditEntryIds[auditIndex]!;
      historyIndexByAuditId.set(auditEntryId, index);
    }
  }
  let retainedHistoryEnd = -1;
  for (let index = firstKeptIndex; index < activeMessages.length; index += 1) {
    if (index > firstKeptIndex && index % 256 === 0) checkpoint?.();
    const message = activeMessages[index]!;
    const historyIndex = historyIndexByAuditId.get(message.id);
    if (historyIndex === undefined) return null;
    let hasEarlierPhysicalCopy = false;
    const auditEntryIds = history.entries[historyIndex]!.auditEntryIds;
    for (let auditIndex = 0; auditIndex < auditEntryIds.length; auditIndex += 1) {
      if (auditIndex > 0 && auditIndex % 256 === 0) checkpoint?.();
      if (!activeMessageIds.has(auditEntryIds[auditIndex]!)) {
        hasEarlierPhysicalCopy = true;
        break;
      }
    }
    if (!hasEarlierPhysicalCopy) break;
    if (retainedHistoryEnd >= 0 && historyIndex !== retainedHistoryEnd + 1) {
      return null;
    }
    retainedHistoryEnd = historyIndex;
  }
  if (retainedHistoryEnd < 0) return null;

  const entriesById = new Map<string, KodaXSessionEntry>();
  for (let index = 0; index < lineage.entries.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const entry = lineage.entries[index]!;
    entriesById.set(entry.id, entry);
  }
  let parentId: string | null = null;
  const seedEntries: KodaXSessionMessageEntry[] = [];
  for (let index = 0; index <= retainedHistoryEnd; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const item = history.entries[index]!;
    let activeCopyId: string | undefined;
    for (let auditIndex = 0; auditIndex < item.auditEntryIds.length; auditIndex += 1) {
      if (auditIndex > 0 && auditIndex % 256 === 0) checkpoint?.();
      const entryId = item.auditEntryIds[auditIndex]!;
      if (activeMessageIds.has(entryId)) {
        activeCopyId = entryId;
        break;
      }
    }
    const sourceId = activeCopyId ?? item.boundaryId;
    const source = sourceId === undefined ? undefined : entriesById.get(sourceId);
    if (source?.type !== 'message') return null;
    const seeded: KodaXSessionMessageEntry = { ...source, parentId };
    seedEntries.push(seeded);
    parentId = seeded.id;
  }
  const seedTip = seedEntries.at(-1);
  if (seedTip === undefined) return null;
  const seed = forkSessionLineage({
    version: 2,
    activeEntryId: seedTip.id,
    entries: seedEntries,
  }, undefined, checkpoint);
  if (seed === null) return null;
  return {
    version: 2,
    activeEntryId: forked.activeEntryId,
    entries: [...seed.entries, ...forked.entries],
  };
}

export function buildLineageUnavailableConversationHistory(
  messages: readonly KodaXMessage[],
  sourceRevision: string,
  checkpoint?: () => void,
): SessionConversationHistoryData {
  checkpoint?.();
  if (messages.length === 0) {
    return {
      sourceRevision,
      status: 'resolved',
      entries: [],
      issues: [],
    };
  }
  const issue: PendingConversationHistoryIssue = {
    code: 'lineage_unavailable',
    message: 'This legacy Session has messages but no lineage identity metadata.',
    entryIds: [],
  };
  const entries: SessionConversationHistoryEntry[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const message = messages[index]!;
    // Managed-context envelopes stay topology-transparent even in the
    // lineage-unavailable fallback.
    if (isManagedContextMessage(message)) continue;
    entries.push({ auditEntryIds: [], message });
  }
  return {
    sourceRevision,
    status: 'partial',
    entries,
    issues: summarizeConversationIssues([issue]),
  };
}
