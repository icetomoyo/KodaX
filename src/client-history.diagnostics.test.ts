import { setKodaXDiagnosticSink } from '@kodax-ai/agent';
import { expect, it, vi } from 'vitest';
import { projectConversationHistoryPage, readConversationHistoryEntry } from './client-history.js';
import type { RuntimeConversationHistorySlice } from './sdk-runtime.js';

it.each(['page', 'original'] as const)('reports a corrupt %s once through the caller’s diagnostic owner', async kind => {
  const owner = vi.fn();
  const otherBundle = vi.fn();
  const restore = setKodaXDiagnosticSink(otherBundle);
  const revision = 'sha256:12345678';
  const page: RuntimeConversationHistorySlice = {
    revision, sourceRevision: 'source', status: 'resolved', issues: [], hasMore: false,
    entries: [{ index: 0, oversized: true, byteLength: 80000 }],
  };
  const read = async () => ({
    revision, entryIndex: 0, encoding: 'base64-json' as const,
    data: Buffer.from('private malformed history bytes').toString('base64'), hasMore: false,
  });
  try {
    const result = kind === 'page'
      ? projectConversationHistoryPage('session', page, read, owner)
      : readConversationHistoryEntry('session', `session:history:${revision}:0`, read, { part: 'original' }, 'history', owner);
    await expect(result).rejects.toMatchObject({ code: 'internal_error' });
    expect(owner.mock.calls).toEqual([[{
      source: 'client.history', level: 'error', message: 'History entry chunk stream for session entry 0 did not decode.',
    }]]);
    expect(otherBundle).not.toHaveBeenCalled();
  } finally {
    restore();
  }
});

it('stops an unterminated original body stream and reports the failure once', async () => {
  const revision = 'sha256:12345678';
  const read = vi.fn(async () => ({
    revision, entryIndex: 0, encoding: 'base64-json' as const,
    data: '', hasMore: true, nextCursor: 'repeated',
  }));
  const owner = vi.fn();
  await expect(readConversationHistoryEntry('session', `session:history:${revision}:0`,
    read, { part: 'original' }, 'history', owner)).rejects.toMatchObject({ code: 'internal_error' });
  expect(read).toHaveBeenCalledTimes(512);
  expect(owner.mock.calls).toEqual([[{
    source: 'client.history', level: 'error', message: 'History entry chunk stream for session entry 0 exceeded 512 chunks.',
  }]]);
});
