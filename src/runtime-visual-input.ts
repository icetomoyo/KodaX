import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validateImageBytes } from '@kodax-ai/llm';
import type { KodaXContentBlock, KodaXMessage } from '@kodax-ai/llm';
import { createFileVisualObservationOwner, readVisualObservationRecord, sessionVisualMediaDirectory, visualObservationLabel, visualObservationRecord } from '@kodax-ai/agent/media';
import type { KodaXInputArtifact, KodaXImageMediaType } from '@kodax-ai/agent/media';
import type { KodaXExtensionSessionRecord, KodaXJsonValue, KodaXSessionData } from '@kodax-ai/agent';

export function readRuntimeVisualInputReceipt(session: KodaXSessionData, sessionId: string, inputId: string):
  (Omit<KodaXExtensionSessionRecord, 'data'> & { data: { [key: string]: KodaXJsonValue } }) | undefined {
  for (const record of session.extensionRecords ?? []) {
    const data = record.data;
    if (record.extensionId !== 'kodax.visual' || record.type !== 'input' || !data || typeof data !== 'object' || Array.isArray(data)
      || data.inputId !== inputId) continue;
    if (data.ownerId !== sessionId) throw new Error('Visual input owner mismatch.');
    return { ...record, data };
  }
  return undefined;
}

/** Stages bytes and receipts; the caller's canonical save is the only durable acknowledgement. */
export async function prepareRuntimeVisualInput(input: {
  readonly sessionId: string; readonly inputId: string; readonly sessionsDir: string;
  readonly content: KodaXMessage['content']; readonly session: KodaXSessionData;
  readonly runId?: string; readonly productIntentDigest?: string;
  readonly pending?: boolean; readonly inputIds?: readonly string[];
}): Promise<{ content: KodaXMessage['content']; records: KodaXExtensionSessionRecord[] }> {
  const intent = createHash('sha256').update(JSON.stringify(input.content)).digest('hex');
  const receipt = readRuntimeVisualInputReceipt(input.session, input.sessionId, input.inputId);
  if (receipt) {
    if (input.productIntentDigest !== undefined
      ? receipt.data.productIntentDigest !== input.productIntentDigest : receipt.data.intent !== intent) throw new Error('Input ID already belongs to a different intent.');
    if (receipt.data.withdrawn === true) throw new Error('Visual input was withdrawn.');
  }
  const inputIds = input.inputIds ?? [input.inputId];
  if (input.pending && !receipt && input.session.messages.some(message => message.role === 'user'
    && (message.inputId === input.inputId || message.inputIds?.includes(input.inputId)))
    && Array.isArray(input.content) && input.content.some(block => block.type === 'image')) {
    throw new Error('Input ID already belongs to a different intent.');
  }
  const retained = retainedVisualInputs(input.session, input.sessionId, inputIds);
  if (!receipt && retained.some(observation => observation.source?.inputId === input.inputId)) {
    throw new Error('Input ID belongs to inherited visual history; submit a new input ID.');
  }
  if (retained.length > 0) {
    const saved = input.session.messages.find(message => message.role === 'user' && (message.inputId === input.inputId || message.inputIds?.includes(input.inputId)));
    if (!saved && receipt
      && receipt.data.pending !== true) throw new Error('Visual input receipt has no canonical input.');
    const owner = createFileVisualObservationOwner({ ownerId: input.sessionId,
      directory: sessionVisualMediaDirectory(input.sessionsDir, input.sessionId), list: async () => [] });
    for (const observation of retained) await owner.read(observation, Number.MAX_SAFE_INTEGER);
    let imageIndex = 0;
    const content = saved?.content ?? (typeof input.content === 'string' ? input.content : input.content.flatMap<KodaXContentBlock>(block => {
      if (block.type !== 'image') return [block];
      const observation = retained[imageIndex++];
      if (!observation) throw new Error('Visual pending input snapshot is unavailable.');
      return [{ type: 'text' as const, text: visualObservationLabel(observation) },
        { ...block, path: owner.imagePath(observation), mediaType: observation.mediaType }];
    }));
    return { content, records: input.runId ? runtimeVisualDeliveryRecords(input.session, input.sessionId, inputIds, input.runId) : [] };
  }
  if (typeof input.content === 'string' || !input.content.some(block => block.type === 'image')) return { content: input.content, records: [] };
  const owner = createFileVisualObservationOwner({ ownerId: input.sessionId,
    directory: sessionVisualMediaDirectory(input.sessionsDir, input.sessionId), list: async () => [] });
  const content: Exclude<KodaXMessage['content'], string>[number][] = [];
  const records: KodaXExtensionSessionRecord[] = [];
  for (const [imageOrdinal, block] of input.content.entries()) {
    if (block.type !== 'image') { content.push(block); continue; }
    const bytes = await readFile(block.path);
    const validation = await validateImageBytes(bytes);
    if (validation.status === 'invalid') throw new Error('Visual input cannot be decoded.');
    const observation = await owner.pin(bytes, { sourceKey: 'user', originEntryId: `input:${input.inputId}`,
      source: { imageOrdinal, inputId: input.inputId, runId: input.runId },
      mediaType: validation.mediaType ?? block.mediaType ?? 'image/png' });
    content.push({ type: 'text', text: visualObservationLabel(observation) }, { ...block, path: owner.imagePath(observation), mediaType: observation.mediaType });
    records.push(visualObservationRecord(observation));
  }
  records.push({ id: `visual_input_${input.inputId}`, extensionId: 'kodax.visual', type: 'input', ts: Date.now(),
    data: { ownerId: input.sessionId, inputId: input.inputId, intent, ...(input.pending ? { pending: true } : {}),
      ...(input.runId ? { runId: input.runId } : {}), ...(input.productIntentDigest ? { productIntentDigest: input.productIntentDigest } : {}) } });
  return { content, records };
}

export function runtimeVisualDeliveryRecords(session: KodaXSessionData, sessionId: string, inputIds: readonly string[], runId: string): KodaXExtensionSessionRecord[] {
  return inputIds.flatMap(inputId => {
    const record = readRuntimeVisualInputReceipt(session, sessionId, inputId);
    if (!record) return [];
    const data = record.data;
    if (data.withdrawn === true) throw new Error('Visual input was withdrawn.');
    return data.runId === runId ? [] : [{ ...record, data: { ...data, runId, revision: Number(data.revision ?? 0) + 1 } }];
  });
}

export function runtimeVisualWithdrawalRecords(session: KodaXSessionData, sessionId: string, inputId: string): KodaXExtensionSessionRecord[] {
  const record = readRuntimeVisualInputReceipt(session, sessionId, inputId);
  return record && record.data.withdrawn !== true
    ? [{ ...record, data: { ...record.data, withdrawn: true, revision: Number(record.data.revision ?? 0) + 1 } }] : [];
}

/** Called only after the pending input owner has authenticated the same principal and intent. */
export function runtimeVisualRebindingRecords(session: KodaXSessionData, sessionId: string, inputId: string, digest: string): KodaXExtensionSessionRecord[] {
  const record = readRuntimeVisualInputReceipt(session, sessionId, inputId);
  return record && record.data.productIntentDigest !== digest
    ? [{ ...record, data: { ...record.data, productIntentDigest: digest, revision: Number(record.data.revision ?? 0) + 1 } }] : [];
}

function retainedVisualInputs(session: KodaXSessionData, sessionId: string, inputIds: readonly string[]) {
  return inputIds.flatMap(inputId => (session.extensionRecords ?? []).flatMap(record => {
    const observation = readVisualObservationRecord(record);
    return observation?.ownerId === sessionId && observation.source?.inputId === inputId
      && observation.originEntryId === `input:${inputId}` ? [observation] : [];
  }).sort((a, b) => (a.source?.imageOrdinal ?? 0) - (b.source?.imageOrdinal ?? 0)));
}

/** The existing queue keeps original intent; only its admitted delivery gets stable artifact paths. */
export async function materializeRuntimeVisualArtifacts(input: {
  session: KodaXSessionData; sessionId: string; inputId: string; sessionsDir: string; artifacts: readonly KodaXInputArtifact[];
}): Promise<{ artifacts: KodaXInputArtifact[]; labels: string[] }> {
  if (readRuntimeVisualInputReceipt(input.session, input.sessionId, input.inputId)?.data.withdrawn === true) throw new Error('Visual input was withdrawn.');
  const observations = retainedVisualInputs(input.session, input.sessionId, [input.inputId]);
  const owner = createFileVisualObservationOwner({ ownerId: input.sessionId,
    directory: sessionVisualMediaDirectory(input.sessionsDir, input.sessionId), list: async () => [] });
  for (const observation of observations) await owner.read(observation, Number.MAX_SAFE_INTEGER);
  let imageIndex = 0;
  const artifacts = input.artifacts.map(artifact => {
    if (artifact.kind !== 'image') return artifact;
    const observation = observations[imageIndex++];
    if (!observation) throw new Error('Visual pending input snapshot is unavailable.');
    return { ...artifact, path: owner.imagePath(observation), mediaType: observation.mediaType as KodaXImageMediaType };
  });
  return { artifacts, labels: observations.map((observation, index) => `Image ${index + 1}: ${visualObservationLabel(observation)}`) };
}
