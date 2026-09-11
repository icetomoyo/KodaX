import { randomUUID } from 'node:crypto';
import {
  COMPACTED_HISTORY_RECOVERY_GUIDANCE,
  COMPACTION_SUMMARY_PREFIX,
} from './compaction/compaction.js';
import type { CompactionDetails } from './compaction/types.js';
import { isPostCompactAttachment } from './compaction/post-compact.js';
import type {
  KodaXCompactMemorySeed,
  KodaXJsonValue,
  KodaXMessage,
  KodaXSessionArchiveMarkerEntry,
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionBranchSummaryEntry,
  KodaXSessionClientNoticeEntry,
  KodaXSessionCompactionEntry,
  KodaXSessionEntry,
  KodaXSessionGoalEntry,
  KodaXSessionLabelEntry,
  KodaXSessionLineage,
  KodaXSessionMessageEntry,
  KodaXSessionMemoryOutcomeDigestEntry,
  KodaXSessionMemoryReviewReceiptEntry,
  KodaXSessionNavigationOptions,
  KodaXSessionRewindMarkerEntry,
  KodaXSessionTreeNode,
} from '../index.js';

type NavigableSessionEntry = Exclude<
  KodaXSessionEntry,
  KodaXSessionLabelEntry
    | KodaXSessionGoalEntry
    | KodaXSessionClientNoticeEntry
    | KodaXSessionRewindMarkerEntry
    | KodaXSessionMemoryOutcomeDigestEntry
    | KodaXSessionMemoryReviewReceiptEntry
>;

const ENTRY_ID_LENGTH = 12;
const MAX_BRANCH_SUMMARY_LENGTH = 600;
const messageFingerprintCache = new WeakMap<KodaXMessage, string>();
const messageProvenanceSourceIds = new WeakMap<KodaXMessage, Set<string>>();
const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;
const BRANCH_SUMMARY_SUFFIX = `
</summary>`;

/**
 * Return the message reference directly instead of deep-cloning.
 *
 * KodaX originally cloned every message into lineage entries via
 * structuredClone, doubling memory for each message and quadrupling it
 * when combined with fingerprint caching (original + clone each get
 * a separate JSON.stringify fingerprint in the WeakMap).
 *
 * pi-mono stores direct references (session-manager.ts:829) and avoids
 * this overhead entirely.  KodaX messages are API responses that are
 * never mutated after creation, so sharing references is safe.
 *
 * For operations that genuinely need independent copies (e.g. fork),
 * use structuredClone explicitly at the call site.
 */
function cloneMessage(message: KodaXMessage): KodaXMessage {
  return message;
}

function cloneJsonValue<T extends KodaXJsonValue | undefined>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return structuredClone(value);
}

function cloneMemorySeed(
  value: KodaXCompactMemorySeed | undefined,
): KodaXCompactMemorySeed | undefined {
  if (value === undefined) {
    return value;
  }
  return structuredClone(value);
}

function normalizeCompactionDetails(
  value: KodaXJsonValue | CompactionDetails | undefined,
): KodaXJsonValue | undefined {
  if (value === undefined) {
    return value;
  }
  if (
    typeof value === 'object'
    && value !== null
    && 'readFiles' in value
    && Array.isArray(value.readFiles)
    && 'modifiedFiles' in value
    && Array.isArray(value.modifiedFiles)
  ) {
    return {
      readFiles: [...value.readFiles],
      modifiedFiles: [...value.modifiedFiles],
    };
  }
  return structuredClone(value as KodaXJsonValue);
}

function cloneEntry(entry: KodaXSessionEntry): KodaXSessionEntry {
  // Shallow-copy the entry wrapper. Message references are shared (not
  // deep-cloned) to prevent 2-4× memory multiplication per message.
  // Only fork operations need true deep copies.
  switch (entry.type) {
    case 'message':
      return { ...entry };
    case 'compaction':
      return {
        ...entry,
        details: cloneJsonValue(entry.details),
        memorySeed: cloneMemorySeed(entry.memorySeed),
      };
    case 'branch_summary':
      return {
        ...entry,
        details: cloneJsonValue(entry.details),
      };
    case 'label':
      return { ...entry };
    case 'archive_marker':
      return { ...entry };
    case 'rewind_marker':
      return { ...entry };
    case 'client_notice':
      return {
        ...entry,
        payload: cloneJsonValue(entry.payload),
      };
    case 'memory_outcome_digest':
      return { ...entry, digest: structuredClone(entry.digest) };
    case 'memory_review_receipt':
      return { ...entry, proposalIds: [...entry.proposalIds] };
    case 'goal':
      // KodaXSessionGoalEntry: shallow clone; the inner goal object is
      // already immutable (readonly fields + frozen by goal/state.ts).
      return { ...entry };
    default: {
      const exhaustiveCheck: never = entry;
      return exhaustiveCheck;
    }
  }
}

function isMessageEntry(entry: KodaXSessionEntry): entry is KodaXSessionMessageEntry {
  return entry.type === 'message';
}

function isLabelEntry(entry: KodaXSessionEntry): entry is KodaXSessionLabelEntry {
  return entry.type === 'label';
}

function isNavigableEntry(entry: KodaXSessionEntry): entry is NavigableSessionEntry {
  // Labels, goals, client notices, and rewind markers are session-level side-state, not part of the
  // navigable message thread. They live in `lineage.entries` so they
  // are persisted + cleaned up alongside their parent branch, but
  // they MUST be excluded from path/tree/context computations.
  return entry.type !== 'label'
    && entry.type !== 'goal'
    && entry.type !== 'client_notice'
    && entry.type !== 'memory_outcome_digest'
    && entry.type !== 'memory_review_receipt'
    && entry.type !== 'rewind_marker';
}

function serializeMessageContent(content: KodaXMessage['content']): string {
  return typeof content === 'string'
    ? `text:${content}`
    : `json:${JSON.stringify(content)}`;
}

function getMessageFingerprint(message: KodaXMessage): string {
  const cached = messageFingerprintCache.get(message);
  if (cached) {
    return cached;
  }

  const synthetic = message._synthetic === true ? 'synthetic' : 'real';
  const fingerprint = `${message.role}:${synthetic}:${serializeMessageContent(message.content)}`;
  messageFingerprintCache.set(message, fingerprint);
  return fingerprint;
}

function messagesEqual(left: KodaXMessage, right: KodaXMessage): boolean {
  // Fast path: since lineage entries now share message references with
  // context.messages, most matches are resolved by reference equality
  // without ever computing (and caching) a JSON.stringify fingerprint.
  if (left === right) return true;
  return getMessageFingerprint(left) === getMessageFingerprint(right);
}

function generateEntryId(prefix: 'entry' | 'label' | 'goal' = 'entry'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, ENTRY_ID_LENGTH)}`;
}

function logicalIdForEntry(entry: KodaXSessionEntry): string {
  return entry.logicalId ?? entry.id;
}

function recordMessageProvenanceSource(
  message: KodaXMessage,
  entry: NavigableSessionEntry,
): void {
  const sourceIds = messageProvenanceSourceIds.get(message) ?? new Set<string>();
  sourceIds.add(entry.id);
  messageProvenanceSourceIds.set(message, sourceIds);
}

/** Return the sole physical lineage entry proven for this message reference. */
export function getSessionMessageEntryId(message: KodaXMessage): string | undefined {
  const sourceIds = messageProvenanceSourceIds.get(message);
  if (sourceIds?.size !== 1) return undefined;
  return sourceIds.values().next().value;
}

function entryOwnsCompactionMessage(
  entry: NavigableSessionEntry,
  message: KodaXMessage,
): boolean {
  return entry.type === 'message'
    ? entry.message === message
      || messageProvenanceSourceIds.get(message)?.has(entry.id) === true
    : messageProvenanceSourceIds.get(message)?.has(entry.id) === true;
}

function inheritMessageProvenance(
  entries: readonly KodaXSessionEntry[],
  existingIds: ReadonlySet<string>,
  sourceEntries: readonly NavigableSessionEntry[],
): KodaXSessionEntry[] {
  const clones = entries.filter((entry): entry is KodaXSessionMessageEntry =>
    entry.type === 'message' && !existingIds.has(entry.id));
  const sourcesByCloneId = new Map<string, NavigableSessionEntry>();
  let sourceLimit = sourceEntries.length;
  for (let cloneIndex = clones.length - 1; cloneIndex >= 0; cloneIndex -= 1) {
    let sourceIndex = sourceLimit - 1;
    while (
      sourceIndex >= 0
      && !entryOwnsCompactionMessage(sourceEntries[sourceIndex]!, clones[cloneIndex]!.message)
    ) {
      sourceIndex -= 1;
    }
    if (sourceIndex < 0) continue;
    sourcesByCloneId.set(clones[cloneIndex]!.id, sourceEntries[sourceIndex]!);
    sourceLimit = sourceIndex;
  }
  return entries.map((entry) => {
    const source = sourcesByCloneId.get(entry.id);
    return source
      ? {
          ...entry,
          logicalId: logicalIdForEntry(source),
          sourceEntryId: source.id,
        }
      : entry;
  });
}

function cloneLineage(lineage?: KodaXSessionLineage): KodaXSessionLineage {
  // Shallow-copy the entries array so mutations (push) don't affect
  // the original, but share entry objects by reference. This avoids
  // the O(n × message_size) cost of deep-cloning every entry.
  return {
    version: 2,
    activeEntryId: lineage?.activeEntryId ?? null,
    entries: lineage?.entries ? [...lineage.entries] : [],
  };
}

function createSummaryContextMessage(
  summary: string,
  prefix: string,
  suffix: string,
): KodaXMessage {
  const isCompactionCheckpoint = prefix === COMPACTION_SUMMARY_PREFIX
    && suffix === COMPACTED_HISTORY_RECOVERY_GUIDANCE;
  return {
    role: 'user',
    content: `${prefix}${summary}${suffix}`,
    ...(isCompactionCheckpoint
      ? { _synthetic: true, _source: 'compaction-checkpoint' }
      : {}),
  };
}

function getContextMessagesForEntry(entry: NavigableSessionEntry): KodaXMessage[] {
  switch (entry.type) {
    case 'message':
      recordMessageProvenanceSource(entry.message, entry);
      return [cloneMessage(entry.message)];
    case 'compaction':
      if (entry.reason === 'rewind') {
        return [];
      }
      {
        const message = createSummaryContextMessage(
          entry.summary,
          COMPACTION_SUMMARY_PREFIX,
          COMPACTED_HISTORY_RECOVERY_GUIDANCE,
        );
        recordMessageProvenanceSource(message, entry);
        return [message];
      }
    case 'branch_summary': {
      const message = createSummaryContextMessage(
        entry.summary,
        BRANCH_SUMMARY_PREFIX,
        BRANCH_SUMMARY_SUFFIX,
      );
      recordMessageProvenanceSource(message, entry);
      return [message];
    }
    case 'archive_marker':
      return [];  // context-silent: archived content is not part of LLM context
    default: {
      const exhaustiveCheck: never = entry;
      return exhaustiveCheck;
    }
  }
}

function getChildrenMap(entries: NavigableSessionEntry[]): Map<string | null, NavigableSessionEntry[]> {
  const children = new Map<string | null, NavigableSessionEntry[]>();
  for (const entry of entries) {
    const bucket = children.get(entry.parentId) ?? [];
    bucket.push(entry);
    children.set(entry.parentId, bucket);
  }
  return children;
}

function getNavigableEntryMap(
  lineage: KodaXSessionLineage,
  checkpoint?: () => void,
): Map<string, NavigableSessionEntry> {
  const byId = new Map<string, NavigableSessionEntry>();
  for (let index = 0; index < lineage.entries.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const entry = lineage.entries[index]!;
    if (isNavigableEntry(entry)) {
      byId.set(entry.id, entry);
    }
  }
  return byId;
}

function getResolvedLabels(
  lineage: KodaXSessionLineage,
  checkpoint?: () => void,
): Map<string, string> {
  const labels = new Map<string, string>();
  for (let index = 0; index < lineage.entries.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const entry = lineage.entries[index]!;
    if (!isLabelEntry(entry)) {
      continue;
    }
    if (entry.label && entry.label.trim()) {
      labels.set(entry.targetId, entry.label.trim());
    } else {
      labels.delete(entry.targetId);
    }
  }
  return labels;
}

function entryMatchesContextMessage(
  entry: NavigableSessionEntry,
  message: KodaXMessage,
): boolean {
  if (
    entry.type === 'compaction'
    && entry.reason !== 'rewind'
    && typeof message.content === 'string'
    && (
      message.content === `${COMPACTION_SUMMARY_PREFIX}${entry.summary}${COMPACTED_HISTORY_RECOVERY_GUIDANCE}`
      || message.content === `${COMPACTION_SUMMARY_PREFIX}${entry.summary}`
    )
    && (
      message.role === 'system'
      || (
        message.role === 'user'
        && message._synthetic === true
        && message._source === 'compaction-checkpoint'
      )
    )
  ) {
    return true;
  }
  const rendered = getContextMessagesForEntry(entry);
  return rendered.length === 1 && messagesEqual(rendered[0]!, message);
}

function getTextPreview(message: KodaXMessage): string {
  if (typeof message.content === 'string') {
    return message.content.replace(/\s+/g, ' ').trim();
  }

  if (Array.isArray(message.content)) {
    const text = message.content
      .map((block) => {
        if (
          typeof block === 'object'
          && block !== null
          && 'type' in block
          && 'text' in block
          && block.type === 'text'
          && typeof block.text === 'string'
        ) {
          return block.text;
        }
        return '';
      })
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    return text || '[complex content]';
  }

  return '[complex content]';
}

function truncateText(text: string, maxLength = 120): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function summarizeBranchEntries(entries: NavigableSessionEntry[]): string {
  const goal = entries.find(
    (entry): entry is KodaXSessionMessageEntry =>
      entry.type === 'message' && entry.message.role === 'user',
  );
  const userFollowUps = entries
    .filter(
      (entry): entry is KodaXSessionMessageEntry =>
        entry.type === 'message'
        && entry.message.role === 'user'
        && entry.id !== goal?.id,
    )
    .map((entry) => truncateText(getTextPreview(entry.message), 90));
  const assistantUpdates = entries
    .filter(
      (entry): entry is KodaXSessionMessageEntry =>
        entry.type === 'message' && entry.message.role === 'assistant',
    )
    .map((entry) => truncateText(getTextPreview(entry.message), 90));
  const nestedSummaries = entries
    .filter((entry) => entry.type === 'branch_summary' || entry.type === 'compaction')
    .map((entry) => truncateText(entry.summary.replace(/\s+/g, ' ').trim(), 90));
  const latestEntry = entries[entries.length - 1];
  const latestState = latestEntry
    ? truncateText(getTextPreview(getContextMessagesForEntry(latestEntry)[0] ?? {
      role: 'user',
      content: latestEntry.type,
    }), 120)
    : undefined;

  const highlights = [
    ...assistantUpdates.slice(-2),
    ...userFollowUps.slice(-1),
    ...nestedSummaries.slice(-1),
  ].filter((item, index, values) => item.length > 0 && values.indexOf(item) === index);

  const lines = [
    'The user explored a different conversation branch before returning here.',
    '',
    `Goal: ${truncateText(goal ? getTextPreview(goal.message) : 'Explore an alternate approach from this branch point.', 120)}`,
  ];

  if (highlights.length > 0) {
    lines.push('');
    lines.push('Highlights:');
    for (const item of highlights.slice(0, 4)) {
      lines.push(`- ${item}`);
    }
  }

  if (latestState) {
    lines.push('');
    lines.push(`Latest state: ${latestState}`);
  }

  return truncateText(lines.join('\n'), MAX_BRANCH_SUMMARY_LENGTH);
}

function getCommonAncestorId(
  lineage: KodaXSessionLineage,
  leftId: string,
  rightId: string,
): string | null {
  const leftPath = getSessionLineagePath(lineage, leftId);
  const rightPath = getSessionLineagePath(lineage, rightId);
  let commonAncestorId: string | null = null;
  const limit = Math.min(leftPath.length, rightPath.length);
  for (let index = 0; index < limit; index += 1) {
    if (leftPath[index]?.id !== rightPath[index]?.id) {
      break;
    }
    commonAncestorId = leftPath[index]?.id ?? null;
  }
  return commonAncestorId;
}

function getBranchSegment(
  lineage: KodaXSessionLineage,
  ancestorId: string | null,
  leafId: string,
): NavigableSessionEntry[] {
  const path = getSessionLineagePath(lineage, leafId);
  if (!ancestorId) {
    return path;
  }

  const ancestorIndex = path.findIndex((entry) => entry.id === ancestorId);
  if (ancestorIndex === -1) {
    return path;
  }

  return path.slice(ancestorIndex + 1);
}

function recordActiveContextProvenance(
  lineage: KodaXSessionLineage,
  messages: readonly KodaXMessage[],
): void {
  let messageIndex = 0;
  for (const entry of getSessionLineagePath(lineage)) {
    for (const _rendered of getContextMessagesForEntry(entry)) {
      const message = messages[messageIndex];
      if (message !== undefined) recordMessageProvenanceSource(message, entry);
      messageIndex += 1;
    }
    if (entry.type === 'compaction' && entry.reason !== 'rewind') {
      messageIndex += entry.postCompactAttachments?.length ?? 0;
    }
  }
}

/**
 * Reconcile a linear message list against an existing lineage tree.
 *
 * Existing matching entries are reused when possible, and only the missing
 * tail is appended as new message entries.
 */
export function createSessionLineage(
  messages: KodaXMessage[],
  previous?: KodaXSessionLineage,
): KodaXSessionLineage {
  const lineage = cloneLineage(previous);
  const navigableEntries = lineage.entries.filter(isNavigableEntry);
  const children = getChildrenMap(navigableEntries);
  const priorActiveMessages = previous === undefined
    ? undefined
    : getSessionMessagesFromLineage(previous);
  const extendsPriorActivePath = previous !== undefined
    && priorActiveMessages !== undefined
    && priorActiveMessages.length <= messages.length
    && priorActiveMessages.every((message, index) =>
      messagesEqual(message, messages[index]!));
  const messageOffset = extendsPriorActivePath ? priorActiveMessages.length : 0;
  let parentId = extendsPriorActivePath && previous !== undefined
    ? previous.activeEntryId
    : null;
  let activeEntryId = parentId;
  if (extendsPriorActivePath && previous !== undefined) {
    recordActiveContextProvenance(previous, messages.slice(0, messageOffset));
  }

  for (let index = messageOffset; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (isPostCompactAttachment(message)) continue;
    // An exact positional prefix is identity evidence: the remaining suffix is
    // new input after the known active leaf. Never content-match that suffix to
    // an abandoned sibling, because a user may intentionally repeat the same
    // query. The fallback below remains for rewind/branch reconciliation where
    // the incoming sequence is not an extension of the prior active context.
    const existing: NavigableSessionEntry | undefined = extendsPriorActivePath
      ? undefined
      : [...(children.get(parentId) ?? [])]
          .reverse()
          .find((entry) => entryMatchesContextMessage(entry, message));

    if (existing) {
      recordMessageProvenanceSource(message, existing);
      activeEntryId = existing.id;
      parentId = existing.id;
      continue;
    }

    const entryId = generateEntryId();
    const entry: KodaXSessionMessageEntry = {
      type: 'message',
      id: entryId,
      parentId,
      logicalId: entryId,
      // Prefer the message's own finalize-time timestamp so a whole managed task
      // (accounted in one synchronous batch here) no longer collapses to a single
      // save-time millisecond. Falls back to accounting-time when absent (old
      // sessions / not-yet-stamped paths) — the fingerprint (role:synthetic:
      // content) ignores timestamp, so this never affects resume dedup.
      timestamp: message.timestamp ?? new Date().toISOString(),
      message: cloneMessage(message),
    };
    lineage.entries.push(entry);
    recordMessageProvenanceSource(message, entry);
    const bucket = children.get(parentId) ?? [];
    bucket.push(entry);
    children.set(parentId, bucket);
    activeEntryId = entry.id;
    parentId = entry.id;
  }

  lineage.activeEntryId = activeEntryId;
  if (previous !== undefined && !extendsPriorActivePath) {
    // A context rewrite may reattach an already delivered message below a new
    // parent. Preserve only its proven source identity; equal text is not an alias.
    lineage.entries = inheritMessageProvenance(
      lineage.entries,
      new Set(previous.entries.map((entry) => entry.id)),
      getSessionLineagePath(previous),
    );
  }
  return lineage;
}

/**
 * Walk the lineage from a target entry back to the root.
 *
 * Traversal stops safely if malformed data introduces a parent cycle.
 */
export function getSessionLineagePath(
  lineage: KodaXSessionLineage,
  targetId: string | null = lineage.activeEntryId,
  checkpoint?: () => void,
): NavigableSessionEntry[] {
  if (!targetId) {
    return [];
  }

  const byId = getNavigableEntryMap(lineage, checkpoint);
  const path: NavigableSessionEntry[] = [];
  const visited = new Set<string>();
  let current = byId.get(targetId);
  let traversed = 0;
  while (current) {
    if (traversed > 0 && traversed % 256 === 0) checkpoint?.();
    if (visited.has(current.id)) {
      break;
    }
    visited.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
    traversed += 1;
  }
  checkpoint?.();
  return path.reverse();
}

/**
 * Build the effective LLM-visible message context for the active lineage path.
 *
 * FEATURE_072: for non-rewind compaction entries that carry
 * `postCompactAttachments`, the slicer inlines attachments immediately after
 * the summary. `getContextMessagesForEntry` stays 1-to-1 — attachments are a
 * slicer-layer concern, which preserves the contract
 * `entryMatchesContextMessage` and FEATURE_073's future firstKeptEntryId-based
 * slicing both depend on.
 * Native rewind audits are `rewind_marker` entries and never reach this path;
 * the `reason !== 'rewind'` guard keeps legacy persisted rewind compactions
 * context-silent.
 */
export function getSessionMessagesFromLineage(
  lineage: KodaXSessionLineage,
  targetId: string | null = lineage.activeEntryId,
): KodaXMessage[] {
  const messages: KodaXMessage[] = [];
  for (const entry of getSessionLineagePath(lineage, targetId)) {
    for (const message of getContextMessagesForEntry(entry)) {
      messages.push(cloneMessage(message));
    }
    if (
      entry.type === 'compaction'
      && entry.reason !== 'rewind'
      && entry.postCompactAttachments
      && entry.postCompactAttachments.length > 0
    ) {
      for (const message of entry.postCompactAttachments) {
        messages.push(cloneMessage(message));
      }
    }
  }
  return messages;
}

/**
 * Resolve an entry selector using either a direct entry id or the latest label.
 */
export function resolveSessionLineageTarget(
  lineage: KodaXSessionLineage,
  selector: string,
  checkpoint?: () => void,
): NavigableSessionEntry | undefined {
  const normalizedSelector = selector.trim();
  if (!normalizedSelector) {
    return undefined;
  }

  const byId = getNavigableEntryMap(lineage, checkpoint);
  const direct = byId.get(normalizedSelector);
  if (direct && direct.type !== 'archive_marker') {
    return direct;
  }

  const labels = getResolvedLabels(lineage, checkpoint);
  const labeledTargetId = [...labels.entries()]
    .find(([, label]) => label === normalizedSelector)?.[0];
  if (!labeledTargetId) return undefined;
  const labeledTarget = byId.get(labeledTargetId);
  return (labeledTarget && labeledTarget.type !== 'archive_marker') ? labeledTarget : undefined;
}

/**
 * Move the active leaf to a selected target, optionally appending a
 * branch-summary node that captures the abandoned path.
 */
export function setSessionLineageActiveEntry(
  lineage: KodaXSessionLineage,
  selector: string,
  options: KodaXSessionNavigationOptions = {},
): KodaXSessionLineage | null {
  const target = resolveSessionLineageTarget(lineage, selector);
  if (!target) {
    return null;
  }

  const entries = lineage.entries.map(cloneEntry);
  let activeEntryId = target.id;

  if (
    options.summarizeCurrentBranch
    && lineage.activeEntryId
    && lineage.activeEntryId !== target.id
  ) {
    const commonAncestorId = getCommonAncestorId(
      lineage,
      lineage.activeEntryId,
      target.id,
    );
    const abandonedEntries = getBranchSegment(
      lineage,
      commonAncestorId,
      lineage.activeEntryId,
    );

    if (abandonedEntries.length > 0) {
      const summaryEntryId = generateEntryId();
      const summaryEntry: KodaXSessionBranchSummaryEntry = {
        type: 'branch_summary',
        id: summaryEntryId,
        parentId: target.id,
        timestamp: new Date().toISOString(),
        logicalId: summaryEntryId,
        fromId: lineage.activeEntryId,
        summary: summarizeBranchEntries(abandonedEntries),
        details: {
          commonAncestorId,
          abandonedEntryIds: abandonedEntries.map((entry) => entry.id),
          abandonedEntryCount: abandonedEntries.length,
        },
      };
      entries.push(summaryEntry);
      activeEntryId = summaryEntry.id;
    }
  }

  return {
    version: 2,
    activeEntryId,
    entries,
  };
}

/**
 * Append a label change entry that bookmarks a lineage node.
 */
export function appendSessionLineageLabel(
  lineage: KodaXSessionLineage,
  selector: string,
  label?: string,
): KodaXSessionLineage | null {
  const target = resolveSessionLineageTarget(lineage, selector);
  if (!target) {
    return null;
  }

  const normalizedLabel = label?.trim();
  const entries = lineage.entries.map(cloneEntry);
  const entryId = generateEntryId('label');
  entries.push({
    type: 'label',
    id: entryId,
    parentId: lineage.activeEntryId,
    timestamp: new Date().toISOString(),
    logicalId: entryId,
    targetId: target.id,
    label: normalizedLabel || undefined,
  });

  return {
    version: 2,
    activeEntryId: lineage.activeEntryId,
    entries,
  };
}

/**
 * Apply a compaction event to the lineage.
 *
 * FEATURE_072 signature change: `keptMessages` (the post-summary tail that
 * will become lineage entries) and `postCompactAttachments` (ledger +
 * file-content messages that live on the CompactionEntry itself) are now
 * separate parameters. The kept tail MUST NOT include attachments — otherwise
 * they would be double-stored (once as message entries in lineage, once on
 * the compaction entry). Phase A keeps `postCompactAttachments` optional so
 * current callers that pass `[]` (or omit it) behave identically to today.
 * Phase B migrates callers to supply real attachments.
 */
export function applySessionCompaction(
  lineage: KodaXSessionLineage | undefined,
  compactedMessages: KodaXMessage[],
  anchor: {
    summary: string;
    tokensBefore?: number;
    tokensAfter?: number;
    artifactLedgerId?: string;
    reason?: string;
    details?: KodaXJsonValue | CompactionDetails;
    memorySeed?: KodaXCompactMemorySeed;
  },
  postCompactAttachments: readonly KodaXMessage[] = [],
): KodaXSessionLineage {
  const sourceEntries = lineage ? getSessionLineagePath(lineage) : [];
  const base = cloneLineage(lineage);
  const compactionEntryId = generateEntryId();
  const compactionEntry: KodaXSessionCompactionEntry = {
    type: 'compaction',
    id: compactionEntryId,
    parentId: null,
    logicalId: compactionEntryId,
    timestamp: new Date().toISOString(),
    summary: anchor.summary,
    tokensBefore: anchor.tokensBefore,
    tokensAfter: anchor.tokensAfter,
    artifactLedgerId: anchor.artifactLedgerId,
    reason: anchor.reason,
    details: normalizeCompactionDetails(anchor.details),
    memorySeed: cloneMemorySeed(anchor.memorySeed),
    postCompactAttachments: postCompactAttachments.length > 0
      ? postCompactAttachments
      : undefined,
  };

  base.entries.push(compactionEntry);
  base.activeEntryId = compactionEntryId;

  // FEATURE_072 defensive strip: if the caller passed an array that still has
  // `[Post-compact: ...]` messages inlined (legacy path where agent.ts called
  // `injectPostCompactAttachments` before emitting onCompactedMessages), drop
  // them here — attachments live on the CompactionEntry, never as inline
  // message entries. Idempotent: if the caller already stripped, this is a no-op.
  let keptMessages = compactedMessages.some(isPostCompactAttachment)
    ? compactedMessages.filter((m) => !isPostCompactAttachment(m))
    : compactedMessages;

  // FEATURE_180 (v0.7.42): dedup duplicate system messages by content hash.
  // Forensic finding from 788-session scan: 47% of sessions persist 2+ copies
  // of the Repository Intelligence block (~13K tokens each); worst observed
  // case had 65 copies. Root cause is multiple write paths (compaction commit
  // + handoff replaceSystemMessage + V2 swap) each appending the same
  // instructions block as a new lineage entry. Without dedup at the
  // applySessionCompaction boundary, RI accumulates monotonically across
  // compaction cycles — every compaction inflates the kept transcript by
  // another 13K of redundant system payload, defeating compaction's purpose.
  // Dedup uses string-identity on `content` (cheaper than crypto hash and
  // sufficient — RI blocks are bytewise identical when they originate from
  // the same `provider.systemPrompt` build). Non-system messages are never
  // deduped (legitimate repeated user/assistant content must be preserved).
  const seenSystemContent = new Set<string>();
  const filteredForDedup: KodaXMessage[] = [];
  let droppedDups = 0;
  for (const m of keptMessages) {
    if (m.role === 'system' && typeof m.content === 'string') {
      if (seenSystemContent.has(m.content)) {
        droppedDups++;
        continue;
      }
      seenSystemContent.add(m.content);
    }
    filteredForDedup.push(m);
  }
  if (droppedDups > 0) {
    keptMessages = filteredForDedup;
  }

  const existingIds = new Set(base.entries.map((entry) => entry.id));
  const next = createSessionLineage(keptMessages, base);
  const entriesWithProvenance = inheritMessageProvenance(
    next.entries,
    existingIds,
    sourceEntries,
  );
  const nextWithProvenance = {
    ...next,
    entries: entriesWithProvenance,
  };
  const activePath = getSessionLineagePath(nextWithProvenance);
  const compactionIndex = activePath.findIndex((entry) => entry.id === compactionEntryId);
  const firstKeptEntryId = compactionIndex >= 0
    ? activePath[compactionIndex + 1]?.id
    : undefined;

  const result: KodaXSessionLineage = {
    ...nextWithProvenance,
    entries: nextWithProvenance.entries.map((entry) => entry.id === compactionEntryId
      ? {
        ...entry,
        firstKeptEntryId,
      }
      : entry),
  };

  // The host must durably persist this exact pre-compaction lineage before it
  // may release old-island bodies from memory. Keeping eviction explicit is
  // the transaction boundary that prevents a failed save from destroying the
  // only exact copy of compacted history.
  return result;
}

/**
 * FEATURE_072 §7a: reconcile lineage after graceful-degradation trimming.
 *
 * Unlike `applySessionCompaction` (which creates a new island with a summary
 * CompactionEntry), graceful degradation is atomic-block trimming — no LLM
 * summary, no ledger re-injection. Routing it through `applySessionCompaction`
 * would produce a degenerate CompactionEntry with `summary: ''` that pollutes
 * the lineage view and session-tree UI.
 *
 * Instead, `applyLineageTruncation` reconciles the lineage against the trimmed
 * flat messages via `createSessionLineage`, which will:
 *   - Match surviving messages to existing entries (reference or fingerprint)
 *   - Drop unmatched entries from the active path
 * Fingerprint lookup handles the "trimmed tool_result content changed" case:
 * the trimmed message gets a new entry id under the same parent chain.
 *
 * This is distinct from `applySessionCompaction`: no new CompactionEntry is
 * appended, no summary is written, no island root is created. The lineage
 * stays on the same island; only the tail shape changes.
 *
 * Reserved for a future caller (v0.7.20 Phase C / v0.7.25 FEATURE_073). Phase B
 * defines the helper; no production caller yet.
 */
export function applyLineageTruncation(
  lineage: KodaXSessionLineage | undefined,
  trimmedMessages: KodaXMessage[],
): KodaXSessionLineage {
  return createSessionLineage(trimmedMessages, lineage);
}

/**
 * Replace message content of entries in old islands (not the active island)
 * with a lightweight placeholder.  This releases large tool_result payloads
 * from memory while preserving the entry skeleton for tree structure.
 *
 * Hosts call this only after the exact lineage has been durably committed.
 */
export function evictOldIslandMessageContent(lineage: KodaXSessionLineage): KodaXSessionLineage {
  if (!lineage.activeEntryId || lineage.entries.length === 0) {
    return lineage;
  }

  const byId = new Map(lineage.entries.map((e) => [e.id, e]));

  // Find current island root
  let activeRootId: string | null = null;
  let cur: KodaXSessionEntry | undefined = byId.get(lineage.activeEntryId);
  while (cur) {
    activeRootId = cur.id;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }

  // Mark all entries reachable from the active island root (DFS via
  // queue.pop(); traversal order doesn't matter, only reachability does).
  const currentIsland = new Set<string>();
  if (activeRootId) {
    const childrenOf = new Map<string, string[]>();
    for (const entry of lineage.entries) {
      if (entry.parentId) {
        const bucket = childrenOf.get(entry.parentId) ?? [];
        bucket.push(entry.id);
        childrenOf.set(entry.parentId, bucket);
      }
    }
    const queue = [activeRootId];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (currentIsland.has(id)) continue;
      currentIsland.add(id);
      for (const childId of (childrenOf.get(id) ?? [])) {
        queue.push(childId);
      }
    }
  }

  // Evict heavy content from old island entries.
  //
  // Two entry types carry heavy payload that grows unboundedly across
  // compactions if not evicted:
  //   - `message`: full tool_result / thinking content
  //   - `compaction.postCompactAttachments` (FEATURE_072): ledger summary +
  //     file-content messages (≤50k tokens). Without eviction, each
  //     compaction adds a new island-root CompactionEntry whose attachments
  //     live forever in the serialized entries array, reproducing the
  //     monotonic-growth pathology FEATURE_072 exists to fix in a new shape.
  //
  // `summary`, `firstKeptEntryId`, and `memorySeed` stay on old CompactionEntries:
  // - `summary` is small and used by session-tree UI preview
  // - `memorySeed` is small and may still be read by a cross-session resume
  // - `firstKeptEntryId` is structural; removing it would break navigation
  let changed = false;
  const evicted = lineage.entries.map((entry) => {
    if (currentIsland.has(entry.id)) return entry;

    if (entry.type === 'message') {
      // Old island message: replace content with a block-array placeholder.
      // Using the canonical block shape (not a bare string) keeps downstream
      // serialization/tokenization code paths — which iterate content blocks
      // via `msg.content as KodaXContentBlock[]` — working without special-cases.
      changed = true;
      return {
        ...entry,
        message: {
          role: entry.message.role,
          content: [{ type: 'text', text: '[compacted]' }],
        } as KodaXMessage,
      };
    }

    if (entry.type === 'compaction' && entry.postCompactAttachments?.length) {
      changed = true;
      return {
        ...entry,
        postCompactAttachments: undefined,
      };
    }

    return entry;
  });

  return changed ? { ...lineage, entries: evicted } : lineage;
}

function cloneForkableEntry(
  entry: NavigableSessionEntry,
  parentId: string | null,
): NavigableSessionEntry {
  const entryId = generateEntryId();
  const base = {
    id: entryId,
    parentId,
    timestamp: entry.timestamp,
    logicalId: logicalIdForEntry(entry),
    sourceEntryId: entry.id,
  };
  switch (entry.type) {
    case 'message':
      return {
        ...base,
        type: 'message',
        // Fork creates a genuinely independent branch — deep-clone the
        // message so modifications in one branch don't affect the other.
        message: structuredClone(entry.message),
      };
    case 'compaction':
      return {
        ...base,
        type: 'compaction',
        summary: entry.summary,
        firstKeptEntryId: entry.firstKeptEntryId,
        tokensBefore: entry.tokensBefore,
        tokensAfter: entry.tokensAfter,
        artifactLedgerId: entry.artifactLedgerId,
        reason: entry.reason,
        details: cloneJsonValue(entry.details),
        memorySeed: cloneMemorySeed(entry.memorySeed),
        // FEATURE_072: fork carries attachments to the new branch so the
        // forked leaf's derived view includes the ledger + file context
        // that existed at the fork point.
        postCompactAttachments: entry.postCompactAttachments
          ? entry.postCompactAttachments.map((m) => structuredClone(m))
          : undefined,
      };
    case 'branch_summary':
      return {
        ...base,
        type: 'branch_summary',
        summary: entry.summary,
        fromId: entry.fromId,
        details: cloneJsonValue(entry.details),
      };
    case 'archive_marker':
      return {
        ...base,
        type: 'archive_marker',
        archiveBatchId: entry.archiveBatchId,
        archivedEntryCount: entry.archivedEntryCount,
        summary: entry.summary,
      };
    default: {
      const exhaustiveCheck: never = entry;
      return exhaustiveCheck;
    }
  }
}

/**
 * Rewind the current session lineage to a target entry, truncating all entries after it.
 * Records a rewind event in the lineage for auditability.
 * Returns null if targetEntryId is not found.
 *
 * @param lineage - The session lineage to rewind
 * @param targetEntryId - The entry ID to rewind to (inclusive)
 * @returns A new lineage with entries truncated after the target, or null if target not found
 */
/**
 * Find the entry ID of the second-to-last user message in the lineage.
 * Used by `/rewind` (no argument) to go back one conversational turn.
 * Returns null if fewer than 2 user messages exist.
 */
function isToolResultOnlyUserMessage(message: KodaXMessage): boolean {
  return message.role === 'user'
    && Array.isArray(message.content)
    && message.content.length > 0
    && message.content.every((block) => block.type === 'tool_result');
}

function isRealUserPromptEntry(entry: KodaXSessionEntry): entry is KodaXSessionMessageEntry {
  return entry.type === 'message'
    && entry.message.role === 'user'
    && entry.message._synthetic !== true
    && !isToolResultOnlyUserMessage(entry.message);
}

export function findPreviousUserEntryId(lineage: KodaXSessionLineage): string | null {
  const entries = getSessionLineagePath(lineage);
  let found = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && isRealUserPromptEntry(entry)) {
      found++;
      if (found === 2) {
        return entry.id;
      }
    }
  }
  return null;
}

export function rewindSessionLineage(
  lineage: KodaXSessionLineage,
  targetEntryId: string,
): KodaXSessionLineage | null {
  const target = getNavigableEntryMap(lineage).get(targetEntryId);
  if (
    !target
    || target.type === 'archive_marker'
    || (target.type === 'compaction' && target.reason === 'rewind')
  ) {
    return null;
  }

  // Find the target entry index in the lineage
  const entries = lineage.entries;
  const targetIndex = entries.findIndex(e => e.id === target.id);
  if (targetIndex < 0) {
    return null;
  }

  // Truncate entries after target (keep up to and including target)
  const keptEntries = entries.slice(0, targetIndex + 1);
  const truncatedCount = entries.length - targetIndex - 1;

  // Create a rewind event entry to record this action
  const rewindEntryId = generateEntryId();
  const rewindEntry: KodaXSessionRewindMarkerEntry = {
    type: 'rewind_marker',
    id: rewindEntryId,
    parentId: target.id,
    timestamp: new Date().toISOString(),
    logicalId: rewindEntryId,
    targetId: target.id,
    ...(lineage.activeEntryId ? { fromId: lineage.activeEntryId } : {}),
    truncatedCount,
    summary: `Rewound to entry ${target.id} (truncated ${truncatedCount} entries)`,
  };

  return {
    version: 2,
    activeEntryId: target.id,
    entries: [...keptEntries, rewindEntry],
  };
}

export function forkSessionLineage(
  lineage: KodaXSessionLineage,
  selector?: string,
  checkpoint?: () => void,
): KodaXSessionLineage | null {
  const target = selector
    ? resolveSessionLineageTarget(lineage, selector, checkpoint)
    : lineage.activeEntryId
      ? resolveSessionLineageTarget(lineage, lineage.activeEntryId, checkpoint)
      : undefined;
  if (!target) {
    return null;
  }

  const path = getSessionLineagePath(lineage, target.id, checkpoint);
  const idMap = new Map<string, string>();
  const entries: KodaXSessionEntry[] = [];

  let parentId: string | null = null;
  for (let index = 0; index < path.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const entry = path[index]!;
    const cloned = cloneForkableEntry(entry, parentId);
    entries.push(cloned);
    idMap.set(entry.id, cloned.id);
    parentId = cloned.id;
  }

  for (let index = 0; index < path.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const source = path[index]!;
    const cloned = entries[index]!;
    if (
      source.type === 'compaction'
      && cloned.type === 'compaction'
      && source.firstKeptEntryId !== undefined
    ) {
      const firstKeptEntryId = idMap.get(source.firstKeptEntryId);
      entries[index] = { ...cloned, firstKeptEntryId };
    }
    if (source.type === 'branch_summary' && cloned.type === 'branch_summary') {
      entries[index] = {
        ...cloned,
        ...(source.fromId !== undefined
          ? { fromId: idMap.get(source.fromId) ?? source.fromId }
          : {}),
      };
    }
  }

  const labels = getResolvedLabels(lineage, checkpoint);
  for (let index = 0; index < path.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    const entry = path[index]!;
    const label = labels.get(entry.id);
    const targetId = idMap.get(entry.id);
    if (!label || !targetId) {
      continue;
    }
    const labelEntryId = generateEntryId('label');
    const labelEntry: KodaXSessionLabelEntry = {
      type: 'label',
      id: labelEntryId,
      parentId,
      timestamp: new Date().toISOString(),
      logicalId: labelEntryId,
      targetId,
      label,
    };
    entries.push(labelEntry);
    parentId = labelEntry.id;
  }

  // FEATURE_192 v0.7.44 — carry the active goal forward to the fork.
  // Parity with the label-carry block above: `/goal` is session-level
  // state and forking the active branch should not silently drop it.
  // If the latest on-branch goal entry is `cleared`, the goal is null
  // and there is nothing to carry. If non-null, append a new goal
  // entry attached to the fork's tip with the same goal state — the
  // goal `id` survives so consumers can correlate progress across the
  // fork.
  const sourceLatestGoal = findLatestGoalOnPath(lineage, path, checkpoint);
  if (sourceLatestGoal && sourceLatestGoal.goal) {
    const goalEntryId = generateEntryId('goal');
    const carriedGoalEntry: KodaXSessionGoalEntry = {
      type: 'goal',
      id: goalEntryId,
      parentId,
      timestamp: new Date().toISOString(),
      logicalId: logicalIdForEntry(sourceLatestGoal),
      sourceEntryId: sourceLatestGoal.id,
      goal: sourceLatestGoal.goal,
      // Reuse the source event ('created' / 'updated' / 'paused' / etc.)
      // so the fork's transcript honestly reflects the goal's last state
      // at fork time, rather than fabricating a 'created' event.
      event: sourceLatestGoal.event,
    };
    entries.push(carriedGoalEntry);
  }

  return {
    version: 2,
    activeEntryId: idMap.get(target.id) ?? null,
    entries,
  };
}

function findLatestGoalOnPath(
  lineage: KodaXSessionLineage,
  path: NavigableSessionEntry[],
  checkpoint?: () => void,
): KodaXSessionGoalEntry | null {
  if (path.length === 0) return null;
  const pathIds = new Set<string>();
  for (let index = 0; index < path.length; index += 1) {
    if (index > 0 && index % 256 === 0) checkpoint?.();
    pathIds.add(path[index]!.id);
  }
  // Reverse iteration so insertion order breaks ties on same-ms
  // timestamps — `/goal new` after a `complete` goal emits
  // `(complete → cleared → created)` in the same Date.now() ms, and
  // a strict `>` comparison would strand the latest (`created`)
  // behind the earliest match. Mirrors `goal-helpers.readLatestGoalFromBranch`.
  let latest: KodaXSessionGoalEntry | null = null;
  for (let i = lineage.entries.length - 1; i >= 0; i--) {
    const scanned = lineage.entries.length - 1 - i;
    if (scanned > 0 && scanned % 256 === 0) checkpoint?.();
    const entry = lineage.entries[i];
    if (entry.type !== 'goal') continue;
    if (entry.parentId === null || !pathIds.has(entry.parentId)) continue;
    if (latest === null) {
      latest = entry;
      continue;
    }
    if (entry.timestamp > latest.timestamp) {
      latest = entry;
    }
  }
  return latest;
}

/**
 * Convert a lineage into a nested tree structure for UI presentation.
 */
export function buildSessionTree(lineage: KodaXSessionLineage): KodaXSessionTreeNode[] {
  const entries = lineage.entries.filter(isNavigableEntry);
  const labels = getResolvedLabels(lineage);
  const activePathIds = new Set(getSessionLineagePath(lineage).map((entry) => entry.id));
  const nodeMap = new Map<string, KodaXSessionTreeNode>();

  for (const entry of entries) {
    nodeMap.set(entry.id, {
      entry: cloneEntry(entry) as NavigableSessionEntry,
      children: [],
      label: labels.get(entry.id),
      active: activePathIds.has(entry.id),
    });
  }

  const roots: KodaXSessionTreeNode[] = [];
  for (const entry of entries) {
    const node = nodeMap.get(entry.id);
    if (!node) {
      continue;
    }
    if (!entry.parentId) {
      roots.push(node);
      continue;
    }
    const parent = nodeMap.get(entry.parentId);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * Count the effective context messages on the active lineage path.
 */
export function countActiveLineageMessages(lineage: KodaXSessionLineage): number {
  return getSessionMessagesFromLineage(lineage).length;
}

/**
 * Archive message entries from old "islands" (disconnected subtrees).
 *
 * Each compaction entry has parentId: null, creating an independent island.
 * The active leaf lives in one island (the "current" island). All other
 * islands are considered "old" and eligible for archival.
 *
 * A "preserve closure" is computed first:
 *  - All entries in the current island (active path + recent branches)
 *  - Label targets and their ancestor chains
 *  - Non-message entries and their ancestor chains (prevents tree drift)
 *
 * Only entries outside the preserve closure are archived.
 */
export function archiveOldIslands(lineage: KodaXSessionLineage): {
  slimmedLineage: KodaXSessionLineage;
  archivedEntries: KodaXSessionEntry[];
  archivedCount: number;
  archiveBatchId: string;
} {
  if (!lineage.activeEntryId || lineage.entries.length === 0) {
    return { slimmedLineage: lineage, archivedEntries: [], archivedCount: 0, archiveBatchId: '' };
  }

  const byId = new Map(lineage.entries.map((e) => [e.id, e]));
  const preserved = new Set<string>();

  // Helper: walk parentId chain upward, marking everything as preserved
  function preserveAncestorChain(entryId: string): void {
    let cur = byId.get(entryId);
    while (cur && !preserved.has(cur.id)) {
      preserved.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }

  // 1. Find the current island root (the root that active leaf traces back to)
  let activeRootId: string | null = null;
  let cur: KodaXSessionEntry | undefined = byId.get(lineage.activeEntryId);
  while (cur) {
    activeRootId = cur.id;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }

  // 2. Build parent→children index for BFS
  const childrenOf = new Map<string, string[]>();
  for (const entry of lineage.entries) {
    if (entry.parentId) {
      const bucket = childrenOf.get(entry.parentId) ?? [];
      bucket.push(entry.id);
      childrenOf.set(entry.parentId, bucket);
    }
  }

  // 3. Preserve the entire current island (BFS from activeRoot)
  if (activeRootId) {
    const queue = [activeRootId];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (preserved.has(id)) continue;
      preserved.add(id);
      for (const childId of (childrenOf.get(id) ?? [])) {
        queue.push(childId);
      }
    }
  }

  // 4. Preserve label targets and their ancestor chains
  for (const entry of lineage.entries) {
    if (entry.type === 'label') {
      preserveAncestorChain((entry as KodaXSessionLabelEntry).targetId);
    }
  }

  // 5. Preserve all non-message entries (they're small) + their ancestor chains
  for (const entry of lineage.entries) {
    if (entry.type !== 'message') {
      preserved.add(entry.id);
    }
  }
  for (const entry of lineage.entries) {
    if (entry.type !== 'message' && entry.parentId) {
      preserveAncestorChain(entry.parentId);
    }
  }

  // 6. Retained-suffix physical references: a preserved clone's sourceEntryId must stay
  // addressable in the slimmed lineage, so never archive the direct predecessor a live
  // clone points at (one hop — bounded retention; older generations archive naturally
  // once no newest clone references them). logicalId references are deliberately not
  // excluded: logical identity is stable by design and resolves through the archive
  // merge-back. A retained predecessor's own parentId may point at a now-archived
  // ancestor (one hop keeps the predecessor, not its chain); that dangling parent
  // is licensed topology and resolves through the same merge-back.
  const referencedByRetained = collectReferencedByRetained(lineage, preserved, byId);
  // 7. Collect entries to archive (everything NOT in preserve closure and not referenced)
  const toArchive: KodaXSessionEntry[] = [];
  const toArchiveIds = new Set<string>();
  for (const entry of lineage.entries) {
    if (!preserved.has(entry.id) && !referencedByRetained.has(entry.id)) {
      toArchive.push(entry);
      toArchiveIds.add(entry.id);
    }
  }

  if (toArchive.length === 0) {
    return { slimmedLineage: lineage, archivedEntries: [], archivedCount: 0, archiveBatchId: '' };
  }

  // 8. Generate archive batch ID and markers (one per old island group)
  const archiveBatchId = `batch_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  // Group archived entries by their connected subtree root
  const islandGroups = new Map<string, KodaXSessionEntry[]>();
  for (const entry of toArchive) {
    // Walk up through archived entries to find the topmost archived entry
    let root = entry;
    let walk = entry.parentId ? byId.get(entry.parentId) : undefined;
    while (walk && toArchiveIds.has(walk.id)) {
      root = walk;
      walk = walk.parentId ? byId.get(walk.parentId) : undefined;
    }
    const bucket = islandGroups.get(root.id) ?? [];
    bucket.push(entry);
    islandGroups.set(root.id, bucket);
  }

  const markers: KodaXSessionArchiveMarkerEntry[] = [];
  for (const [rootId, entries] of islandGroups) {
    const firstEntry = entries[0]!;
    const msgEntries = entries.filter((e): e is KodaXSessionMessageEntry => e.type === 'message');
    const preview = extractArchivePreview(msgEntries);

    // Attach marker to the nearest retained parent so tree topology
    // doesn't drift.  If the archived group's root had a parent that's
    // still retained (preserved, or kept one hop as a referenced direct
    // predecessor), the marker becomes a child of that parent instead of
    // a new root.
    const groupRoot = byId.get(rootId);
    const nearestPreservedParent = groupRoot?.parentId
      && (preserved.has(groupRoot.parentId) || referencedByRetained.has(groupRoot.parentId))
      ? groupRoot.parentId
      : null;
    const markerEntryId = generateEntryId();
    markers.push({
      type: 'archive_marker',
      id: markerEntryId,
      parentId: nearestPreservedParent,
      timestamp: firstEntry.timestamp,
      logicalId: markerEntryId,
      archiveBatchId,
      archivedEntryCount: entries.length,
      summary: `Archived: ${entries.length} entries. ${preview}`.slice(0, 600),
    });
  }

  // 9. Build slimmed lineage
  const slimmedEntries = [
    ...lineage.entries.filter((e) => !toArchiveIds.has(e.id)),
    ...markers,
  ];

  return {
    slimmedLineage: { ...lineage, entries: slimmedEntries },
    archivedEntries: toArchive,
    archivedCount: toArchive.length,
    archiveBatchId,
  };
}

/** One-hop direct predecessors referenced by preserved message clones (Issue 186). */
function collectReferencedByRetained(
  lineage: KodaXSessionLineage,
  preserved: ReadonlySet<string>,
  byId: ReadonlyMap<string, KodaXSessionEntry>,
): Set<string> {
  const referenced = new Set<string>();
  for (const entry of lineage.entries) {
    if (!preserved.has(entry.id) || entry.type !== 'message') continue;
    const ref = entry.sourceEntryId;
    if (ref !== undefined && ref !== entry.id && byId.has(ref) && !preserved.has(ref)) {
      referenced.add(ref);
    }
  }
  return referenced;
}

function isTextContentBlock(block: unknown): block is { type: 'text'; text: string } {
  return typeof block === 'object'
    && block !== null
    && (block as { type?: unknown }).type === 'text'
    && typeof (block as { text?: unknown }).text === 'string';
}

function extractArchivePreview(entries: KodaXSessionMessageEntry[]): string {
  const first = entries.find((e) => e.message?.role === 'user');
  if (!first?.message) return '';
  const msg = first.message;
  if (typeof msg.content === 'string') return msg.content.slice(0, 200);
  if (Array.isArray(msg.content)) {
    return msg.content.find(isTextContentBlock)?.text.slice(0, 200) ?? '';
  }
  return '';
}
