import { describe, expect, it, vi } from 'vitest';
import type { KodaXMessage, KodaXSessionLineage } from '@kodax-ai/agent';
import {
  buildRecoverySeed,
  normalizeRecoveryPrompt,
  SESSION_RECOVERY_HINT_MESSAGE,
  shouldOfferSessionRecovery,
} from './recovery.js';

describe('session recovery memory', () => {
  it('builds a safe summary without replaying raw tool blocks', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Fix the provider session bug' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I found the issue in provider history replay.' },
          { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'packages/llm/src/providers/openai.ts' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'raw file contents' }],
      },
      { role: 'user', content: 'continue' },
    ];
    const lineage: KodaXSessionLineage = {
      version: 2,
      activeEntryId: 'c1',
      entries: [{
        type: 'compaction',
        id: 'c1',
        parentId: null,
        timestamp: '2026-06-22T00:00:00.000Z',
        summary: 'Earlier summary from compaction.',
      }],
    };

    const seed = buildRecoverySeed({
      sourceSessionId: 'session-original',
      messages,
      lineage,
      artifactLedger: [{
        id: 'a1',
        kind: 'file_read',
        target: 'packages/llm/src/providers/openai.ts',
        timestamp: '2026-06-22T00:00:00.000Z',
      }],
    });

    expect(seed.messages).toHaveLength(1);
    expect(seed.messages[0]?.role).toBe('system');
    expect(seed.summary).toContain('session-original');
    expect(seed.summary).toContain('Earlier summary from compaction.');
    expect(seed.summary).toContain('read: packages/llm/src/providers/openai.ts');
    expect(seed.summary).not.toContain('raw file contents');
    expect(seed.summary).not.toContain('tool-1');
  });

  it('titles the recovery by the source id tail, which differs between sessions created together', () => {
    const seed = buildRecoverySeed({ sourceSessionId: '019a9256-3c7e-7b21-8f4d-6a2e9c1b5d03', messages: [] });
    expect(seed.title).toBe('Recovered from 9c1b5d03');
  });

  it('normalizes empty continuation prompts to continue', () => {
    expect(normalizeRecoveryPrompt('')).toBe('Continue.');
    expect(normalizeRecoveryPrompt('  keep going  ')).toBe('keep going');
  });

  it('explains the manual recovery command in persisted history text', () => {
    expect(SESSION_RECOVERY_HINT_MESSAGE).toContain('/recover [prompt]');
    expect(SESSION_RECOVERY_HINT_MESSAGE).toContain('session history');
  });

  it('offers recovery for provider-service errors but not auth failures', async () => {
    expect(await shouldOfferSessionRecovery({
      error: new Error('Provider service Error, Try a moment later'),
      countMessages: () => 5,
    })).toBe(true);

    expect(await shouldOfferSessionRecovery({
      error: new Error('Provider API error: 401 unauthorized'),
      countMessages: () => 5,
    })).toBe(false);
  });

  it('asks the conversation owner for its size only when the error qualifies', async () => {
    const countMessages = vi.fn(async () => 0);
    expect(await shouldOfferSessionRecovery({ error: new Error('Provider API error: 401 unauthorized'), countMessages })).toBe(false);
    expect(countMessages).not.toHaveBeenCalled();

    // A Host-owned conversation: the local cache is empty, the Host's count decides.
    expect(await shouldOfferSessionRecovery({
      error: new Error('Provider service Error, Try a moment later'), countMessages,
    })).toBe(false);
    countMessages.mockResolvedValueOnce(12);
    expect(await shouldOfferSessionRecovery({
      error: new Error('Provider service Error, Try a moment later'), countMessages,
    })).toBe(true);
  });
});
