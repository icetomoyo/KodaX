/**
 * Contract test for CAP-049: context token snapshot rebase
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-049-context-token-snapshot-rebase
 *
 * Test obligations:
 * - CAP-TOKEN-REBASE-001: rebase reflects added/removed messages —
 *   `baselineEstimatedTokens` updates to the current buffer length
 * - CAP-TOKEN-REBASE-002: snapshot's source/usage are preserved across
 *   rebase (only token counts realign)
 * - CAP-TOKEN-REBASE-003: when no prior snapshot is provided, the
 *   rebased snapshot defaults source to 'estimate'
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: token-accounting.ts:122 (`rebaseContextTokenSnapshot`).
 *
 * Time-ordering constraint: AFTER message mutation; BEFORE next
 * emitIterationEnd or terminal.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6j.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXMessage } from '@kodax/ai';
import { rebaseContextTokenSnapshot } from '../../token-accounting.js';

const SHORT_MESSAGES: KodaXMessage[] = [
  { role: 'user', content: 'hi' },
];
const LONGER_MESSAGES: KodaXMessage[] = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello there, can I help you with something today?' },
  { role: 'user', content: 'tell me about token estimation across multiple messages' },
];

describe('CAP-049: context token snapshot rebase contract', () => {
  it('CAP-TOKEN-REBASE-001: baselineEstimatedTokens grows when messages are added to the buffer', () => {
    const beforeAdd = rebaseContextTokenSnapshot(SHORT_MESSAGES);
    const afterAdd = rebaseContextTokenSnapshot(LONGER_MESSAGES);
    expect(afterAdd.baselineEstimatedTokens).toBeGreaterThan(beforeAdd.baselineEstimatedTokens);
  });

  it('CAP-TOKEN-REBASE-001b: baselineEstimatedTokens shrinks when messages are removed from the buffer', () => {
    const beforeShrink = rebaseContextTokenSnapshot(LONGER_MESSAGES);
    const afterShrink = rebaseContextTokenSnapshot(SHORT_MESSAGES);
    expect(afterShrink.baselineEstimatedTokens).toBeLessThan(beforeShrink.baselineEstimatedTokens);
  });

  it('CAP-TOKEN-REBASE-002: prior snapshot source and usage are preserved across rebase', () => {
    const priorSnapshot = {
      currentTokens: 5000,
      baselineEstimatedTokens: 4800,
      source: 'api' as const,
      usage: { inputTokens: 4500, outputTokens: 500, totalTokens: 5000 },
    };
    const rebased = rebaseContextTokenSnapshot(LONGER_MESSAGES, priorSnapshot);
    // source + usage preserved verbatim
    expect(rebased.source).toBe('api');
    expect(rebased.usage).toBe(priorSnapshot.usage);
    // baselineEstimatedTokens recomputed from new messages
    expect(rebased.baselineEstimatedTokens).not.toBe(priorSnapshot.baselineEstimatedTokens);
  });

  it('CAP-TOKEN-REBASE-003: when no prior snapshot is provided, the rebased snapshot has source = "estimate" and undefined usage', () => {
    const rebased = rebaseContextTokenSnapshot(LONGER_MESSAGES);
    expect(rebased.source).toBe('estimate');
    expect(rebased.usage).toBeUndefined();
  });

  it('CAP-TOKEN-REBASE-003b: null prior snapshot is treated the same as undefined', () => {
    const rebased = rebaseContextTokenSnapshot(LONGER_MESSAGES, null);
    expect(rebased.source).toBe('estimate');
    expect(rebased.usage).toBeUndefined();
  });
});
