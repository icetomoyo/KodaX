/**
 * Contract test for CAP-008: initialMessages session continuation
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-008-initialmessages-session-continuation
 *
 * Test obligations:
 * - CAP-SESSION-RESUME-001: REPL multi-turn / /resume / --continue /
 *   plan-mode replay all seed messages from initialMessages
 *
 * Risk: HIGH — session-resume continuity is shared between SA and AMA
 * paths via `resolveInitialMessages` (auto-resume middleware). Both
 * branches must seed the transcript identically; divergence breaks
 * /resume + --continue.
 *
 * Verified location: agent-runtime/middleware/auto-resume.ts (extracted from
 * agent.ts:1485-1503 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * STATUS: ACTIVE since FEATURE_100 P2.
 */

import type { KodaXSessionStorage } from '@kodax/agent';
import type { KodaXMessage } from '@kodax/ai';
import { describe, expect, it, vi } from 'vitest';

import type { KodaXOptions } from '../../types.js';
import { resolveInitialMessages } from '../middleware/auto-resume.js';

describe('CAP-008: initialMessages session continuation contract', () => {
  it('CAP-SESSION-RESUME-001a: when options.session.initialMessages is provided, messages buffer is seeded with a CLONE (caller mutation does not leak)', async () => {
    const callerMessages: KodaXMessage[] = [
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'first reply' },
    ];
    const options = {
      session: { initialMessages: callerMessages },
    } as KodaXOptions;

    const result = await resolveInitialMessages(options, 'sid-1');
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual({ role: 'user', content: 'first turn' });

    // Verify the array is a CLONE — mutating the original does not leak
    callerMessages.push({ role: 'user', content: 'leaked' } as KodaXMessage);
    expect(result.messages).toHaveLength(2);
  });

  it('CAP-SESSION-RESUME-001b: title is extracted from initialMessages on the resume path (uses extractTitleFromMessages)', async () => {
    const options = {
      session: {
        initialMessages: [
          { role: 'user', content: 'How do I migrate to Postgres 16?' },
        ],
      },
    } as KodaXOptions;

    const result = await resolveInitialMessages(options, 'sid-2');
    // extractTitleFromMessages truncates user-text content; non-empty assertion
    // is sufficient — exact truncation logic is owned by session.ts.
    expect(result.title.length).toBeGreaterThan(0);
  });

  it('CAP-SESSION-RESUME-001c: when no initialMessages but storage+sessionId exist, falls through to storage.load and returns the loaded bundle including extension state', async () => {
    const load = vi.fn().mockResolvedValue({
      messages: [{ role: 'user', content: 'persisted user' }],
      title: 'Resumed Session',
      gitRoot: '/repo',
      errorMetadata: { lastError: 'prior crash', lastErrorTime: 1, consecutiveErrors: 1 },
      extensionState: { 'ext-a': { k: 'v' } },
      extensionRecords: [],
    });
    const options = {
      session: { storage: { load, save: vi.fn() } as KodaXSessionStorage },
    } as KodaXOptions;

    const result = await resolveInitialMessages(options, 'sid-resume');

    expect(load).toHaveBeenCalledWith('sid-resume');
    expect(result.messages).toHaveLength(1);
    expect(result.title).toBe('Resumed Session');
    expect(result.errorMetadata?.lastError).toBe('prior crash');
    expect(result.loadedExtensionState).toEqual({ 'ext-a': { k: 'v' } });
    expect(result.loadedExtensionRecords).toEqual([]);
  });

  it('CAP-SESSION-RESUME-001d: initialMessages takes precedence over storage — when both are present, storage.load is NOT called', async () => {
    const load = vi.fn();
    const options = {
      session: {
        initialMessages: [{ role: 'user', content: 'live turn' }],
        storage: { load, save: vi.fn() } as KodaXSessionStorage,
      },
    } as KodaXOptions;

    await resolveInitialMessages(options, 'sid-both');
    expect(load).not.toHaveBeenCalled();
  });

  it('CAP-SESSION-RESUME-001e: when neither initialMessages nor storage+sessionId, returns empty bundle (no throw)', async () => {
    const result = await resolveInitialMessages({ session: {} } as KodaXOptions, undefined);
    expect(result.messages).toEqual([]);
    expect(result.title).toBe('');
    expect(result.errorMetadata).toBeUndefined();
    expect(result.loadedExtensionState).toBeUndefined();
    expect(result.loadedExtensionRecords).toBeUndefined();
  });

  it('CAP-SESSION-RESUME-001f: storage.load returns null → returns empty bundle (treats missing session as fresh)', async () => {
    const load = vi.fn().mockResolvedValue(null);
    const options = {
      session: { storage: { load, save: vi.fn() } as KodaXSessionStorage },
    } as KodaXOptions;

    const result = await resolveInitialMessages(options, 'sid-missing');
    expect(load).toHaveBeenCalledOnce();
    expect(result.messages).toEqual([]);
    expect(result.title).toBe('');
  });
});
