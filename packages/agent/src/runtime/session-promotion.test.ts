import { describe, expect, it } from 'vitest';
import type { KodaXSessionData } from '../types.js';
import { promoteSessionMetadata, sessionMetadataRevision } from './session-promotion.js';

const ID = 'session-1';
const quickAsk = { messages: [], tag: 'quick-ask' } as unknown as KodaXSessionData;
const request = { sessionId: ID, requestId: 'promote-1', expectedRevision: sessionMetadataRevision(ID, quickAsk), tag: 'coder' };

describe('promoting a Session', () => {
  it('sets the tag once and answers a repeat of the same request with what it did', () => {
    const promoted = promoteSessionMetadata(ID, quickAsk, request);
    expect(promoted.tag).toBe('coder');
    expect(promoted.runtimeInfo?.sessionPromotion).toEqual(request);
    expect(promoteSessionMetadata(ID, promoted, request)).toBe(promoted);
  });

  it('says which conflict refused it', () => {
    const promoted = promoteSessionMetadata(ID, quickAsk, request);
    expect(() => promoteSessionMetadata(ID, promoted, { ...request, requestId: 'promote-2' }))
      .toThrow(expect.objectContaining({ code: 'conflict', data: { conflict: 'already_promoted' } }));
    expect(() => promoteSessionMetadata(ID, { ...quickAsk, tag: 'renamed' }, request))
      .toThrow(expect.objectContaining({ code: 'conflict', data: { conflict: 'revision_conflict' } }));
  });

  it('refuses a malformed request as invalid', () => {
    expect(() => promoteSessionMetadata(ID, quickAsk, { ...request, expectedRevision: 'not-a-revision' }))
      .toThrow(expect.objectContaining({ code: 'invalid_params' }));
  });
});
