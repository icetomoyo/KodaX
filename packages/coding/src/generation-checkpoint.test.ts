import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createSessionLineage, type KodaXSessionData, type KodaXSessionStorage } from '@kodax-ai/agent';
import { loadGenerationCheckpoint, parseGenerationCheckpoint } from './generation-checkpoint.js';

it('accepts only a checkpoint of the exact committed head, preserving original receipts and iteration budgets', async () => {
  const messages = [{ role: 'user' as const, content: 'EDIT019 already committed; never repeat it.' }];
  const lineage = createSessionLineage(messages);
  let saved: KodaXSessionData | null = { title: 'Original', gitRoot: '', messages, lineage };
  const storage: KodaXSessionStorage = { load: async () => saved, save: async () => {} };
  const checkpoint = parseGenerationCheckpoint({ version: 1, sessionId: 'worker', activeEntryId: lineage.activeEntryId,
    messagesDigest: createHash('sha256').update(JSON.stringify(messages)).digest('hex'), remainingIterations: 0, remainingContinuationIterations: 2 })!;
  expect(checkpoint).toMatchObject({ remainingIterations: 0, remainingContinuationIterations: 2 });
  expect(await loadGenerationCheckpoint(storage, checkpoint)).toBe(saved);
  await expect(loadGenerationCheckpoint(storage, { ...checkpoint, activeEntryId: 'different' })).rejects.toThrow(/history/);
  await expect(loadGenerationCheckpoint(storage, { ...checkpoint, messagesDigest: 'a'.repeat(64) })).rejects.toThrow(/history/);
  saved = { title: 'No lineage', gitRoot: '', messages };
  await expect(loadGenerationCheckpoint(storage, checkpoint)).rejects.toThrow(/history/);
  saved = null;
  await expect(loadGenerationCheckpoint(storage, checkpoint)).rejects.toThrow(/history/);
  for (const value of [undefined, null, 1, {}, { ...checkpoint, sessionId: '' }, { ...checkpoint, activeEntryId: 1 },
    { ...checkpoint, turnId: false }, { ...checkpoint, remainingIterations: -1 }, { ...checkpoint, remainingContinuationIterations: 0.5 }]) {
    expect(parseGenerationCheckpoint(value)).toBeUndefined();
  }
});
