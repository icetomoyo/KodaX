/**
 * Unit tests for `DefaultSummaryCompaction`.
 *
 * Covers FEATURE_081 Layer A compaction contract on an in-memory Session.
 */

import { describe, expect, it, vi } from 'vitest';

import { DefaultSummaryCompaction, type CompactionContext } from './compaction.js';
import { createInMemorySession, type MessageEntry } from './session.js';

const makeMessageEntry = (id: string, role: 'user' | 'assistant', text: string): MessageEntry => ({
  id,
  ts: 0,
  type: 'message',
  payload: { role, content: text },
});

describe('DefaultSummaryCompaction', () => {
  describe('constructor validation', () => {
    it('rejects thresholdRatio <= 0', () => {
      expect(() => new DefaultSummaryCompaction({ thresholdRatio: 0 })).toThrow(/thresholdRatio/);
      expect(() => new DefaultSummaryCompaction({ thresholdRatio: -0.1 })).toThrow(/thresholdRatio/);
    });

    it('rejects thresholdRatio > 1', () => {
      expect(() => new DefaultSummaryCompaction({ thresholdRatio: 1.1 })).toThrow(/thresholdRatio/);
    });

    it('rejects negative keepRecent', () => {
      expect(() => new DefaultSummaryCompaction({ keepRecent: -1 })).toThrow(/keepRecent/);
    });

    it('accepts defaults', () => {
      expect(() => new DefaultSummaryCompaction()).not.toThrow();
    });
  });

  describe('shouldCompact', () => {
    const policy = new DefaultSummaryCompaction({ thresholdRatio: 0.8 });
    const session = createInMemorySession();

    it('returns false when budget is 0', () => {
      expect(policy.shouldCompact(session, 1000, 0)).toBe(false);
    });

    it('returns false when under threshold', () => {
      expect(policy.shouldCompact(session, 799, 1000)).toBe(false);
    });

    it('returns true at threshold', () => {
      expect(policy.shouldCompact(session, 800, 1000)).toBe(true);
    });

    it('returns true above threshold', () => {
      expect(policy.shouldCompact(session, 950, 1000)).toBe(true);
    });

    it('honors custom thresholdRatio', () => {
      const custom = new DefaultSummaryCompaction({ thresholdRatio: 0.5 });
      expect(custom.shouldCompact(session, 499, 1000)).toBe(false);
      expect(custom.shouldCompact(session, 500, 1000)).toBe(true);
    });

    it('returns false when tokensUsed or budget is NaN', () => {
      expect(policy.shouldCompact(session, Number.NaN, 1000)).toBe(false);
      expect(policy.shouldCompact(session, 1000, Number.NaN)).toBe(false);
    });
  });

  describe('compact', () => {
    const buildCtx = (summary: string): CompactionContext => ({
      tokensUsed: 1000,
      budget: 1000,
      summarize: vi.fn(async () => summary),
    });

    it('no-ops when message count <= keepRecent', async () => {
      const policy = new DefaultSummaryCompaction({ keepRecent: 5 });
      const session = createInMemorySession({
        initialEntries: [
          makeMessageEntry('m1', 'user', 'hi'),
          makeMessageEntry('m2', 'assistant', 'hello'),
        ],
      });
      const ctx = buildCtx('summary');
      const result = await policy.compact(session, ctx);
      expect(result.summary).toBe('');
      expect(result.replacedMessageEntryIds).toEqual([]);
      expect(ctx.summarize).not.toHaveBeenCalled();
    });

    it('compacts older messages, keeps recent, appends compaction entry', async () => {
      const policy = new DefaultSummaryCompaction({
        keepRecent: 2,
        now: () => 1_700_000_000_000,
        randomSuffix: () => 'abc123',
      });
      const session = createInMemorySession({
        initialEntries: [
          makeMessageEntry('m1', 'user', 'q1'),
          makeMessageEntry('m2', 'assistant', 'a1'),
          makeMessageEntry('m3', 'user', 'q2'),
          makeMessageEntry('m4', 'assistant', 'a2'),
          makeMessageEntry('m5', 'user', 'q3'),
        ],
      });
      const ctx = buildCtx('earlier convo covered q1/q2');
      const result = await policy.compact(session, ctx);

      expect(result.summary).toBe('earlier convo covered q1/q2');
      expect(result.replacedMessageEntryIds).toEqual(['m1', 'm2', 'm3']);
      expect(ctx.summarize).toHaveBeenCalledTimes(1);
      const callArg = (ctx.summarize as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(callArg).toHaveLength(3);
      expect(callArg[0]).toEqual({ role: 'user', content: 'q1' });
      expect(callArg[2]).toEqual({ role: 'user', content: 'q2' });

      const appended: Array<{ type: string }> = [];
      for await (const entry of session.entries()) {
        appended.push({ type: entry.type });
      }
      const compactionEntries = appended.filter((e) => e.type === 'compaction');
      expect(compactionEntries).toHaveLength(1);
    });

    it('ignores non-message entries when selecting candidates', async () => {
      const policy = new DefaultSummaryCompaction({
        keepRecent: 1,
        now: () => 1_700_000_000_000,
        randomSuffix: () => 'x',
      });
      const session = createInMemorySession({
        initialEntries: [
          makeMessageEntry('m1', 'user', 'q1'),
          { id: 'label1', ts: 0, type: 'label', payload: { name: 'checkpoint' } },
          makeMessageEntry('m2', 'assistant', 'a1'),
          makeMessageEntry('m3', 'user', 'q2'),
        ],
      });
      const ctx = buildCtx('sum');
      const result = await policy.compact(session, ctx);
      expect(result.replacedMessageEntryIds).toEqual(['m1', 'm2']);
    });

    it('is deterministic when now+randomSuffix are injected', async () => {
      const policy = new DefaultSummaryCompaction({
        keepRecent: 1,
        now: () => 42,
        randomSuffix: () => 'deterministic',
      });
      const session = createInMemorySession({
        initialEntries: [
          makeMessageEntry('m1', 'user', 'a'),
          makeMessageEntry('m2', 'assistant', 'b'),
          makeMessageEntry('m3', 'user', 'c'),
        ],
      });
      await policy.compact(session, buildCtx('s'));
      const collected: Array<{ id: string; type: string }> = [];
      for await (const entry of session.entries()) {
        collected.push({ id: entry.id, type: entry.type });
      }
      const compactionEntry = collected.find((e) => e.type === 'compaction');
      expect(compactionEntry?.id).toMatch(/^compaction-42-\d+-deterministic$/);
    });
  });

  describe('Session in-memory adapter', () => {
    it('yields entries in append order', async () => {
      const session = createInMemorySession();
      await session.append(makeMessageEntry('m1', 'user', 'a'));
      await session.append(makeMessageEntry('m2', 'assistant', 'b'));
      const out: string[] = [];
      for await (const entry of session.entries()) out.push(entry.id);
      expect(out).toEqual(['m1', 'm2']);
    });

    it('fork copies current entries but diverges on further appends', async () => {
      const session = createInMemorySession();
      await session.append(makeMessageEntry('m1', 'user', 'a'));
      const forked = await session.fork({ name: 'branch-1' });
      await session.append(makeMessageEntry('m2', 'assistant', 'b'));
      const original: string[] = [];
      const fork: string[] = [];
      for await (const entry of session.entries()) original.push(entry.id);
      for await (const entry of forked.entries()) fork.push(entry.id);
      expect(original).toEqual(['m1', 'm2']);
      expect(fork).toEqual(['m1']);
      expect(forked.metadata.get('name')).toBe('branch-1');
    });
  });
});
