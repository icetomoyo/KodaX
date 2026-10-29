import { getSessionLineagePath } from '../session-lineage/kodax-session-lineage.js';
import type { KodaXExtensionSessionRecord, KodaXSessionLineage } from '../types.js';
import { readVisualObservationRecord, type VisualObservation } from './visual-observations.js';

/** Exact committed lineage, including compaction predecessors; never a transcript string search. */
export function visibleVisualObservations(ownerId: string, records: readonly KodaXExtensionSessionRecord[], lineage: KodaXSessionLineage): VisualObservation[] {
  const entries = getSessionLineagePath(lineage);
  const inherited = new Set<string>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.type === 'compaction' && entry.compactedFromEntryId && !inherited.has(entry.compactedFromEntryId)) {
      inherited.add(entry.compactedFromEntryId);
      entries.push(...getSessionLineagePath(lineage, entry.compactedFromEntryId));
    }
  }
  const visible = new Set(entries.flatMap(entry => [entry.id, ...(entry.logicalId ? [entry.logicalId] : [])]));
  const recoveredIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type === 'message') for (const inputId of [entry.message.inputId, ...(entry.message.inputIds ?? [])]) {
      if (inputId !== undefined) visible.add(`input:${inputId}`);
    }
    if (entry.type === 'branch_summary' && entry.details && typeof entry.details === 'object' && !Array.isArray(entry.details)
      && Array.isArray(entry.details.visualRecoveryObservationIds)) {
      for (const id of entry.details.visualRecoveryObservationIds) if (typeof id === 'string') recoveredIds.add(id);
    }
  }
  return records.flatMap(record => {
    const observation = readVisualObservationRecord(record);
    return observation?.ownerId === ownerId && (visible.has(observation.originEntryId) || recoveredIds.has(observation.observationId)) ? [observation] : [];
  });
}
