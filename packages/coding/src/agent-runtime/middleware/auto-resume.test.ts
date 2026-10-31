import { createHash } from 'node:crypto';
import { createSessionLineage } from '@kodax-ai/agent';
import { expect, it, vi } from 'vitest';
import type { KodaXSessionData, KodaXSessionStorage } from '../../types.js';
import { resolveInitialMessages } from './auto-resume.js';

const saved: KodaXSessionData = { title: 'Existing session', gitRoot: '', messages: [{ role: 'user', content: 'Continue.' }] };

it('distinguishes a successfully loaded session with no extension records from an unknown session', async () => {
  const load = vi.fn<KodaXSessionStorage['load']>().mockResolvedValue(saved);
  const storage: KodaXSessionStorage = { load, save: async () => {} };
  const resumed = await resolveInitialMessages({ provider: 'anthropic',  session: { storage } }, 'session');
  expect(resumed.loadedExtensionRecords).toEqual([]);
  expect(resumed.messages).toEqual(saved.messages);
  expect(load).toHaveBeenCalledTimes(1);
  expect((await resolveInitialMessages({ provider: 'anthropic' }, 'unknown')).loadedExtensionRecords).toBeUndefined();
});

it('preserves whether inline history has a complete record snapshot or only an extension-state snapshot', async () => {
  const initialMessages = [{ role: 'user' as const, content: 'Host supplied history.' }];
  const load = vi.fn<KodaXSessionStorage['load']>().mockResolvedValue(saved);
  const storage: KodaXSessionStorage = { load, save: async () => {} };
  const fallback = await resolveInitialMessages({ provider: 'anthropic',  session: { initialMessages, storage } }, 'session');
  expect(fallback.loadedExtensionRecords).toEqual([]);
  expect(fallback.messages).toEqual(initialMessages);
  load.mockClear();
  const stateOnly = await resolveInitialMessages({ provider: 'anthropic',  session: { initialMessages, storage,
    initialExtensionState: { extension: { enabled: true } } } }, 'session');
  expect(stateOnly.loadedExtensionRecords).toBeUndefined();
  expect(load).not.toHaveBeenCalled();
  const explicitEmpty = await resolveInitialMessages({ provider: 'anthropic',  session: { initialMessages, storage,
    initialExtensionRecords: [] } }, 'session');
  expect(explicitEmpty.loadedExtensionRecords).toEqual([]);
  expect(load).not.toHaveBeenCalled();
  load.mockRejectedValueOnce(new Error('Unavailable metadata'));
  expect((await resolveInitialMessages({ provider: 'anthropic',  session: { initialMessages, storage } }, 'session')).loadedExtensionRecords).toBeUndefined();
  load.mockResolvedValueOnce(null);
  expect((await resolveInitialMessages({ provider: 'anthropic',  session: { initialMessages, storage } }, 'missing')).loadedExtensionRecords).toBeUndefined();
});

it('normalizes only an accepted durable checkpoint and preserves existing records and checkpoint validation', async () => {
  const lineage = createSessionLineage(saved.messages);
  const checkpointData: KodaXSessionData = { ...saved, lineage };
  const storage: KodaXSessionStorage = { load: async () => checkpointData, save: async () => {} };
  const checkpoint = { version: 1 as const, sessionId: 'session', activeEntryId: lineage.activeEntryId,
    messagesDigest: createHash('sha256').update(JSON.stringify(saved.messages)).digest('hex') };
  const resumed = await resolveInitialMessages({ provider: 'anthropic',  session: { storage, generationCheckpoint: checkpoint } }, 'session');
  expect(resumed.loadedExtensionRecords).toEqual([]);
  expect(resumed.messages).toEqual(saved.messages);
  checkpointData.extensionRecords = [{ id: 'receipt', extensionId: 'extension', type: 'accepted', ts: 1, data: { value: true } }];
  expect((await resolveInitialMessages({ provider: 'anthropic',  session: { storage, generationCheckpoint: checkpoint } }, 'session')).loadedExtensionRecords)
    .toEqual(checkpointData.extensionRecords);
  await expect(resolveInitialMessages({ provider: 'anthropic',  session: { storage, generationCheckpoint: { ...checkpoint,
    activeEntryId: 'uncommitted-head' } } }, 'session')).rejects.toThrow('committed history');
  await expect(resolveInitialMessages({ provider: 'anthropic',  session: { storage, generationCheckpoint: checkpoint } }, 'another-session'))
    .rejects.toThrow('original durable session');
});

it('keeps an absent session unknown and preserves direct storage failures', async () => {
  const load = vi.fn<KodaXSessionStorage['load']>().mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error('Storage failed'));
  const storage: KodaXSessionStorage = { load, save: async () => {} };
  expect((await resolveInitialMessages({ provider: 'anthropic',  session: { storage } }, 'missing')).loadedExtensionRecords).toBeUndefined();
  await expect(resolveInitialMessages({ provider: 'anthropic',  session: { storage } }, 'unreadable')).rejects.toThrow('Storage failed');
});
