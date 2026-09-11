import type { KodaXMessage } from '@kodax-ai/llm';
import type { KodaXSessionLineage, KodaXSessionMessageEntry } from '@kodax-ai/agent';

export const LEGACY_IDENTITY_SESSION_ID = '20260911_100157_8gbfe22d504b2f';
export const LEGACY_IDENTITY_TURN_ID = 'turn_c1408772fac54d06';
export const LEGACY_IDENTITY_SOURCE_ID = 'entry_fdb4f2769c49';
export const LEGACY_IDENTITY_TARGET_ID = 'entry_c49fccdba757';
export const LEGACY_IDENTITY_ALIAS_ID = 'entry_b04c17ada4dc';
export const LEGACY_IDENTITY_ANSWER_ID = 'entry_b45508931984';
export const LEGACY_IDENTITY_REPEAT_ID = 'entry_independent_repeat';
export const LEGACY_IDENTITY_INPUT_ID = 'input_mtwc19u7_a43e70f0';
const timestamp = '2026-09-11T02:24:03.231Z';

function entry(id: string, parentId: string | null, message: KodaXMessage): KodaXSessionMessageEntry {
  return { type: 'message', id, parentId, logicalId: id, timestamp, message: structuredClone(message) };
}

/** Minimal sample topology; equal message bodies are deliberately not identity evidence. */
export function createLegacyIdentityLineage(input: {
  sourceEntryId?: string;
  targetEntryId?: string;
  message?: KodaXMessage;
} = {}): KodaXSessionLineage {
  const sourceId = input.sourceEntryId ?? LEGACY_IDENTITY_SOURCE_ID;
  const targetId = input.targetEntryId ?? LEGACY_IDENTITY_TARGET_ID;
  const message: KodaXMessage = input.message ?? {
    role: 'user', content: 'ffmpeg query', turnId: LEGACY_IDENTITY_TURN_ID, timestamp,
  };
  const prefix = entry('entry_shared_prefix', null, { role: 'user', content: 'Earlier request' });
  const shared = entry('entry_shared_reply', prefix.id, { role: 'assistant', content: 'Earlier answer' });
  const source = entry(sourceId, shared.id, message);
  const context = entry('entry_managed_context', shared.id, {
    role: 'user', content: '=== Managed Run Context ===\n[redacted]',
    _synthetic: true, _source: 'managed-run-context',
  });
  const target = entry(targetId, context.id, message);
  const alias = { ...entry(LEGACY_IDENTITY_ALIAS_ID, target.id, message),
    logicalId: target.id, sourceEntryId: target.id };
  const answer = entry(LEGACY_IDENTITY_ANSWER_ID, alias.id, {
    role: 'assistant', content: 'three animated clips answer', turnId: message.turnId,
    timestamp: '2026-09-11T02:34:30.458Z',
  });
  return { version: 2, entries: [prefix, shared, source, context, target, alias, answer], activeEntryId: answer.id };
}

/** Same text, turn and timestamp, but a deliberate later query must remain independent. */
export function createRepeatedQueryIdentityLineage(): KodaXSessionLineage {
  const lineage = createLegacyIdentityLineage();
  const source = lineage.entries.find((item) => item.id === LEGACY_IDENTITY_SOURCE_ID)!;
  if (source.type !== 'message') throw new Error('Fixture source must be a message.');
  const repeated = entry(LEGACY_IDENTITY_REPEAT_ID, lineage.activeEntryId, source.message);
  return { ...lineage, entries: [...lineage.entries, repeated], activeEntryId: repeated.id };
}

export function legacyIdentityDeliveryJournal(): string {
  return JSON.stringify({ id: 'evt_7556_b9d48627', seq: 7556,
    cursor: { sessionId: LEGACY_IDENTITY_SESSION_ID, journalEpoch: 'fixture-journal', seq: 7556 },
    sessionId: LEGACY_IDENTITY_SESSION_ID, runId: 'run_mtwbz5qa_f2e9922d',
    turnId: LEGACY_IDENTITY_TURN_ID, time: '2026-09-11T02:24:03.585Z', type: 'run.input.delivered',
    payload: { inputs: [{ inputId: LEGACY_IDENTITY_INPUT_ID, entryId: LEGACY_IDENTITY_SOURCE_ID,
      afterRunId: 'run_mtwbz5qa_f2e9922d',
      input: 'ffmpeg query', deliveredAt: '2026-09-11T02:24:03.585Z' }] },
  }) + '\n';
}
