import { createHash } from 'node:crypto';
import type { KodaXSessionData, KodaXSessionPromotionRecord } from '../types.js';

export function sessionMetadataRevision(id: string, data: Pick<KodaXSessionData, 'tag' | 'runtimeInfo'>): string {
  const receipt = data.runtimeInfo?.sessionPromotion;
  return createHash('sha256').update(JSON.stringify([id, data.tag ?? null, receipt?.sessionId === id ? receipt : null])).digest('hex');
}

/** Evaluate under the Session's writer lock; promotion and its receipt commit together. */
export function promoteSessionMetadata(id: string, data: KodaXSessionData,
  input: KodaXSessionPromotionRecord): KodaXSessionData {
  const invalid = (message: string, code = 'invalid_params'): never => { throw Object.assign(new Error(message), { code }); };
  if (input.sessionId !== id || typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 128
    || /[\x00-\x1f]/.test(input.requestId) || typeof input.tag !== 'string' || !input.tag.trim()
    || input.tag.length > 256 || /[\x00-\x1f]/.test(input.tag)
    || typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) {
    invalid('Invalid Session promotion request.');
  }
  const previous = data.runtimeInfo?.sessionPromotion;
  if (previous?.sessionId === id) {
    if (previous.requestId === input.requestId && previous.expectedRevision === input.expectedRevision && previous.tag === input.tag) return data;
    invalid('Session was already promoted by a different request.', 'conflict');
  }
  if (sessionMetadataRevision(id, data) !== input.expectedRevision) invalid('Session metadata changed; reload before promoting.', 'conflict');
  return { ...data, tag: input.tag, runtimeInfo: { ...data.runtimeInfo, sessionPromotion: structuredClone(input) } };
}
