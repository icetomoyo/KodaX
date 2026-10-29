import { getSessionLineagePath } from '@kodax-ai/agent';
import { createHash } from 'node:crypto';
import { createFileVisualObservationOwner, readVisualObservationRecord, visualObservationImage, visualObservationRecord, type VisualObservationOwner } from '@kodax-ai/agent/media';
import type { KodaXOptions, KodaXSessionStorage, KodaXToolExecutionContext } from '../types.js';
import type { RuntimeSessionState } from '../agent-runtime/runtime-session-state.js';

/** Product owner binding. Reading the directory never depends on the compacted model transcript. */
export function createSessionVisualObservationOwner(storage: KodaXSessionStorage, sessionId: string, directory: string): VisualObservationOwner {
  return createFileVisualObservationOwner({ ownerId: sessionId, directory, async historyScope() {
    const lineage = await storage.loadFullLineage?.(sessionId) ?? (await storage.load(sessionId))?.lineage;
    if (!lineage) throw new Error('Visual observation owner lineage is missing.');
    const children = new Map<string, number>();
    for (const entry of lineage.entries) if (entry.parentId && ['message', 'compaction', 'branch_summary'].includes(entry.type)) {
      children.set(entry.parentId, (children.get(entry.parentId) ?? 0) + 1);
    }
    const activePath = getSessionLineagePath(lineage);
    const branch = activePath.filter(entry => entry.parentId && (children.get(entry.parentId) ?? 0) > 1)
      .map(entry => [entry.parentId, entry.id]);
    return createHash('sha256').update(JSON.stringify([activePath[0]?.id, branch,
      lineage.entries.filter(entry => entry.type === 'rewind_marker').map(entry => entry.id)])).digest('hex');
  }, async list() {
    const saved = await storage.load(sessionId);
    if (!saved) throw new Error('Visual observation owner Session is missing.');
    const lineage = await storage.loadFullLineage?.(sessionId) ?? saved.lineage;
    if (!lineage) return [];
    const entries = getSessionLineagePath(lineage);
    const inherited = new Set<string>();
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      if (entry.type === 'compaction' && entry.compactedFromEntryId && !inherited.has(entry.compactedFromEntryId)) {
        inherited.add(entry.compactedFromEntryId);
        entries.push(...getSessionLineagePath(lineage, entry.compactedFromEntryId));
      }
    }
    const visible = new Set(entries.map(entry => entry.id));
    const recoveredIds = new Set<string>();
    for (const entry of entries) {
      if (entry.type === 'message' && entry.message.inputId !== undefined) visible.add(`input:${entry.message.inputId}`);
      if (entry.type === 'message') for (const inputId of entry.message.inputIds ?? []) visible.add(`input:${inputId}`);
      if (entry.type === 'branch_summary' && entry.details && typeof entry.details === 'object' && !Array.isArray(entry.details)
        && Array.isArray(entry.details.visualRecoveryObservationIds)) {
        for (const id of entry.details.visualRecoveryObservationIds) if (typeof id === 'string') recoveredIds.add(id);
      }
    }
    return (saved.extensionRecords ?? []).flatMap(record => {
      const observation = readVisualObservationRecord(record);
      return observation?.ownerId === sessionId && (visible.has(observation.originEntryId) || recoveredIds.has(observation.observationId)) ? [observation] : [];
    });
  } });
}

/** read still owns the bytes here, before native publication or Script's call.settled save. */
export function bindVisualObservationAdmission(ctx: KodaXToolExecutionContext, options: KodaXOptions, state: RuntimeSessionState): void {
  const owner = ctx.visualObservationOwner;
  const storage = options.session?.storage;
  if (!owner || !storage) return;
  ctx.admitVisualImage = async (bytes, image, validation, sourceKey, signal = ctx.abortSignal, source) => {
    signal?.throwIfAborted();
    if (validation.status === 'invalid') throw new Error('Visual observation cannot be decoded.');
    const saved = await storage.load(owner.ownerId);
    const originEntryId = saved?.lineage?.activeEntryId;
    if (!originEntryId) throw new Error('Visual image admission requires its canonical source entry.');
    const observation = await owner.pin(bytes, { sourceKey, originEntryId, source,
      mediaType: validation.mediaType ?? image.mediaType ?? 'image/png' });
    signal?.throwIfAborted();
    state.extensionRecords.push(visualObservationRecord(observation));
    state.extensionRecordsDirty = true;
    return visualObservationImage(owner, observation, bytes, validation);
  };
}
