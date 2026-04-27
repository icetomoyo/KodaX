/**
 * Contract test for CAP-074: L5 max_tokens continuation.
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-074-l5-max_tokens-continuation
 *
 * Test obligations:
 * - CAP-MAX-TOKENS-CONT-001: synthetic continuation message uses "resume mid-thought" wording
 * - CAP-MAX-TOKENS-CONT-002: skipped when tool_blocks present
 * - CAP-MAX-TOKENS-CONT-003: 3-retry cap enforced
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/max-tokens-continuation.ts:maybeContinueAfterMaxTokens
 * (extracted from agent.ts:976-996 — pre-FEATURE_100 baseline —
 * during FEATURE_100 P3.5a).
 *
 * Time-ordering constraint: AFTER assistant push to history; BEFORE
 * managed-protocol auto-continue (CAP-075) and tool-blocks-empty branch.
 *
 * Active here:
 *   - stopReason !== 'max_tokens' → no_op
 *   - tool_blocks.length > 0 → no_op (partial-JSON salvage)
 *   - first 3 max_tokens hits → continue (synthetic message + counter++)
 *   - 4th hit → exhausted (onRetry fires, no message pushed, counter still increments)
 *
 * STATUS: ACTIVE since FEATURE_100 P3.5a.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXMessage, KodaXStreamResult } from '@kodax/ai';
import type { KodaXContextTokenSnapshot, KodaXEvents } from '../../types.js';

import { maybeContinueAfterMaxTokens } from '../max-tokens-continuation.js';
import { KODAX_MAX_MAXTOKENS_RETRIES } from '../../constants.js';

function fakeSnapshot(): KodaXContextTokenSnapshot {
  return { currentTokens: 100, source: 'estimated' } as unknown as KodaXContextTokenSnapshot;
}

function makeResult(overrides: Partial<KodaXStreamResult> = {}): KodaXStreamResult {
  return {
    stopReason: 'end_turn',
    textBlocks: [],
    toolBlocks: [],
    thinkingBlocks: [],
    usage: {} as KodaXStreamResult['usage'],
    ...overrides,
  } as KodaXStreamResult;
}

describe('CAP-074: maybeContinueAfterMaxTokens — gate conditions', () => {
  it('CAP-MAX-TOKENS-CONT-NO-OP-1: stopReason !== max_tokens → no_op, counter unchanged, no event fires, messages unmutated', () => {
    const messages: KodaXMessage[] = [];
    const onTextDelta = vi.fn();
    const out = maybeContinueAfterMaxTokens({
      result: makeResult({ stopReason: 'end_turn' }),
      messages,
      maxTokensRetryCount: 0,
      completedTurnTokenSnapshot: fakeSnapshot(),
      events: { onTextDelta },
    });
    expect(out.outcome).toBe('no_op');
    expect(out.nextMaxTokensRetryCount).toBe(0);
    expect(onTextDelta).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
  });

  it('CAP-MAX-TOKENS-CONT-002: stopReason=max_tokens AND tool_blocks present → no_op (partial-JSON salvage handles via next turn)', () => {
    const messages: KodaXMessage[] = [];
    const out = maybeContinueAfterMaxTokens({
      result: makeResult({
        stopReason: 'max_tokens',
        toolBlocks: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] as unknown as KodaXStreamResult['toolBlocks'],
      }),
      messages,
      maxTokensRetryCount: 0,
      completedTurnTokenSnapshot: fakeSnapshot(),
      events: {},
    });
    expect(out.outcome).toBe('no_op');
    expect(out.nextMaxTokensRetryCount).toBe(0);
    expect(messages).toEqual([]);
  });
});

describe('CAP-074: maybeContinueAfterMaxTokens — under cap (continue path)', () => {
  it('CAP-MAX-TOKENS-CONT-001: stopReason=max_tokens AND no tool_blocks → continue, synthetic user message uses canonical "resume mid-thought" wording, counter increments, onTextDelta fires', () => {
    const messages: KodaXMessage[] = [{ role: 'assistant', content: 'cut mid-thought' }];
    const onTextDelta = vi.fn();
    const out = maybeContinueAfterMaxTokens({
      result: makeResult({ stopReason: 'max_tokens' }),
      messages,
      maxTokensRetryCount: 0,
      completedTurnTokenSnapshot: fakeSnapshot(),
      events: { onTextDelta },
    });
    expect(out.outcome).toBe('continue');
    expect(out.nextMaxTokensRetryCount).toBe(1);
    expect(onTextDelta).toHaveBeenCalledExactlyOnceWith('\n\n[output token limit hit, continuing…]\n\n');
    expect(messages).toHaveLength(2);
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!._synthetic).toBe(true);
    const blocks = messages[1]!.content as Array<{ type: string; text: string }>;
    expect(blocks[0]!.text).toMatch(/Resume directly/);
    expect(blocks[0]!.text).toMatch(/no apology, no recap/);
    expect(blocks[0]!.text).toMatch(/Pick up mid-thought/);
    expect(blocks[0]!.text).toMatch(/Break remaining work into smaller pieces/);
  });

  it('CAP-MAX-TOKENS-CONT-COUNTER-MONOTONE: counter compounds across consecutive max_tokens hits up to the cap', () => {
    const messages: KodaXMessage[] = [];
    let counter = 0;
    for (let i = 1; i <= KODAX_MAX_MAXTOKENS_RETRIES; i++) {
      const out = maybeContinueAfterMaxTokens({
        result: makeResult({ stopReason: 'max_tokens' }),
        messages,
        maxTokensRetryCount: counter,
        completedTurnTokenSnapshot: fakeSnapshot(),
        events: {},
      });
      expect(out.outcome).toBe('continue');
      counter = out.nextMaxTokensRetryCount;
      expect(counter).toBe(i);
    }
    expect(messages).toHaveLength(KODAX_MAX_MAXTOKENS_RETRIES);
  });
});

describe('CAP-074: maybeContinueAfterMaxTokens — at cap (exhausted path)', () => {
  it('CAP-MAX-TOKENS-CONT-003: at cap → exhausted, onRetry fires with canonical truncation message, NO synthetic user message pushed, counter still increments', () => {
    const messages: KodaXMessage[] = [];
    const onRetry = vi.fn();
    const onTextDelta = vi.fn();
    const out = maybeContinueAfterMaxTokens({
      result: makeResult({ stopReason: 'max_tokens' }),
      messages,
      maxTokensRetryCount: KODAX_MAX_MAXTOKENS_RETRIES, // already at cap → next attempt = cap+1
      completedTurnTokenSnapshot: fakeSnapshot(),
      events: { onRetry, onTextDelta },
    });
    expect(out.outcome).toBe('exhausted');
    expect(out.nextMaxTokensRetryCount).toBe(KODAX_MAX_MAXTOKENS_RETRIES + 1);
    // No retry message + no continuation delta on the exhausted branch.
    expect(onTextDelta).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
    expect(onRetry).toHaveBeenCalledOnce();
    const onRetryArgs = onRetry.mock.calls[0]!;
    expect(onRetryArgs[0]).toMatch(
      new RegExp(`max_tokens truncation limit reached \\(${KODAX_MAX_MAXTOKENS_RETRIES}/${KODAX_MAX_MAXTOKENS_RETRIES}\\)`),
    );
    expect(onRetryArgs[1]).toBe(KODAX_MAX_MAXTOKENS_RETRIES);
    expect(onRetryArgs[2]).toBe(KODAX_MAX_MAXTOKENS_RETRIES);
  });
});
