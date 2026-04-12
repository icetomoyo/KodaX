import { randomUUID } from 'node:crypto';
import type { CompactionDetails } from './compaction/types.js';
import type {
  KodaXCompactMemorySeed,
  KodaXJsonValue,
  KodaXMessage,
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

function cloneMessage(message: KodaXMessage): KodaXMessage {
  return structuredClone(message);
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
  switch (entry.type) {
    case 'message':
      return {
        ...entry,
        message: cloneMessage(entry.message),
      };
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
  return getMessageFingerprint(left) === getMessageFingerprint(right);
}

function generateEntryId(prefix: 'entry' | 'label' = 'entry'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, ENTRY_ID_LENGTH)}`;
}

function cloneLineage(lineage?: KodaXSessionLineage): KodaXSessionLineage {
  return {
    version: 2,
    activeEntryId: lineage?.activeEntryId ?? null,
    entries: lineage?.entries.map(cloneEntry) ?? [],
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
  if (direct) {
    return direct;
  }

  const labels = getResolvedLabels(lineage);
  const labeledTargetId = [...labels.entries()]
    .find(([, label]) => label === normalizedSelector)?.[0];
  return labeledTargetId ? byId.get(labeledTargetId) : undefined;
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

  return {
    ...next,
    entries: next.entries.map((entry) => entry.id === compactionEntryId
      ? {
        ...entry,
        firstKeptEntryId,
      }
      : entry),
  };
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
        message: cloneMessage(entry.message),
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
    default: {
      const exhaustiveCheck: never = entry;
      return exhaustiveCheck;
    }
  }
}

/**
 * Export the active lineage path, or a selected target path, into a new tree.
 */
/**
 * Rewind the current session lineage to a target entry, truncating all entries after it.
 * Records a rewind event in the lineage for auditability.
 * Returns null if targetEntryId is not found.
 *
 * @param lineage - The session lineage to rewind
 * @param targetEntryId - The entry ID to rewind to (inclusive)
 * @returns A new lineage with entries truncated after the target, or null if target not found
 */
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
