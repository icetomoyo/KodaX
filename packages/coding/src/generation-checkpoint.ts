import { createHash } from 'node:crypto';
import type { KodaXSessionStorage } from '@kodax-ai/agent';
import type { KodaXGenerationCheckpoint } from './types.js';

export function parseGenerationCheckpoint(value: unknown): KodaXGenerationCheckpoint | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.sessionId !== 'string' || !record.sessionId
    || (record.activeEntryId !== null && typeof record.activeEntryId !== 'string')
    || typeof record.messagesDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.messagesDigest)
    || (record.turnId !== undefined && typeof record.turnId !== 'string')) return undefined;
  if ([record.remainingIterations, record.remainingContinuationIterations]
    .some(value => value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0))) return undefined;
  let isolation: KodaXGenerationCheckpoint['isolation'];
  if (record.isolation !== undefined) {
    if (!record.isolation || typeof record.isolation !== 'object') return undefined;
    const value = record.isolation as Record<string, unknown>;
    if (typeof value.worktreePath !== 'string' || !value.worktreePath || typeof value.gitRoot !== 'string' || !value.gitRoot) return undefined;
    isolation = { worktreePath: value.worktreePath, gitRoot: value.gitRoot };
  }
  return { version: 1, sessionId: record.sessionId, activeEntryId: record.activeEntryId,
    ...(isolation ? { isolation } : {}),
    ...(typeof record.remainingIterations === 'number' ? { remainingIterations: record.remainingIterations } : {}),
    ...(typeof record.remainingContinuationIterations === 'number' ? { remainingContinuationIterations: record.remainingContinuationIterations } : {}),
    messagesDigest: record.messagesDigest, ...(typeof record.turnId === 'string' ? { turnId: record.turnId } : {}) };
}

export async function loadGenerationCheckpoint(storage: KodaXSessionStorage, checkpoint: KodaXGenerationCheckpoint) {
  const loaded = await storage.load(checkpoint.sessionId);
  if (!loaded?.lineage || loaded.lineage.activeEntryId !== checkpoint.activeEntryId
    || createHash('sha256').update(JSON.stringify(loaded.messages)).digest('hex') !== checkpoint.messagesDigest) {
    throw new Error('Generation checkpoint no longer matches committed history.');
  }
  return loaded;
}
