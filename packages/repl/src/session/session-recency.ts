import type { KodaXSessionEntry } from '@kodax-ai/agent';

export interface SessionRecency {
  readonly id: string;
  readonly createdAt?: string;
  readonly lastMessageAt?: string;
}

export function validSessionTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** Conversation activity is independent of Actor, compaction, and UI metadata writes. */
export function latestSessionMessageAt(
  entries: readonly KodaXSessionEntry[], prior?: string,
  sourceEntries: readonly KodaXSessionEntry[] = entries,
): string | undefined {
  let latest = validSessionTimestamp(prior);
  const sourceTimes = new Map<string, string | undefined>();
  const messageTime = (entry: KodaXSessionEntry): string | undefined => {
    if (entry.type !== 'message' || entry.message._synthetic
      || (entry.message.role !== 'user' && entry.message.role !== 'assistant')) return undefined;
    // Compaction copies gain a new physical entry timestamp, while forks retain
    // it. Prefer the proven source so rematerialization is never new activity.
    return validSessionTimestamp(entry.message.timestamp)
      ?? (entry.sourceEntryId !== undefined && sourceTimes.has(entry.sourceEntryId)
        ? sourceTimes.get(entry.sourceEntryId)
        : entry.sourceEntryId !== undefined
          ? undefined : validSessionTimestamp(entry.timestamp));
  };
  for (const entry of sourceEntries) sourceTimes.set(entry.id, messageTime(entry));
  for (const entry of entries) {
    const timestamp = sourceTimes.get(entry.id) ?? messageTime(entry);
    if (timestamp !== undefined && (latest === undefined || Date.parse(timestamp) > Date.parse(latest))) latest = timestamp;
  }
  return latest;
}

export function compareSessionRecency(left: SessionRecency, right: SessionRecency): number {
  for (const key of ['lastMessageAt', 'createdAt'] as const) {
    const leftValue = key === 'lastMessageAt' ? validSessionTimestamp(left.lastMessageAt) ?? left.createdAt : left.createdAt;
    const rightValue = key === 'lastMessageAt' ? validSessionTimestamp(right.lastMessageAt) ?? right.createdAt : right.createdAt;
    const a = leftValue === undefined ? NaN : Date.parse(leftValue);
    const b = rightValue === undefined ? NaN : Date.parse(rightValue);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return b - a;
    if (Number.isFinite(a) !== Number.isFinite(b)) return Number.isFinite(a) ? -1 : 1;
  }
  return right.id.localeCompare(left.id);
}
