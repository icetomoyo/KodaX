/**
 * FEATURE_247 (R6) — imperative compactSession.
 *
 * Covers the non-LLM paths (never-throws + no-op + manager exposure). The full
 * summarize-and-rewrite path calls the provider LLM and is exercised by the
 * REPL /compact command's own coverage; here we lock the SDK contract shape.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return { ...actual, compact: vi.fn() };
});

import {
  COMPACTED_HISTORY_RECOVERY_GUIDANCE,
  COMPACTION_SUMMARY_PREFIX,
  compact as mockedCompact,
  createSessionLineage,
  estimateTokens,
  getSessionMessagesFromLineage,
  type CompactionResult,
} from '@kodax-ai/agent';

import { FileSessionStorage } from '../interactive/storage.js';
import { compactSession } from './compact-session.js';
import { createSessionManager } from './public-api.js';

const compactMock = mockedCompact as unknown as ReturnType<typeof vi.fn>;

function tmpDir(label: string): string {
  const dir = path.join(os.tmpdir(), `kodax-compact-${label}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  compactMock.mockReset();
});

describe('FEATURE_247 R6: compactSession', () => {
  it('restores modified-file context with the same bounded attachments as automatic compaction', async () => {
    const file = path.join(os.tmpdir(), `compact-file-${randomUUID()}.txt`);
    fs.writeFileSync(file, 'EXACT_MODIFIED_FILE_CONTENT');
    const storage = new FileSessionStorage();
    vi.spyOn(storage, 'load').mockResolvedValue({ messages: [{ role: 'user', content: 'Continue' }],
      title: 'Attachments', gitRoot: '' });
    vi.spyOn(storage, 'save').mockResolvedValue(undefined);
    compactMock.mockResolvedValue({ compacted: true,
      messages: [{ role: 'user', _source: 'compaction-checkpoint', _synthetic: true,
        content: `${COMPACTION_SUMMARY_PREFIX}Summary` }], summary: 'Summary',
      tokensBefore: 4_000, tokensAfter: 100, entriesRemoved: 1,
      artifactLedger: [{ id: 'modified', kind: 'file_modified', target: file,
        timestamp: '2026-09-08T00:00:00.000Z', action: 'edit' }],
    } satisfies CompactionResult);
    try {
      const result = await compactSession('attachments', { storage, provider: 'anthropic',
        contextWindow: 200_000 });
      expect(JSON.stringify(result.messages)).toContain('EXACT_MODIFIED_FILE_CONTENT');
    } finally { fs.unlinkSync(file); }
  });
  it('returns compacted:false with a reason for a missing session (never throws)', async () => {
    const r = await compactSession('does-not-exist', { sessionsDir: tmpDir('missing') });
    expect(r.compacted).toBe(false);
    expect(r.reason).toContain('not found');
    expect(r.messages).toEqual([]);
  });

  it('is a no-op (no rewrite) for a session too small to compact', async () => {
    const storage = new FileSessionStorage({ sessionsDir: tmpDir('tiny') });
    await storage.save('tiny', {
      messages: [{ role: 'user', content: 'hi' }],
      title: 'Tiny',
      gitRoot: '/tmp/x',
    });

    compactMock.mockResolvedValue({
      compacted: false,
      messages: [{ role: 'user', content: 'hi' }],
      tokensBefore: 1,
      tokensAfter: 1,
      entriesRemoved: 0,
    } satisfies CompactionResult);

    const r = await compactSession('tiny', { storage, provider: 'anthropic' });

    expect(r.compacted).toBe(false);
    expect(r.reason).toBe('no compaction needed');
    // The session is left untouched.
    const after = await storage.load('tiny');
    expect(after?.messages.length).toBe(1);
  });

  it('createSessionManager exposes a compactSession method', () => {
    const mgr = createSessionManager({ sessionsDir: tmpDir('mgr') });
    expect(typeof mgr.compactSession).toBe('function');
  });

  it('captures the exact flat history before compacting a stale lineage', async () => {
    const storage = new FileSessionStorage({ sessionsDir: tmpDir('exact-base') });
    const exactMessages = [
      { role: 'user' as const, content: 'exact request' },
      { role: 'assistant' as const, content: 'EXACT_RESPONSE_MISSING_FROM_LINEAGE' },
    ];
    const load = vi.spyOn(storage, 'load').mockResolvedValue({
      messages: exactMessages,
      title: 'Exact base',
      gitRoot: '/tmp/x',
      lineage: createSessionLineage([exactMessages[0]!]),
    });
    const save = vi.spyOn(storage, 'save').mockResolvedValue(undefined);
    const summary = 'Exact-base summary.';
    compactMock.mockResolvedValue({
      compacted: true,
      messages: [{
        role: 'user',
        content: `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTED_HISTORY_RECOVERY_GUIDANCE}`,
        _source: 'compaction-checkpoint',
        _synthetic: true,
      }],
      summary,
      tokensBefore: 1_000,
      tokensAfter: 20,
      entriesRemoved: 2,
      anchor: { summary, reason: 'manual' },
    } satisfies CompactionResult);

    await compactSession('exact-base', { storage, provider: 'anthropic' });

    expect(load).toHaveBeenCalledWith('exact-base');
    const saved = save.mock.calls[0]?.[1];
    expect(saved?.lineage?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({
          content: 'EXACT_RESPONSE_MISSING_FROM_LINEAGE',
        }),
      }),
    ]));
  });

  it('includes post-compact attachments in returned and persisted token counts', async () => {
    const storage = new FileSessionStorage({ sessionsDir: tmpDir('attachments') });
    await storage.save('attachments', {
      messages: [{ role: 'user', content: 'original history' }],
      title: 'Attachments',
      gitRoot: '/tmp/x',
    });
    const summaryMessage = {
      role: 'user' as const,
      content: '[对话历史摘要]\n\nComplete summary.',
      _source: 'compaction-checkpoint' as const,
      _synthetic: true,
    };
    const result: CompactionResult = {
      compacted: true,
      messages: [summaryMessage],
      summary: 'Complete summary.',
      tokensBefore: 1_000,
      tokensAfter: estimateTokens([summaryMessage]),
      entriesRemoved: 1,
      artifactLedger: [{
        id: 'artifact-1',
        kind: 'file_read',
        sourceTool: 'read',
        action: 'read',
        target: 'src/example.ts',
        displayTarget: 'src/example.ts',
        summary: 'Read src/example.ts',
        timestamp: '2026-07-21T00:00:00.000Z',
      }],
      anchor: {
        summary: 'Complete summary.',
        tokensBefore: 1_000,
        tokensAfter: estimateTokens([summaryMessage]),
        entriesRemoved: 1,
        reason: 'manual',
      },
    };
    compactMock.mockResolvedValue(result);

    const compacted = await compactSession('attachments', {
      storage,
      provider: 'anthropic',
    });
    const persisted = await storage.load('attachments');
    const lineageMessages = getSessionMessagesFromLineage(persisted!.lineage!);
    const activeCompaction = [...persisted!.lineage!.entries]
      .reverse()
      .find((entry) => entry.type === 'compaction');

    expect(compacted.tokensAfter).toBe(estimateTokens(lineageMessages));
    expect(compacted.messages).toEqual(lineageMessages);
    expect(persisted?.messages).toEqual(lineageMessages);
    expect(activeCompaction?.tokensAfter).toBe(compacted.tokensAfter);
    expect(compacted.tokensAfter).toBeGreaterThan(result.tokensAfter);
  });
});
