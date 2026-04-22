/**
 * Shard 6d-k — Scout suspicious-completion detection tests.
 *
 * Covers detectScoutSuspiciousSignals + its three signal categories:
 *   - S1 `mutation-expected-but-none`
 *   - S2 `budget-exhausted`
 *   - S5 `no-formal-completion`
 * plus the pure helpers `hadPriorAssistantToolCall` /
 * `lastAssistantHadNoTool` / `looksLikeCompletionText`.
 */

import { describe, expect, it } from 'vitest';
import type { KodaXMessage, ManagedMutationTracker } from '../../../types.js';
import {
  detectScoutSuspiciousSignals,
  hadPriorAssistantToolCall,
  lastAssistantHadNoTool,
  looksLikeCompletionText,
} from './scout-signals.js';

function assistantMsg(
  content: Array<{ type: 'text' | 'tool_use'; text?: string; name?: string }>,
): KodaXMessage {
  return {
    role: 'assistant',
    content: content.map((c) =>
      c.type === 'text'
        ? { type: 'text' as const, text: c.text ?? '' }
        : {
            type: 'tool_use' as const,
            id: 'tu1',
            name: c.name ?? 'read',
            input: {},
          },
    ),
  } as KodaXMessage;
}

function userMsg(text: string): KodaXMessage {
  return { role: 'user', content: [{ type: 'text', text }] } as KodaXMessage;
}

const EMPTY_TRACKER: ManagedMutationTracker = { files: new Map(), totalOps: 0 };
const ONE_FILE_TRACKER: ManagedMutationTracker = {
  files: new Map([['docs/x.md', 1]]),
  totalOps: 1,
};

describe('hadPriorAssistantToolCall / lastAssistantHadNoTool', () => {
  it('returns false when there is only one assistant turn', () => {
    const msgs = [userMsg('hi'), assistantMsg([{ type: 'tool_use', name: 'read' }])];
    expect(hadPriorAssistantToolCall(msgs)).toBe(false);
  });

  it('returns true when an earlier assistant turn used a tool', () => {
    const msgs = [
      userMsg('hi'),
      assistantMsg([{ type: 'tool_use', name: 'read' }]),
      userMsg('continue'),
      assistantMsg([{ type: 'text', text: 'done' }]),
    ];
    expect(hadPriorAssistantToolCall(msgs)).toBe(true);
    expect(lastAssistantHadNoTool(msgs)).toBe(true);
  });

  it('lastAssistantHadNoTool returns false when last assistant used a tool', () => {
    const msgs = [assistantMsg([{ type: 'tool_use', name: 'read' }])];
    expect(lastAssistantHadNoTool(msgs)).toBe(false);
  });
});

describe('looksLikeCompletionText', () => {
  it('matches English completion vocabulary', () => {
    expect(looksLikeCompletionText('Done! Everything is fixed.', undefined)).toBe(true);
    expect(looksLikeCompletionText('Implemented and tested.', undefined)).toBe(true);
  });

  it('matches Chinese completion vocabulary', () => {
    expect(looksLikeCompletionText('已完成，没发现问题。', undefined)).toBe(true);
    expect(looksLikeCompletionText('修好了。', undefined)).toBe(true);
  });

  it('falls back to structure for long structured answers when not open', () => {
    const longAnswer = '# Analysis\n\n' + '- point one\n- point two\n- point three\n'.repeat(10);
    expect(looksLikeCompletionText(longAnswer, 'docs-scoped')).toBe(true);
    expect(looksLikeCompletionText(longAnswer, undefined)).toBe(true);
  });

  it('rejects structure fallback for open mutation tasks', () => {
    const longAnswer = '# Plan\n\n' + '1. step one\n2. step two\n3. step three\n'.repeat(10);
    expect(looksLikeCompletionText(longAnswer, 'open')).toBe(false);
  });

  it('returns false for empty text', () => {
    expect(looksLikeCompletionText(undefined, undefined)).toBe(false);
    expect(looksLikeCompletionText('', undefined)).toBe(false);
  });
});

describe('detectScoutSuspiciousSignals — S1 mutation-expected-but-none', () => {
  it('fires when open + zero mutations + no Scout payload', () => {
    const signals = detectScoutSuspiciousSignals({
      messages: [userMsg('fix bug'), assistantMsg([{ type: 'text', text: '...' }])],
      lastText: 'looking into it',
      hasScoutPayload: false,
      scoutMutationIntent: 'open',
      mutationTracker: EMPTY_TRACKER,
      budgetExhausted: false,
    });
    expect(signals).toContain('mutation-expected-but-none');
  });

  it('does not fire when mutations were tracked', () => {
    const signals = detectScoutSuspiciousSignals({
      messages: [userMsg('fix'), assistantMsg([{ type: 'text', text: 'fixed' }])],
      lastText: 'done',
      hasScoutPayload: false,
      scoutMutationIntent: 'open',
      mutationTracker: ONE_FILE_TRACKER,
      budgetExhausted: false,
    });
    expect(signals).not.toContain('mutation-expected-but-none');
  });

  it('does not fire when inferred intent is docs-scoped or review-only', () => {
    for (const intent of ['docs-scoped', 'review-only', undefined] as const) {
      const signals = detectScoutSuspiciousSignals({
        messages: [userMsg('review'), assistantMsg([{ type: 'text', text: 'LGTM' }])],
        lastText: 'LGTM',
        hasScoutPayload: false,
        scoutMutationIntent: intent,
        mutationTracker: EMPTY_TRACKER,
        budgetExhausted: false,
      });
      expect(signals).not.toContain('mutation-expected-but-none');
    }
  });
});

describe('detectScoutSuspiciousSignals — S2 budget-exhausted', () => {
  it('fires when budgetExhausted is true', () => {
    const signals = detectScoutSuspiciousSignals({
      messages: [userMsg('x'), assistantMsg([{ type: 'text', text: 'done' }])],
      lastText: 'done',
      hasScoutPayload: true,
      scoutMutationIntent: undefined,
      mutationTracker: EMPTY_TRACKER,
      budgetExhausted: true,
    });
    expect(signals).toContain('budget-exhausted');
  });

  it('fires when limitReached is true (legacy compat)', () => {
    const signals = detectScoutSuspiciousSignals({
      messages: [userMsg('x'), assistantMsg([{ type: 'text', text: 'done' }])],
      lastText: 'done',
      hasScoutPayload: true,
      scoutMutationIntent: undefined,
      mutationTracker: EMPTY_TRACKER,
      budgetExhausted: false,
      limitReached: true,
    });
    expect(signals).toContain('budget-exhausted');
  });
});

describe('detectScoutSuspiciousSignals — S5 no-formal-completion', () => {
  it('fires when prior assistant used a tool, last assistant did not, no completion words, no Scout payload', () => {
    const signals = detectScoutSuspiciousSignals({
      messages: [
        userMsg('what does foo do?'),
        assistantMsg([{ type: 'tool_use', name: 'read' }]),
        userMsg('…'),
        assistantMsg([{ type: 'text', text: 'checking it out now' }]),
      ],
      lastText: 'checking it out now',
      hasScoutPayload: false,
      scoutMutationIntent: undefined,
      mutationTracker: EMPTY_TRACKER,
      budgetExhausted: false,
    });
    expect(signals).toContain('no-formal-completion');
  });

  it('does not fire when Scout payload exists (explicit signal)', () => {
    const signals = detectScoutSuspiciousSignals({
      messages: [
        assistantMsg([{ type: 'tool_use', name: 'read' }]),
        assistantMsg([{ type: 'text', text: '...' }]),
      ],
      lastText: '...',
      hasScoutPayload: true,
      scoutMutationIntent: undefined,
      mutationTracker: EMPTY_TRACKER,
      budgetExhausted: false,
    });
    expect(signals).not.toContain('no-formal-completion');
  });

  it('does not fire when completion vocabulary is present', () => {
    const signals = detectScoutSuspiciousSignals({
      messages: [
        assistantMsg([{ type: 'tool_use', name: 'read' }]),
        assistantMsg([{ type: 'text', text: 'Done, the fix is in place.' }]),
      ],
      lastText: 'Done, the fix is in place.',
      hasScoutPayload: false,
      scoutMutationIntent: undefined,
      mutationTracker: EMPTY_TRACKER,
      budgetExhausted: false,
    });
    expect(signals).not.toContain('no-formal-completion');
  });
});
