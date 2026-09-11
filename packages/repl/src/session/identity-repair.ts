import { createHash } from 'node:crypto';
import type { KodaXExtensionSessionRecord, KodaXSessionLineage,
  KodaXSessionMessageEntry } from '@kodax-ai/agent';
import { buildSessionConversationHistory, type SessionConversationHistoryData } from './conversation-history.js';

export interface SessionIdentityRepairInput {
  readonly sourceEntryId: string;
  readonly targetEntryId: string;
  readonly expectedSourceRevision: string;
  readonly confirmationReference: string;
  readonly deliveryWitness?: {
    readonly runId: string;
    readonly inputId: string;
    readonly eventId: string;
    readonly seq: number;
    readonly eventDigest: string;
  };
}

export interface SessionConfirmedIdentityRepairData extends SessionIdentityRepairInput {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly sourceDigest: string;
  readonly targetDigest: string;
}

export const SESSION_IDENTITY_REPAIR_EXTENSION_ID = '@kodax/sdk';
export const SESSION_IDENTITY_REPAIR_RECORD_TYPE = 'session.identity-repair.confirmed.v1';
const RECORD_PREFIX = 'identity-repair:';

function repairConflict(message: string): Error & { readonly code: 'conflict' } {
  return Object.assign(new Error(message), { code: 'conflict' as const });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function recordId(sessionId: string, sourceEntryId: string): string {
  return `${RECORD_PREFIX}${digest([sessionId, sourceEntryId]).slice(7)}`;
}

function nonempty(value: unknown, limit = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
}

function hash(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isConfirmedIdentityRepairRecord(record: KodaXExtensionSessionRecord): boolean {
  return record.type === SESSION_IDENTITY_REPAIR_RECORD_TYPE
    || (typeof record.id === 'string' && record.id.startsWith(RECORD_PREFIX));
}

export function parseConfirmedIdentityRepairRecord(
  record: KodaXExtensionSessionRecord,
): SessionConfirmedIdentityRepairData | undefined {
  const data = record.data;
  if (record.extensionId !== SESSION_IDENTITY_REPAIR_EXTENSION_ID
    || record.type !== SESSION_IDENTITY_REPAIR_RECORD_TYPE || !Number.isFinite(record.ts) || record.ts < 0
    || !object(data) || data.schemaVersion !== 1 || !nonempty(data.sessionId)
    || !nonempty(data.sourceEntryId) || !nonempty(data.targetEntryId) || data.sourceEntryId === data.targetEntryId
    || !nonempty(data.expectedSourceRevision, 1024) || !nonempty(data.confirmationReference, 1024)
    || !hash(data.sourceDigest) || !hash(data.targetDigest)
    || record.id !== recordId(data.sessionId, data.sourceEntryId)
    || (record.dedupeKey !== undefined && record.dedupeKey !== record.id)) return undefined;
  const witness = data.deliveryWitness;
  if (witness !== undefined && (!object(witness) || !nonempty(witness.runId) || !nonempty(witness.inputId)
    || !nonempty(witness.eventId) || !Number.isSafeInteger(witness.seq) || Number(witness.seq) < 0
    || !hash(witness.eventDigest))) return undefined;
  return data as unknown as SessionConfirmedIdentityRepairData;
}

function queryEntry(lineage: KodaXSessionLineage, id: string): KodaXSessionMessageEntry {
  const matches = lineage.entries.filter((entry) => entry.id === id);
  const entry = matches[0];
  if (matches.length !== 1 || entry?.type !== 'message' || entry.message.role !== 'user'
    || entry.message._synthetic === true || entry.message._source !== undefined
    || (Array.isArray(entry.message.content) && entry.message.content.some((block) => block.type !== 'text' && block.type !== 'image'))) {
    throw repairConflict('Identity repair requires one ordinary physical user query per endpoint.');
  }
  return entry;
}

function targetGroup(history: SessionConversationHistoryData, sourceId: string, targetId: string): number {
  const owns = (entry: SessionConversationHistoryData['entries'][number], id: string) =>
    entry.boundaryId === id || entry.auditEntryIds.includes(id);
  const targets = history.entries.flatMap((entry, index) => owns(entry, targetId) ? [index] : []);
  if (targets.length !== 1 || history.entries.some((entry, index) => index !== targets[0] && owns(entry, sourceId))) {
    throw repairConflict('Identity repair target is not unique or source belongs to another visible query.');
  }
  return targets[0]!;
}

export function buildConfirmedIdentityRepairRecord(
  sessionId: string,
  input: SessionIdentityRepairInput,
  lineage: KodaXSessionLineage,
  existingRecords: readonly KodaXExtensionSessionRecord[],
): KodaXExtensionSessionRecord {
  const matching = existingRecords.filter((record) => record.id === recordId(sessionId, input.sourceEntryId));
  const previous = matching[0];
  if (previous !== undefined) {
    const prior = parseConfirmedIdentityRepairRecord(previous);
    if (!prior || prior.sessionId !== sessionId || prior.targetEntryId !== input.targetEntryId
      || prior.confirmationReference !== input.confirmationReference
      || stableJson(prior.deliveryWitness) !== stableJson(input.deliveryWitness)
      || matching.some((record) => stableJson(record) !== stableJson(previous))
      || validateAppliedRecord(previous, lineage, sessionId,
        buildSessionConversationHistory(lineage, input.expectedSourceRevision)) === undefined) {
      throw repairConflict('Confirmed identity repair conflicts with its existing immutable record.');
    }
    return previous;
  }
  const source = queryEntry(lineage, input.sourceEntryId);
  const target = queryEntry(lineage, input.targetEntryId);
  targetGroup(buildSessionConversationHistory(lineage, input.expectedSourceRevision), input.sourceEntryId, input.targetEntryId);
  const id = recordId(sessionId, input.sourceEntryId);
  const record: KodaXExtensionSessionRecord = { id, dedupeKey: id,
    extensionId: SESSION_IDENTITY_REPAIR_EXTENSION_ID, type: SESSION_IDENTITY_REPAIR_RECORD_TYPE, ts: Date.now(),
    data: { schemaVersion: 1, sessionId, sourceEntryId: input.sourceEntryId, targetEntryId: input.targetEntryId,
      expectedSourceRevision: input.expectedSourceRevision, confirmationReference: input.confirmationReference,
      sourceDigest: digest(source), targetDigest: digest(target),
      ...(input.deliveryWitness === undefined ? {} : { deliveryWitness: { ...input.deliveryWitness } }) } };
  if (!parseConfirmedIdentityRepairRecord(record)) throw repairConflict('Invalid confirmed identity repair input.');
  return record;
}

export function mergeConfirmedIdentityRepairRecords(
  sessionId: string,
  persisted: readonly KodaXExtensionSessionRecord[] | undefined,
  incoming: readonly KodaXExtensionSessionRecord[] | undefined,
): KodaXExtensionSessionRecord[] {
  if (!nonempty(sessionId)) throw repairConflict('Identity repair merge requires a session identity.');
  const protectedRecords = new Map<string, KodaXExtensionSessionRecord>();
  for (const record of (persisted ?? []).filter(isConfirmedIdentityRepairRecord)) {
    const prior = protectedRecords.get(record.id);
    if (prior && stableJson(prior) !== stableJson(record)) throw repairConflict('Conflicting persisted identity repair records.');
    protectedRecords.set(record.id, record);
  }
  if (incoming === undefined) return [...(persisted ?? [])];
  const seen = new Map<string, KodaXExtensionSessionRecord>();
  for (const record of incoming) {
    const prior = protectedRecords.get(record.id) ?? seen.get(record.id);
    if (prior && (isConfirmedIdentityRepairRecord(prior) || isConfirmedIdentityRepairRecord(record))
      && stableJson(prior) !== stableJson(record)) throw repairConflict('Confirmed identity repair records are immutable.');
    if (isConfirmedIdentityRepairRecord(record) && !prior) {
      const data = parseConfirmedIdentityRepairRecord(record);
      if (!data) throw repairConflict('Invalid confirmed identity repair record.');
    }
    seen.set(record.id, record);
  }
  return [...incoming, ...[...protectedRecords.values()].filter((record) => !seen.has(record.id))];
}

function validateAppliedRecord(
  record: KodaXExtensionSessionRecord,
  lineage: KodaXSessionLineage,
  sessionId: string,
  history: SessionConversationHistoryData,
): { sourceId: string; targetIndex: number } | undefined {
  const data = parseConfirmedIdentityRepairRecord(record);
  if (!data || data.sessionId !== sessionId) return undefined;
  try {
    if (digest(queryEntry(lineage, data.sourceEntryId)) !== data.sourceDigest
      || digest(queryEntry(lineage, data.targetEntryId)) !== data.targetDigest) return undefined;
    return { sourceId: data.sourceEntryId, targetIndex: targetGroup(history, data.sourceEntryId, data.targetEntryId) };
  } catch { return undefined; }
}

export function applyConfirmedIdentityRepairs(
  history: SessionConversationHistoryData,
  lineage: KodaXSessionLineage,
  sessionId: string,
  records: readonly KodaXExtensionSessionRecord[] | undefined,
): SessionConversationHistoryData {
  const repairs = records?.filter((record) => {
    if (!isConfirmedIdentityRepairRecord(record)) return false;
    const parsed = parseConfirmedIdentityRepairRecord(record);
    return parsed === undefined || parsed.sessionId === sessionId;
  }) ?? [];
  if (repairs.length === 0) return history;
  const copies = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const record of repairs) {
    const previous = copies.get(record.id);
    if (previous !== undefined && previous !== stableJson(record)) conflicts.add(record.id);
    copies.set(record.id, stableJson(record));
  }
  const aliases = new Map<number, Set<string>>();
  const evidence = new Set<string>();
  let invalid = 0;
  for (const record of repairs) {
    const valid = conflicts.has(record.id) ? undefined : validateAppliedRecord(record, lineage, sessionId, history);
    if (!valid) {
      invalid += 1;
      if (evidence.size < 16) evidence.add(typeof record.id === 'string' ? record.id.slice(0, 256) : 'invalid-record');
      continue;
    }
    const set = aliases.get(valid.targetIndex) ?? new Set(history.entries[valid.targetIndex]!.auditEntryIds);
    set.add(valid.sourceId);
    aliases.set(valid.targetIndex, set);
  }
  return { ...history,
    entries: history.entries.map((entry, index) => aliases.has(index) ? { ...entry, auditEntryIds: [...aliases.get(index)!] } : entry),
    ...(invalid === 0 ? {} : { status: history.status === 'ambiguous' ? 'ambiguous' : 'partial',
      issues: [...history.issues, { code: 'identity_repair_invalid', occurrenceCount: invalid, entryCount: invalid,
        entryIds: [...evidence], message: 'Confirmed identity repair records could not be verified; their aliases were not applied.' }] }),
  };
}
