import { describe, expect, it } from 'vitest';

import {
  countResumableSessionItems,
  findMostRecentResumableSession,
} from './resumable-session.js';

describe('countResumableSessionItems', () => {
  it('counts only structurally valid presentation-only text history', () => {
    expect(countResumableSessionItems(0, [
      { presentationOnly: true },
      { type: 'assistant', presentationOnly: true },
      { type: 'tool_group', tools: [], presentationOnly: true },
      { type: 'assistant', text: 'restored summary', presentationOnly: true },
      { type: 'sidecar', text: 'verifier result', presentationOnly: true },
    ])).toBe(2);
  });
});

describe('findMostRecentResumableSession', () => {
  it('requests a broad scan and skips empty placeholders', async () => {
    let requestedRoot: string | undefined;
    let requestedLimit: number | undefined;
    const storage = {
      async list(root?: string, options?: { limit?: number }) {
        requestedRoot = root;
        requestedLimit = options?.limit;
        return [
          { id: 'empty-acp', msgCount: 0 },
          { id: 'conversation', msgCount: 4 },
        ];
      },
    };

    const result = await findMostRecentResumableSession(storage, 'C:\\repo');

    expect(result?.id).toBe('conversation');
    expect(requestedRoot).toBe('C:\\repo');
    expect(requestedLimit).toBe(1000);
  });

  it('returns undefined when every listed session is empty', async () => {
    const storage = {
      async list() {
        return [{ id: 'empty-acp', msgCount: 0 }];
      },
    };

    await expect(findMostRecentResumableSession(storage)).resolves.toBeUndefined();
  });
});
