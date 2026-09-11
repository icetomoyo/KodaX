import { describe, expect, it } from 'vitest';
import { applySessionCompaction, getSessionLineagePath } from '@kodax-ai/agent';
import type { KodaXExtensionSessionRecord, KodaXSessionLineage, KodaXSessionMessageEntry } from '@kodax-ai/agent';
import { buildSessionConversationHistory } from './conversation-history.js';
import { applyConfirmedIdentityRepairs, buildConfirmedIdentityRepairRecord,
  mergeConfirmedIdentityRepairRecords, parseConfirmedIdentityRepairRecord } from './identity-repair.js';

function user(id: string, parentId: string | null, content = 'query'): KodaXSessionMessageEntry {
  return { type: 'message', id, parentId, logicalId: id, timestamp: '2026-09-11T00:00:00.000Z',
    message: { role: 'user', content } };
}
function fixture() {
  const lineage: KodaXSessionLineage = { version: 2, activeEntryId: 'target',
    entries: [user('source', null), user('target', null)] };
  const input = { sourceEntryId: 'source', targetEntryId: 'target', expectedSourceRevision: 'revision-1',
    confirmationReference: 'confirmed-in-test' };
  return { lineage, input, history: buildSessionConversationHistory(lineage, 'revision-1') };
}

describe('confirmed session identity repairs', () => {
  it('records explicit confirmation and adds only an audit alias', () => {
    const { lineage, input, history } = fixture();
    const original = structuredClone(lineage);
    const record = buildConfirmedIdentityRepairRecord('session', input, lineage, []);
    expect(parseConfirmedIdentityRepairRecord(record)).toMatchObject({ sessionId: 'session',
      sourceEntryId: 'source', targetEntryId: 'target', sourceDigest: expect.stringMatching(/^sha256:/) });
    const repaired = applyConfirmedIdentityRepairs(history, lineage, 'session', [record]);
    expect(repaired.entries).toEqual([{ ...history.entries[0], auditEntryIds: ['target', 'source'] }]);
    expect(repaired.status).toBe('resolved');
    expect(lineage).toEqual(original);
    expect(history.entries[0]?.auditEntryIds).toEqual(['target']);
  });

  it('returns an existing record on retry and refuses another target for the same source', () => {
    const { lineage, input } = fixture();
    const record = buildConfirmedIdentityRepairRecord('session', input, lineage, []);
    expect(buildConfirmedIdentityRepairRecord('session', { ...input, expectedSourceRevision: 'revision-2' }, lineage, [record])).toBe(record);
    expect(() => buildConfirmedIdentityRepairRecord('session', { ...input, targetEntryId: 'other' }, lineage, [record]))
      .toThrow(expect.objectContaining({ code: 'conflict' }));
  });

  it('requires a unique visible target and refuses a source owned by another visible entry', () => {
    const { lineage, input } = fixture();
    expect(() => buildConfirmedIdentityRepairRecord('session', { ...input, targetEntryId: 'missing' }, lineage, [])).toThrow();
    const visibleBoth = { ...lineage, entries: [user('source', null), user('target', 'source')] };
    expect(() => buildConfirmedIdentityRepairRecord('session', input, visibleBoth, [])).toThrow();
    const synthetic = { ...lineage, entries: [user('source', null), { ...user('target', null), message: {
      role: 'user' as const, content: 'tool result', _synthetic: true } }] };
    expect(() => buildConfirmedIdentityRepairRecord('session', input, synthetic, [])).toThrow();
  });

  it('does not infer a repair from matching bodies without a confirmation record', () => {
    const { lineage, history } = fixture();
    expect(applyConfirmedIdentityRepairs(history, lineage, 'session', [])).toBe(history);
  });

  it('fails closed on changed physical entries, including an idempotent registration retry', () => {
    const { lineage, input, history } = fixture();
    const record = buildConfirmedIdentityRepairRecord('session', input, lineage, []);
    const changed = { ...lineage, entries: [user('source', null, 'changed'), user('target', null)] };
    const rejected = applyConfirmedIdentityRepairs(history, changed, 'session', [record]);
    expect(rejected.entries).toEqual(history.entries);
    expect(rejected.status).not.toBe('resolved');
    expect(rejected.issues).toEqual([expect.objectContaining({ code: 'identity_repair_invalid' })]);
    expect(() => buildConfirmedIdentityRepairRecord('session', input, changed, [record])).toThrow();
  });

  it('does not apply an inherited repair in another session or mark that fork invalid', () => {
    const { lineage, input, history } = fixture();
    const record = buildConfirmedIdentityRepairRecord('session', input, lineage, []);
    expect(applyConfirmedIdentityRepairs(history, lineage, 'fork', [record])).toBe(history);
    expect(mergeConfirmedIdentityRepairRecords('fork', [], [record])).toEqual([record]);
  });

  it('retains SDK records when ordinary snapshots omit them without resurrecting cleared extension records', () => {
    const { lineage, input } = fixture();
    const repair = buildConfirmedIdentityRepairRecord('session', input, lineage, []);
    const ordinary: KodaXExtensionSessionRecord = { id: 'ordinary', extensionId: 'plugin', type: 'note', ts: 0 };
    expect(mergeConfirmedIdentityRepairRecords('session', [ordinary, repair], [])).toEqual([repair]);
    expect(mergeConfirmedIdentityRepairRecords('session', [ordinary, repair], undefined)).toEqual([ordinary, repair]);
    expect(mergeConfirmedIdentityRepairRecords('session', [repair], [ordinary, ordinary])).toEqual([ordinary, ordinary, repair]);
    expect(() => mergeConfirmedIdentityRepairRecords('session', [repair], [{ ...repair, ts: repair.ts + 1 }])).toThrow();
  });

  it('reports corrupt records with bounded evidence without changing conversation entries', () => {
    const { lineage, input, history } = fixture();
    const repair = buildConfirmedIdentityRepairRecord('session', input, lineage, []);
    const corrupt = { ...repair, data: { broken: true } };
    expect(parseConfirmedIdentityRepairRecord(corrupt)).toBeUndefined();
    const result = applyConfirmedIdentityRepairs(history, lineage, 'session', Array.from({ length: 40 }, () => corrupt));
    expect(result.entries).toEqual(history.entries);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.occurrenceCount).toBe(40);
    expect(result.issues[0]?.entryIds.length).toBeLessThanOrEqual(16);
  });

  it('resolves an explicitly cloned target and preserves an independently repeated query', () => {
    const { lineage, input } = fixture();
    const target = lineage.entries[1] as KodaXSessionMessageEntry;
    const compacted = applySessionCompaction(lineage, [target.message], { summary: 'earlier history' });
    const copy = getSessionLineagePath(compacted).at(-1)!;
    const repeat = user('repeat', copy.id);
    const withRepeat = { ...compacted, activeEntryId: repeat.id, entries: [...compacted.entries, repeat] };
    const record = buildConfirmedIdentityRepairRecord('session', { ...input, targetEntryId: copy.id }, withRepeat, []);
    const history = buildSessionConversationHistory(withRepeat, 'revision-2');
    const repaired = applyConfirmedIdentityRepairs(history, withRepeat, 'session', [record]);
    expect(repaired.entries).toHaveLength(2);
    expect(repaired.entries[0]?.auditEntryIds).toContain('source');
    expect(repaired.entries[1]).toEqual(history.entries[1]);
    expect(repaired.entries[1]?.auditEntryIds).toEqual(['repeat']);
  });

  it('refuses competing immutable records and does not choose a winner while projecting', () => {
    const { lineage, input, history } = fixture();
    const record = buildConfirmedIdentityRepairRecord('session', input, lineage, []);
    const conflicting = structuredClone(record);
    if (!conflicting.data || typeof conflicting.data !== 'object' || Array.isArray(conflicting.data)) throw new Error('missing data');
    conflicting.data.targetEntryId = 'other';
    expect(() => mergeConfirmedIdentityRepairRecords('session', [record, conflicting], [])).toThrow();
    const rejected = applyConfirmedIdentityRepairs(history, lineage, 'session', [record, conflicting]);
    expect(rejected.entries).toEqual(history.entries);
    expect(rejected.issues[0]?.occurrenceCount).toBe(2);
  });
});
