import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { forkSessionLineage, getSessionLineagePath, type KodaXExtensionSessionRecord, type KodaXMessage, type KodaXSessionLineage } from '@kodax-ai/agent';
import { createFileVisualObservationOwner, sessionVisualMediaDirectory, visibleVisualObservations, visualObservationRecord } from '@kodax-ai/agent/media';

/** Media is private to this new owner before its canonical fork acknowledgement. */
export async function prepareVisualSessionFork(input: {
  sessionsDir: string; parentId: string; childId: string; records: readonly KodaXExtensionSessionRecord[];
  sourceLineage: KodaXSessionLineage; lineage: KodaXSessionLineage;
}): Promise<{ lineage: KodaXSessionLineage; records: KodaXExtensionSessionRecord[] }> {
  const directory = sessionVisualMediaDirectory(input.sessionsDir, input.childId);
  const parentDirectory = sessionVisualMediaDirectory(input.sessionsDir, input.parentId);
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.mkdir(directory); // Never overwrite an existing owner's files, including an earlier failed fork.
  try {
    const lineage = structuredClone(input.lineage);
    const selectedId = lineage.entries.find(entry => entry.id === lineage.activeEntryId)?.sourceEntryId ?? null;
    restoreVisualForkAncestry(input.sourceLineage, lineage);
    const observations = visibleVisualObservations(input.parentId, input.records, { ...input.sourceLineage, activeEntryId: selectedId });
    const sourceEntries = new Map(input.sourceLineage.entries.map(entry => [entry.id, entry]));
    const parent = createFileVisualObservationOwner({ ownerId: input.parentId, directory: parentDirectory, list: async () => [] });
    const child = createFileVisualObservationOwner({ ownerId: input.childId, directory, list: async () => [] });
    const copied = new Map<string, string>();
    for (const observation of observations) {
      if (copied.has(observation.sha256)) continue;
      copied.set(observation.sha256, await child.writeDerived(await parent.read(observation, Number.MAX_SAFE_INTEGER)));
    }
    const remapImage = async (image: { path: string }): Promise<void> => {
      if (path.relative(path.resolve(parentDirectory), path.resolve(path.dirname(image.path))) !== '') return;
      const hash = path.basename(image.path);
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Fork image has an invalid retained media path.');
      let target = copied.get(hash);
      if (!target) {
        const bytes = await fs.readFile(image.path);
        if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('Visual observation hash mismatch.');
        target = await child.writeDerived(bytes); copied.set(hash, target);
      }
      image.path = target;
    };
    const remapMessage = async (message: KodaXMessage): Promise<void> => {
      if (typeof message.content === 'string') return;
      for (const block of message.content) {
        if (block.type === 'image') await remapImage(block);
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
          for (const item of block.content) if (item.type === 'image') await remapImage(item);
        }
      }
    };
    for (const entry of lineage.entries) {
      if (entry.type === 'message') await remapMessage(entry.message);
      if (entry.type === 'compaction') for (const message of entry.postCompactAttachments ?? []) await remapMessage(message);
    }
    const records = input.records.filter(record => record.extensionId !== 'kodax.visual').map(record => structuredClone(record));
    records.push(...observations.map(observation => visualObservationRecord({ ...observation, ownerId: input.childId,
      originEntryId: sourceEntries.get(observation.originEntryId)?.logicalId ?? observation.originEntryId })));
    return { lineage, records };
  } catch (error) {
    try { await discardVisualSessionFork(input.sessionsDir, input.childId); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Visual fork staging and cleanup failed.'); }
    throw error;
  }
}

/** Keep exact evidence islands disconnected from the compacted model context. */
function restoreVisualForkAncestry(source: KodaXSessionLineage, lineage: KodaXSessionLineage): void {
  const originals = new Map(source.entries.map(entry => [entry.id, entry]));
  const mapped = new Map(lineage.entries.flatMap(entry => entry.sourceEntryId ? [[entry.sourceEntryId, entry.id] as const] : []));
  const pending = [...mapped.keys()];
  for (let index = 0; index < pending.length; index++) {
    const entry = originals.get(pending[index]!);
    if (entry?.type !== 'compaction' || !entry.compactedFromEntryId || mapped.has(entry.compactedFromEntryId)) continue;
    const inherited = forkSessionLineage(source, entry.compactedFromEntryId);
    if (!inherited) throw new Error('Visual fork pre-compaction lineage is unavailable.');
    const clones = new Map(inherited.entries.flatMap(copy => copy.sourceEntryId ? [[copy.sourceEntryId, copy] as const] : []));
    for (const original of getSessionLineagePath(source, entry.compactedFromEntryId)) {
      if (mapped.has(original.id)) continue;
      const copy = clones.get(original.id);
      if (!copy) throw new Error('Visual fork evidence entry is unavailable.');
      copy.parentId = original.parentId ? mapped.get(original.parentId) ?? null : null;
      mapped.set(original.id, copy.id); lineage.entries.push(copy); pending.push(original.id);
    }
  }
  lineage.entries = lineage.entries.map(copy => {
    const original = copy.sourceEntryId ? originals.get(copy.sourceEntryId) : undefined;
    return copy.type === 'compaction' && original?.type === 'compaction'
      ? { ...copy, firstKeptEntryId: original.firstKeptEntryId ? mapped.get(original.firstKeptEntryId) : undefined,
        compactedFromEntryId: original.compactedFromEntryId ? mapped.get(original.compactedFromEntryId) : undefined } : copy;
  });
}

export async function discardVisualSessionFork(sessionsDir: string, childId: string): Promise<void> {
  const directory = path.resolve(sessionVisualMediaDirectory(sessionsDir, childId));
  if (path.dirname(directory) !== path.resolve(sessionsDir, '.media')) throw new Error('Invalid visual fork cleanup directory.');
  await fs.rm(directory, { recursive: true, force: true });
}
