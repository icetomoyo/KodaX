import { randomUUID } from 'node:crypto';
import type { CompactionDetails } from './compaction/types.js';
import type {
  KodaXCompactMemorySeed,
  KodaXJsonValue,
  KodaXMessage,
  KodaXSessionArchiveMarkerEntry,
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionBranchSummaryEntry,
  KodaXSessionCompactionEntry,
  KodaXSessionEntry,
  KodaXSessionLabelEntry,
  KodaXSessionLineage,
  KodaXSessionMessageEntry,
  KodaXSessionNavigationOptions,
  KodaXSessionTreeNode,
} from './types.js';

type NavigableSessionEntry = Exclude<KodaXSessionEntry, KodaXSessionLabelEntry>;

const ENTRY_ID_LENGTH = 12;
const MAX_BRANCH_SUMMARY_LENGTH = 600;
const messageFingerprintCache = new WeakMap<KodaXMessage, string>();
const COMPACTION_SUMMARY_PREFIX = '[\u5bf9\u8bdd\u5386\u53f2\u6458\u8981]\n\n';
const COMPACTION_SUMMARY_SUFFIX = '';
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
  return entry.type !== 'label';
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

  const fingerprint = `${message.role}:${serializeMessageContent(message.content)}`;
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

function generateEntryId(prefix: 'entry' | 'label' = 'entry'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, ENTRY_ID_LENGTH)}`;
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
  return {
    role: suffix ? 'user' : 'system',
    content: `${prefix}${summary}${suffix}`,
  };
}

function getContextMessagesForEntry(entry: NavigableSessionEntry): KodaXMessage[] {
  switch (entry.type) {
    case 'message':
      return [cloneMessage(entry.message)];
    case 'compaction':
      return [
        createSummaryContextMessage(
          entry.summary,
          COMPACTION_SUMMARY_PREFIX,
          COMPACTION_SUMMARY_SUFFIX,
        ),
      ];
    case 'branch_summary':
      return [
        createSummaryContextMessage(
          entry.summary,
          BRANCH_SUMMARY_PREFIX,
          BRANCH_SUMMARY_SUFFIX,
        ),
      ];
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

function getNavigableEntryMap(lineage: KodaXSessionLineage): Map<string, NavigableSessionEntry> {
  const byId = new Map<string, NavigableSessionEntry>();
  for (const entry of lineage.entries) {
    if (isNavigableEntry(entry)) {
      byId.set(entry.id, entry);
    }
  }
  return byId;
}

function getResolvedLabels(lineage: KodaXSessionLineage): Map<string, string> {
  const labels = new Map<string, string>();
  for (const entry of lineage.entries) {
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

  let parentId: string | null = null;
  let activeEntryId: string | null = null;

  for (const message of messages) {
    const existing: NavigableSessionEntry | undefined = [...(children.get(parentId) ?? [])]
      .reverse()
      .find((entry) => entryMatchesContextMessage(entry, message));

    if (existing) {
      activeEntryId = existing.id;
      parentId = existing.id;
      continue;
    }

    const entry: KodaXSessionMessageEntry = {
      type: 'message',
      id: generateEntryId(),
      parentId,
      timestamp: new Date().toISOString(),
      message: cloneMessage(message),
    };
    lineage.entries.push(entry);
    const bucket = children.get(parentId) ?? [];
    bucket.push(entry);
    children.set(parentId, bucket);
    activeEntryId = entry.id;
    parentId = entry.id;
  }

  lineage.activeEntryId = activeEntryId;
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
): NavigableSessionEntry[] {
  if (!targetId) {
    return [];
  }

  const byId = getNavigableEntryMap(lineage);
  const path: NavigableSessionEntry[] = [];
  const visited = new Set<string>();
  let current = byId.get(targetId);
  while (current) {
    if (visited.has(current.id)) {
      break;
    }
    visited.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

/**
 * Build the effective LLM-visible message context for the active lineage path.
 */
export function getSessionMessagesFromLineage(
  lineage: KodaXSessionLineage,
  targetId: string | null = lineage.activeEntryId,
): KodaXMessage[] {
  return getSessionLineagePath(lineage, targetId)
    .flatMap((entry) => getContextMessagesForEntry(entry))
    .map(cloneMessage);
}

/**
 * Resolve an entry selector using either a direct entry id or the latest label.
 */
export function resolveSessionLineageTarget(
  lineage: KodaXSessionLineage,
  selector: string,
): NavigableSessionEntry | undefined {
  const normalizedSelector = selector.trim();
  if (!normalizedSelector) {
    return undefined;
  }

  const byId = getNavigableEntryMap(lineage);
  const direct = byId.get(normalizedSelector);
  if (direct && direct.type !== 'archive_marker') {
    return direct;
  }

  const labels = getResolvedLabels(lineage);
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
      const summaryEntry: KodaXSessionBranchSummaryEntry = {
        type: 'branch_summary',
        id: generateEntryId(),
        parentId: target.id,
        timestamp: new Date().toISOString(),
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
  entries.push({
    type: 'label',
    id: generateEntryId('label'),
    parentId: lineage.activeEntryId,
    timestamp: new Date().toISOString(),
    targetId: target.id,
    label: normalizedLabel || undefined,
  });

  return {
    version: 2,
    activeEntryId: lineage.activeEntryId,
    entries,
  };
}

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
): KodaXSessionLineage {
  const base = cloneLineage(lineage);
  const compactionEntryId = generateEntryId();
  const compactionEntry: KodaXSessionCompactionEntry = {
    type: 'compaction',
    id: compactionEntryId,
    parentId: null,
    timestamp: new Date().toISOString(),
    summary: anchor.summary,
    tokensBefore: anchor.tokensBefore,
    tokensAfter: anchor.tokensAfter,
    artifactLedgerId: anchor.artifactLedgerId,
    reason: anchor.reason,
    details: normalizeCompactionDetails(anchor.details),
    memorySeed: cloneMemorySeed(anchor.memorySeed),
  };

  base.entries.push(compactionEntry);
  base.activeEntryId = compactionEntryId;

  const next = createSessionLineage(compactedMessages, base);
  const activePath = getSessionLineagePath(next);
  const compactionIndex = activePath.findIndex((entry) => entry.id === compactionEntryId);
  const firstKeptEntryId = compactionIndex >= 0
    ? activePath[compactionIndex + 1]?.id
    : undefined;

  const result: KodaXSessionLineage = {
    ...next,
    entries: next.entries.map((entry) => entry.id === compactionEntryId
      ? {
        ...entry,
        firstKeptEntryId,
      }
      : entry),
  };

  // Release heavy message content from old islands to prevent in-memory
  // accumulation across compaction cycles.  Entry structure (id, parentId,
  // timestamp) is preserved so tree navigation and archive still work;
  // only the message body is replaced with a lightweight placeholder.
  return evictOldIslandMessageContent(result);
}

/**
 * Replace message content of entries in old islands (not the active island)
 * with a lightweight placeholder.  This releases large tool_result payloads
 * from memory while preserving the entry skeleton for tree structure.
 *
 * Called automatically after compaction so that `context.lineage` does not
 * accumulate unbounded message clones across compaction cycles.
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

  // Evict message content from old island entries
  let changed = false;
  const evicted = lineage.entries.map((entry) => {
    if (entry.type !== 'message') return entry;
    if (currentIsland.has(entry.id)) return entry;

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
  });

  return changed ? { ...lineage, entries: evicted } : lineage;
}

function cloneForkableEntry(
  entry: NavigableSessionEntry,
  parentId: string | null,
): NavigableSessionEntry {
  const base = {
    id: generateEntryId(),
    parentId,
    timestamp: entry.timestamp,
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
export function findPreviousUserEntryId(lineage: KodaXSessionLineage): string | null {
  const entries = lineage.entries;
  let found = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && entry.type === 'message' && entry.message.role === 'user') {
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
  // Find the target entry index in the lineage
  const entries = lineage.entries;
  const targetIndex = entries.findIndex(e => e.id === targetEntryId);
  if (targetIndex < 0) {
    return null;
  }

  // Truncate entries after target (keep up to and including target)
  const keptEntries = entries.slice(0, targetIndex + 1);
  const truncatedCount = entries.length - targetIndex - 1;

  // Create a rewind event entry to record this action
  const rewindEntry: KodaXSessionCompactionEntry = {
    type: 'compaction',
    id: generateEntryId(),
    parentId: targetEntryId,
    timestamp: new Date().toISOString(),
    summary: `[Rewind] Rewound to entry ${targetEntryId} (truncated ${truncatedCount} entries)`,
    reason: 'rewind',
    details: {
      rewindTargetId: targetEntryId,
      truncatedCount,
    },
  };

  return {
    version: 2,
    activeEntryId: targetEntryId,
    entries: [...keptEntries, rewindEntry],
  };
}

export function forkSessionLineage(
  lineage: KodaXSessionLineage,
  selector?: string,
): KodaXSessionLineage | null {
  const target = selector
    ? resolveSessionLineageTarget(lineage, selector)
    : lineage.activeEntryId
      ? resolveSessionLineageTarget(lineage, lineage.activeEntryId)
      : undefined;
  if (!target) {
    return null;
  }

  const path = getSessionLineagePath(lineage, target.id);
  const idMap = new Map<string, string>();
  const entries: KodaXSessionEntry[] = [];

  let parentId: string | null = null;
  for (const entry of path) {
    const cloned = cloneForkableEntry(entry, parentId);
    entries.push(cloned);
    idMap.set(entry.id, cloned.id);
    parentId = cloned.id;
  }

  const labels = getResolvedLabels(lineage);
  for (const entry of path) {
    const label = labels.get(entry.id);
    const targetId = idMap.get(entry.id);
    if (!label || !targetId) {
      continue;
    }
    const labelEntry: KodaXSessionLabelEntry = {
      type: 'label',
      id: generateEntryId('label'),
      parentId,
      timestamp: new Date().toISOString(),
      targetId,
      label,
    };
    entries.push(labelEntry);
    parentId = labelEntry.id;
  }

  return {
    version: 2,
    activeEntryId: idMap.get(target.id) ?? null,
    entries,
  };
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

  // 6. Collect entries to archive (everything NOT in preserve closure)
  const toArchive: KodaXSessionEntry[] = [];
  const toArchiveIds = new Set<string>();
  for (const entry of lineage.entries) {
    if (!preserved.has(entry.id)) {
      toArchive.push(entry);
      toArchiveIds.add(entry.id);
    }
  }

  if (toArchive.length === 0) {
    return { slimmedLineage: lineage, archivedEntries: [], archivedCount: 0, archiveBatchId: '' };
  }

  // 7. Generate archive batch ID and markers (one per old island group)
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

    // Attach marker to the nearest preserved parent so tree topology
    // doesn't drift.  If the archived group's root had a parent that's
    // still in the preserved set, the marker becomes a child of that
    // parent instead of a new root.
    const groupRoot = byId.get(rootId);
    const nearestPreservedParent = groupRoot?.parentId && preserved.has(groupRoot.parentId)
      ? groupRoot.parentId
      : null;

    markers.push({
      type: 'archive_marker',
      id: generateEntryId(),
      parentId: nearestPreservedParent,
      timestamp: firstEntry.timestamp,
      archiveBatchId,
      archivedEntryCount: entries.length,
      summary: `Archived: ${entries.length} entries. ${preview}`.slice(0, 600),
    });
  }

  // 8. Build slimmed lineage
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

function extractArchivePreview(entries: KodaXSessionMessageEntry[]): string {
  const first = entries.find((e) => e.message?.role === 'user');
  if (!first?.message) return '';
  const msg = first.message;
  if (typeof msg.content === 'string') return msg.content.slice(0, 200);
  if (Array.isArray(msg.content)) {
    const textBlock = msg.content.find((b: any) => b.type === 'text' && b.text);
    if (textBlock && 'text' in textBlock) return (textBlock as any).text.slice(0, 200);
  }
  return '';
}
