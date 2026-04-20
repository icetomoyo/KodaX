/**
 * Unit test for LineageCompaction delegate wiring (FEATURE_082 v0.7.24).
 */

import { describe, expect, it, vi } from 'vitest';

import { createInMemorySession, type CompactionContext } from '@kodax/core';

import { LineageCompaction } from './compaction.js';

describe('LineageCompaction', () => {
  it('throws when required delegates are missing', () => {
    expect(() => new LineageCompaction({} as never)).toThrow(
      /shouldCompact.*compact.*required/i,
    );
  });

  it('delegates shouldCompact to the injected function', () => {
    const shouldCompact = vi.fn(() => true);
    const compact = vi.fn(async () => ({ summary: '', replacedMessageEntryIds: [] }));
    const policy = new LineageCompaction({ shouldCompact, compact });
    const session = createInMemorySession();

    const result = policy.shouldCompact(session, 1000, 2000);

    expect(result).toBe(true);
    expect(shouldCompact).toHaveBeenCalledWith(session, 1000, 2000);
  });

  it('delegates compact to the injected function and returns its result', async () => {
    const shouldCompact = vi.fn(() => false);
    const compact = vi.fn(async () => ({
      summary: 'delegated summary',
      replacedMessageEntryIds: ['msg-1', 'msg-2'],
    }));
    const policy = new LineageCompaction({ shouldCompact, compact });
    const session = createInMemorySession();
    const ctx: CompactionContext = {
      tokensUsed: 1000,
      budget: 2000,
      summarize: async () => 'irrelevant',
    };

    const out = await policy.compact(session, ctx);

    expect(out.summary).toBe('delegated summary');
    expect(out.replacedMessageEntryIds).toEqual(['msg-1', 'msg-2']);
    expect(compact).toHaveBeenCalledWith(session, ctx);
  });

  it('restore is a no-op when no delegate is provided', async () => {
    const policy = new LineageCompaction({
      shouldCompact: () => false,
      compact: async () => ({ summary: '', replacedMessageEntryIds: [] }),
    });
    const session = createInMemorySession();

    await expect(policy.restore(session, { hint: 'any' })).resolves.toBeUndefined();
  });

  it('restore delegates when a delegate is provided', async () => {
    const restore = vi.fn(async () => { /* no-op */ });
    const policy = new LineageCompaction({
      shouldCompact: () => false,
      compact: async () => ({ summary: '', replacedMessageEntryIds: [] }),
      restore,
    });
    const session = createInMemorySession();

    await policy.restore(session, { hint: 'some-hint' });

    expect(restore).toHaveBeenCalledWith(session, { hint: 'some-hint' });
  });
});
