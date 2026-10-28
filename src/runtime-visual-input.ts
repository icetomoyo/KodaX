import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validateImageBytes } from '@kodax-ai/llm';
import type { KodaXMessage } from '@kodax-ai/llm';
import { createFileVisualObservationOwner, sessionVisualMediaDirectory, visualObservationLabel, visualObservationRecord } from '@kodax-ai/agent/media';
import type { KodaXExtensionSessionRecord, KodaXSessionData } from '@kodax-ai/agent';

/** Stages bytes and receipts; the caller's canonical save is the only durable acknowledgement. */
export async function prepareRuntimeVisualInput(input: {
  readonly sessionId: string; readonly inputId: string; readonly sessionsDir: string;
  readonly content: KodaXMessage['content']; readonly session: KodaXSessionData;
  readonly runId?: string; readonly productIntentDigest?: string;
}): Promise<{ content: KodaXMessage['content']; records: KodaXExtensionSessionRecord[] }> {
  const intent = createHash('sha256').update(JSON.stringify(input.content)).digest('hex');
  const receipt = input.session.extensionRecords?.find(record => record.extensionId === 'kodax.visual'
    && record.type === 'input' && record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    && record.data.inputId === input.inputId);
  if (receipt?.data && typeof receipt.data === 'object' && !Array.isArray(receipt.data)) {
    if (receipt.data.intent !== intent || receipt.data.ownerId !== input.sessionId) throw new Error('Input ID already belongs to a different intent.');
    const saved = input.session.messages.find(message => message.role === 'user' && message.inputId === input.inputId);
    if (!saved) throw new Error('Visual input receipt has no canonical input.');
    return { content: saved.content, records: input.runId && input.runId !== receipt.data.runId
      ? [{ ...receipt, data: { ...receipt.data, runId: input.runId,
        ...(input.productIntentDigest ? { productIntentDigest: input.productIntentDigest } : {}) } }] : [] };
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
    data: { ownerId: input.sessionId, inputId: input.inputId, intent,
      ...(input.runId ? { runId: input.runId } : {}), ...(input.productIntentDigest ? { productIntentDigest: input.productIntentDigest } : {}) } });
  return { content, records };
}
