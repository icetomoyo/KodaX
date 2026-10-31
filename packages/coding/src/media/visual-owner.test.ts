import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { expect, it, vi } from 'vitest';
import { createSessionLineage, evictOldIslandMessageContent, persistCompactedSessionHistory, setSessionLineageActiveEntry } from '@kodax-ai/agent';
import { createFileVisualObservationOwner, executeVisualTool, visualObservationRecord } from '@kodax-ai/agent/media';
import type { KodaXSessionData, KodaXSessionStorage } from '../types.js';
import { createSessionVisualObservationOwner, isSessionVisualObservationOwner } from './visual-owner.js';

it('recognizes only the exact product owner without loading history or probing image files', () => {
  const load = vi.fn<KodaXSessionStorage['load']>().mockResolvedValue(null);
  const storage: KodaXSessionStorage = { load, save: async () => {} };
  const directory = path.join(os.tmpdir(), 'kodax-owner-provenance-no-files');
  const owner = createSessionVisualObservationOwner(storage, 'session', directory);
  const custom = createFileVisualObservationOwner({ ownerId: 'session', directory, list: async () => [] });
  expect(isSessionVisualObservationOwner(owner)).toBe(true);
  expect(isSessionVisualObservationOwner(custom)).toBe(false);
  expect(isSessionVisualObservationOwner({ ...owner })).toBe(false);
  expect(isSessionVisualObservationOwner(undefined)).toBe(false);
  expect(load).not.toHaveBeenCalled();
});

it('recalls only authorized originals after exact compaction, eviction and owner recreation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-compaction-'));
  let saved: KodaXSessionData = { title: 'visual', gitRoot: '', messages: [{ role: 'user', content: 'Original visual task.', inputId: 'original-input' }] };
  saved.lineage = createSessionLineage(saved.messages);
  let fullLineage = structuredClone(saved.lineage);
  const storage: KodaXSessionStorage = { save: async (_id, data) => { saved = structuredClone(data); fullLineage = structuredClone(data.lineage!); },
    load: async () => structuredClone(saved), loadFullLineage: async () => structuredClone(fullLineage) };
  try {
    const owner = createFileVisualObservationOwner({ ownerId: 'session', directory, list: async () => [] });
    const bytes = await new Jimp({ width: 2, height: 2, color: 0x00ff00ff }).getBuffer('image/png');
    const observation = await owner.pin(bytes, { sourceKey: 'user', originEntryId: 'input:original-input', mediaType: 'image/png' });
    saved.extensionRecords = [visualObservationRecord(observation)];
    const compactedMessages = [{ role: 'system' as const, content: '[对话历史摘要]\n\nPreserve the visual task and its evidence.' },
      { role: 'user' as const, content: `Continue checking ${observation.observationId}.` }];
    await persistCompactedSessionHistory({ storage, sessionId: 'session', compactedMessages,
      update: { preCompactionMessages: saved.messages, anchor: { summary: 'Preserve the visual task and its evidence.',
        tokensBefore: 100, tokensAfter: 20, entriesRemoved: 1, reason: 'manual' } } });
    saved.lineage = evictOldIslandMessageContent(saved.lineage!);
    const restored = createSessionVisualObservationOwner(storage, 'session', directory);
    expect((await restored.list()).map(item => item.observationId), JSON.stringify(fullLineage)).toEqual([observation.observationId]);
    expect((await executeVisualTool('visual_inspect', { question: 'Recall the preserved evidence.', views: [{ label: 'old', observationId: observation.observationId }] },
      { owner: restored, reserveOutput: () => ({ cancel() {} }) })).isError).not.toBe(true);
    expect(await restored.read(observation)).toEqual(bytes);
    // A separate active branch cannot inherit the receipt merely because it remains in the file.
    saved.messages = [{ role: 'user', content: 'Unrelated branch.' }];
    saved.lineage = createSessionLineage(saved.messages);
    fullLineage = saved.lineage;
    expect(await restored.list()).toEqual([]);
    expect(await createSessionVisualObservationOwner(storage, 'fork', directory).list()).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('rejects a cursor after selecting another branch with the same observation prefix', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-branch-page-'));
  const messages = [1, 2, 3].map(index => ({ role: 'user' as const, content: `Shared input ${index}.`, inputId: `shared-${index}` }));
  const common = createSessionLineage(messages);
  let lineage = createSessionLineage([...messages, { role: 'assistant', content: 'Branch A.' }], common);
  const branchA = lineage.activeEntryId!;
  lineage = createSessionLineage([...messages, { role: 'assistant', content: 'Branch B.' }], lineage);
  let saved: KodaXSessionData = { title: 'branches', gitRoot: '', messages, lineage };
  const storage: KodaXSessionStorage = { load: async () => saved, save: async (_id, data) => { saved = data; }, loadFullLineage: async () => saved.lineage! };
  try {
    const writer = createFileVisualObservationOwner({ ownerId: 'session', directory, list: async () => [] });
    const bytes = await new Jimp({ width: 2, height: 2, color: 0xff0000ff }).getBuffer('image/png');
    saved.extensionRecords = [];
    for (let index = 1; index <= 3; index++) saved.extensionRecords.push(visualObservationRecord(await writer.pin(bytes,
      { sourceKey: 'user', originEntryId: `input:shared-${index}`, mediaType: 'image/png' })));
    const owner = createSessionVisualObservationOwner(storage, 'session', directory);
    const binding = { owner, reserveOutput: () => ({ cancel() {} }) };
    const first = await executeVisualTool('visual_history', { limit: 1 }, binding);
    const cursor = (JSON.parse(first.content as string) as { nextCursor: string }).nextCursor;
    expect(cursor).toBeDefined();
    saved.lineage = setSessionLineageActiveEntry(saved.lineage!, branchA)!;
    expect((await executeVisualTool('visual_history', { cursor, limit: 1 }, binding)).isError).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
