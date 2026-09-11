import { mkdtemp, readFile, rm } from 'node:fs/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { applySessionCompaction, getSessionMessagesFromLineage, type KodaXSessionLineage, type KodaXSessionMessageEntry } from '@kodax-ai/agent';
import { createSessionManager, exportSessionBundle } from '../session/public-api.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 }))); });

function message(id: string, parentId: string | null, role: 'user' | 'assistant', content: string): KodaXSessionMessageEntry {
  return { type: 'message', id, parentId, logicalId: id, timestamp: '2026-09-11T02:24:03.231Z',
    message: { role, content, timestamp: '2026-09-11T02:24:03.231Z', turnId: 'same-turn' } };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-confirmed-alias-'));
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  const manager = createSessionManager({ sessionsDir });
  const entries = [message('root', null, 'assistant', 'earlier answer'),
    message('delivered', 'root', 'user', 'same question'),
    { ...message('context', 'root', 'user', 'managed context'), message: { role: 'user' as const, content: 'managed context', _synthetic: true, _source: 'managed-run-context' } },
    message('canonical', 'context', 'user', 'same question'),
    message('answer', 'canonical', 'assistant', 'answer')];
  const lineage: KodaXSessionLineage = { version: 2, entries, activeEntryId: 'answer' };
  await manager.storage.save('sample', { title: 'identity test', messages: getSessionMessagesFromLineage(lineage), lineage });
  const capture = await manager.readSessionCapture('sample');
  if (capture === null) throw new Error('missing fixture');
  return { root, sessionsDir, manager, capture, input: { sourceEntryId: 'delivered', targetEntryId: 'canonical',
    expectedSourceRevision: capture.sourceRevision, confirmationReference: 'operator confirmed fixture mapping' } };
}

it('registers one confirmed alias without rewriting audit bytes and preserves it through stale saves and restart', async () => {
  const { manager, sessionsDir, capture, input } = await fixture();
  const before = await exportSessionBundle('sample', { sessionsDir });
  const main = before.files.find((file) => file.kind === 'main');
  if (main === undefined) throw new Error('missing main');
  const original = await readFile(main.path);
  expect(await manager.storage.readConversationPageCache('sample', { limit: 10, maxPageBytes: 100_000, maxInlineEntryBytes: 10_000, reservedBytes: 0 })).not.toBeNull();
  expect((await manager.readConversationHistory('sample'))?.entries.flatMap((entry) => entry.auditEntryIds)).not.toContain('delivered');
  const record = await manager.storage.confirmIdentityAlias('sample', input);
  const registered = await readFile(main.path);
  expect(registered.subarray(0, original.length)).toEqual(original);
  expect(await manager.storage.confirmIdentityAlias('sample', input)).toEqual(record);
  expect(await readFile(main.path)).toEqual(registered);
  const history = await manager.readConversationHistory('sample');
  expect(history?.entries.find((entry) => entry.boundaryId === 'canonical')?.auditEntryIds).toContain('delivered');
  expect(await manager.storage.readConversationPageCache('sample', { limit: 10, maxPageBytes: 100_000, maxInlineEntryBytes: 10_000, reservedBytes: 0 })).toBeNull();
  await manager.storage.save('sample', { ...capture.data, extensionRecords: [] });
  const restarted = createSessionManager({ sessionsDir });
  const restored = await restarted.readConversationHistory('sample');
  expect(restored?.entries.find((entry) => entry.boundaryId === 'canonical')?.auditEntryIds).toContain('delivered');
  expect((await restarted.storage.read('sample'))?.extensionRecords).toEqual([record]);
});

it('permits safe retries of concurrent registration and rejects a stale source without changing data', async () => {
  const { manager, sessionsDir, input } = await fixture();
  const second = createSessionManager({ sessionsDir });
  const attempts = await Promise.allSettled([manager.storage.confirmIdentityAlias('sample', input), second.storage.confirmIdentityAlias('sample', input)]);
  const records = [];
  for (const attempt of attempts) {
    if (attempt.status === 'fulfilled') records.push(attempt.value);
    else {
      expect(attempt.reason).toMatchObject({ code: 'data_changed' });
      records.push(await manager.storage.confirmIdentityAlias('sample', input));
    }
  }
  expect(records[0]).toEqual(records[1]);
  expect((await manager.storage.read('sample'))?.extensionRecords).toHaveLength(1);
  const other = await fixture();
  const before = await other.manager.readSessionCapture('sample');
  await expect(other.manager.storage.confirmIdentityAlias('sample', { ...other.input, expectedSourceRevision: 'stale' })).rejects.toMatchObject({ code: 'data_changed' });
  expect((await other.manager.readSessionCapture('sample'))?.sourceRevision).toBe(before?.sourceRevision);
});

it('leaves original audit bytes intact when registration cannot replace the file and permits a safe retry', async () => {
  const { manager, sessionsDir, input } = await fixture();
  const bundle = await exportSessionBundle('sample', { sessionsDir });
  const main = bundle.files.find((file) => file.kind === 'main');
  if (main === undefined) throw new Error('missing main');
  const original = await readFile(main.path);
  const rename = fs.rename.bind(fs);
  const failure = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (to === main.path) throw Object.assign(new Error('injected replacement failure'), { code: 'EIO' });
    return rename(from, to);
  });
  await expect(manager.storage.confirmIdentityAlias('sample', input)).rejects.toThrow('injected replacement failure');
  expect(await readFile(main.path)).toEqual(original);
  failure.mockRestore();
  await manager.storage.confirmIdentityAlias('sample', input);
  expect((await manager.readConversationHistory('sample'))?.entries.find((entry) => entry.boundaryId === 'canonical')?.auditEntryIds).toContain('delivered');
});

it('does not apply a parent session confirmation to its fork or restore cleared ordinary extension records', async () => {
  const { manager, capture, input } = await fixture();
  await manager.storage.save('sample', { ...capture.data, extensionRecords: [{ id: 'ordinary', extensionId: 'example', type: 'note', ts: 1 }] });
  const current = await manager.readSessionCapture('sample');
  if (current === null) throw new Error('missing fixture');
  const record = await manager.storage.confirmIdentityAlias('sample', { ...input, expectedSourceRevision: current.sourceRevision });
  await manager.storage.save('sample', { ...current.data, extensionRecords: [] });
  expect((await manager.storage.read('sample'))?.extensionRecords).toEqual([record]);
  const fork = await manager.storage.fork('sample', 'answer', { sessionId: 'forked' });
  expect(fork?.sessionId).toBe('forked');
  const history = await manager.readConversationHistory('forked');
  expect(history?.status).toBe('resolved');
  expect(history?.entries.flatMap((entry) => entry.auditEntryIds)).not.toContain('delivered');
});

it('retains a registered identity after compaction archives its source and rebuilds page caches', async () => {
  const { manager, sessionsDir, input } = await fixture();
  const record = await manager.storage.confirmIdentityAlias('sample', input);
  const saved = await manager.storage.load('sample');
  if (saved?.lineage === undefined) throw new Error('missing lineage');
  const keptMessages = getSessionMessagesFromLineage(saved.lineage).slice(-2);
  const compacted = applySessionCompaction(saved.lineage, keptMessages, { summary: 'earlier conversation' });
  await manager.storage.save('sample', { ...saved, lineage: compacted, messages: getSessionMessagesFromLineage(compacted) });
  const bundle = await exportSessionBundle('sample', { sessionsDir });
  const islands = bundle.files.find((file) => file.path.endsWith('.islands.jsonl'));
  if (islands === undefined) throw new Error('missing archived endpoints');
  const archived = await readFile(islands.path, 'utf8');
  expect(archived).toContain('"id":"delivered"');
  const restarted = createSessionManager({ sessionsDir });
  const restoredCapture = await restarted.readSessionCapture('sample');
  for (const id of ['delivered', 'canonical']) {
    expect(restoredCapture?.transcript.lineage?.entries.find((entry) => entry.id === id)).toEqual(saved.lineage.entries.find((entry) => entry.id === id));
  }
  const history = await restarted.readConversationHistory('sample');
  expect(history?.issues).toEqual([]);
  expect(history?.status).toBe('resolved');
  expect(history?.entries.filter((entry) => entry.auditEntryIds.includes('delivered'))).toHaveLength(1);
  const page = await restarted.storage.readConversationPageCache('sample', { limit: 100, maxPageBytes: 100_000, maxInlineEntryBytes: 10_000, reservedBytes: 0 });
  expect(page?.entries.flatMap((item) => item.entry?.auditEntryIds ?? []).filter((id) => id === 'delivered')).toHaveLength(1);
  expect(await restarted.storage.confirmIdentityAlias('sample', input)).toEqual(record);
  expect(await restarted.storage.archive('sample')).toBe(true);
  expect(await restarted.storage.unarchive('sample')).toBe(true);
  expect((await restarted.readConversationHistory('sample'))?.entries.filter((entry) => entry.auditEntryIds.includes('delivered'))).toHaveLength(1);
});
