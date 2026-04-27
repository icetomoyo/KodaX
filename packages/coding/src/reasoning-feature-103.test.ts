/**
 * FEATURE_103 contract tests — L5 user-followup escalate (v0.7.29).
 *
 * Covers:
 *   - `detectFollowupSignal` doubt + deepen dictionaries (Chinese + English)
 *   - Doubt markers require prior assistant turn; deepen markers fire any time
 *   - `escalateUserCeiling` single-rank bump invariants (off sacrosanct;
 *     deep is fixed point; off-by-one across the canonical sequence)
 *   - `applyFollowupEscalation` end-to-end: returns same reference when no
 *     signal fires; bumps when triggered; respects off kill switch
 *   - `applyFollowupEscalationToOptions` integration: reads session prior
 *     turns, returns options unchanged when no escalation, fresh options
 *     with bumped reasoningMode when escalated
 *
 * The L5 layer is purely additive on top of FEATURE_078 — it never lowers
 * depth, never overrides L4 (Evaluator-revise escalate), and respects the
 * off kill switch. These tests pin those invariants.
 */

import { describe, expect, it } from 'vitest';

import {
  applyFollowupEscalation,
  applyFollowupEscalationToOptions,
  detectFollowupSignal,
  escalateUserCeiling,
} from './reasoning.js';
import type { KodaXMessage, KodaXOptions } from './types.js';

// ---------------------------------------------------------------------------
// detectFollowupSignal — dictionary + round-gate behaviour
// ---------------------------------------------------------------------------

describe('detectFollowupSignal — doubt category (Chinese)', () => {
  it('matches "不对" only when there is a prior assistant turn', () => {
    expect(detectFollowupSignal('这个不对吧', true)).toMatchObject({
      category: 'doubt',
      matched: '不对',
    });
    expect(detectFollowupSignal('这个不对吧', false)).toMatchObject({
      category: null,
      matched: null,
    });
  });

  it('matches "错了" / "有问题" / "真的吗" / "你确定"', () => {
    expect(detectFollowupSignal('你这个错了', true).category).toBe('doubt');
    expect(detectFollowupSignal('这有问题', true).category).toBe('doubt');
    expect(detectFollowupSignal('真的吗？', true).category).toBe('doubt');
    expect(detectFollowupSignal('你确定？', true).category).toBe('doubt');
  });

  it('matches "弄错了" / "搞错了" / "搞反了"', () => {
    expect(detectFollowupSignal('你弄错了', true).category).toBe('doubt');
    expect(detectFollowupSignal('搞错了', true).category).toBe('doubt');
    expect(detectFollowupSignal('搞反了顺序', true).category).toBe('doubt');
  });
});

describe('detectFollowupSignal — doubt category (English)', () => {
  it('matches "are you sure" case-insensitively', () => {
    expect(detectFollowupSignal('Are you sure about this?', true).category).toBe('doubt');
    expect(detectFollowupSignal('ARE YOU SURE?', true).category).toBe('doubt');
  });

  it("matches \"that's wrong\" / \"that is wrong\" / \"this is wrong\"", () => {
    expect(detectFollowupSignal("That's wrong", true).category).toBe('doubt');
    expect(detectFollowupSignal('that is wrong', true).category).toBe('doubt');
    expect(detectFollowupSignal('This is wrong', true).category).toBe('doubt');
  });

  it('matches "you\'re wrong" / "not really"', () => {
    expect(detectFollowupSignal("You're wrong about that", true).category).toBe('doubt');
    expect(detectFollowupSignal('not really', true).category).toBe('doubt');
  });

  it('does not match standalone "wrong" or "not" out of context', () => {
    // Conservative dictionary — bare "wrong" or "not" would false-positive
    // on quoted text, code identifiers, etc. Only multi-word phrases match.
    expect(detectFollowupSignal('the wrong file', true).category).toBe(null);
    expect(detectFollowupSignal('not yet implemented', true).category).toBe(null);
  });
});

describe('detectFollowupSignal — deepen category fires regardless of round', () => {
  it('matches "仔细" / "深入" / "认真" without prior assistant turn', () => {
    expect(detectFollowupSignal('仔细分析一下', false)).toMatchObject({
      category: 'deepen',
      matched: '仔细',
    });
    expect(detectFollowupSignal('深入研究 X', false).category).toBe('deepen');
    expect(detectFollowupSignal('认真想想这个问题', false).category).toBe('deepen');
  });

  it('matches "再看看" / "再想想" / "想清楚"', () => {
    expect(detectFollowupSignal('再看看 main.ts', false).category).toBe('deepen');
    expect(detectFollowupSignal('再想想这个边界条件', false).category).toBe('deepen');
    expect(detectFollowupSignal('想清楚再回答', false).category).toBe('deepen');
  });

  it('matches "think harder" / "dig deeper" / "be thorough"', () => {
    expect(detectFollowupSignal('think harder about this', false).category).toBe('deepen');
    expect(detectFollowupSignal('dig deeper into the cache', false).category).toBe('deepen');
    expect(detectFollowupSignal('Be thorough', false).category).toBe('deepen');
  });

  it('matches "reconsider" / "reexamine" / "re-examine"', () => {
    expect(detectFollowupSignal('reconsider your answer', false).category).toBe('deepen');
    expect(detectFollowupSignal('reexamine the diff', false).category).toBe('deepen');
    expect(detectFollowupSignal('re-examine the build', false).category).toBe('deepen');
  });
});

describe('detectFollowupSignal — null cases', () => {
  it('returns null on empty / whitespace prompts', () => {
    expect(detectFollowupSignal('', true).category).toBe(null);
    expect(detectFollowupSignal('', false).category).toBe(null);
  });

  it('returns null on neutral prompts', () => {
    expect(detectFollowupSignal('add a test for X', true).category).toBe(null);
    expect(detectFollowupSignal('what is the type of foo', false).category).toBe(null);
    expect(detectFollowupSignal('请帮我重构这个函数', true).category).toBe(null);
  });

  it('doubt before deepen — first match wins, doubt is checked first', () => {
    // "不对" + "仔细" both present → doubt fires first.
    const signal = detectFollowupSignal('这个不对，请仔细看看', true);
    expect(signal.category).toBe('doubt');
    expect(signal.matched).toBe('不对');
  });
});

// ---------------------------------------------------------------------------
// escalateUserCeiling — single-rank bump invariants
// ---------------------------------------------------------------------------

describe('escalateUserCeiling', () => {
  it('off is sacrosanct (kill switch dominates)', () => {
    expect(escalateUserCeiling('off')).toBe('off');
  });

  it('auto bumps to quick', () => {
    expect(escalateUserCeiling('auto')).toBe('quick');
  });

  it('quick bumps to balanced', () => {
    expect(escalateUserCeiling('quick')).toBe('balanced');
  });

  it('balanced bumps to deep', () => {
    expect(escalateUserCeiling('balanced')).toBe('deep');
  });

  it('deep is the fixed point at the top', () => {
    expect(escalateUserCeiling('deep')).toBe('deep');
  });
});

// ---------------------------------------------------------------------------
// applyFollowupEscalation — pure end-to-end
// ---------------------------------------------------------------------------

describe('applyFollowupEscalation', () => {
  it('returns ceiling unchanged + escalated:false when no signal fires', () => {
    const result = applyFollowupEscalation('balanced', 'add a test for X', true);
    expect(result.effective).toBe('balanced');
    expect(result.escalated).toBe(false);
    expect(result.signal.category).toBe(null);
  });

  it('bumps balanced → deep on doubt with prior turn', () => {
    const result = applyFollowupEscalation('balanced', '这个不对吧', true);
    expect(result.effective).toBe('deep');
    expect(result.escalated).toBe(true);
    expect(result.signal.category).toBe('doubt');
  });

  it('bumps quick → balanced on deepen marker (no prior turn required)', () => {
    const result = applyFollowupEscalation('quick', '请仔细分析', false);
    expect(result.effective).toBe('balanced');
    expect(result.escalated).toBe(true);
    expect(result.signal.category).toBe('deepen');
  });

  it('off stays off even when doubt marker present (kill switch)', () => {
    const result = applyFollowupEscalation('off', '这个不对', true);
    expect(result.effective).toBe('off');
    expect(result.escalated).toBe(false);
    // Signal is still detected for telemetry/transparency, but does not
    // produce escalation.
    expect(result.signal.category).toBe('doubt');
  });

  it('deep stays deep when doubt marker present (already at top)', () => {
    const result = applyFollowupEscalation('deep', '这个不对', true);
    expect(result.effective).toBe('deep');
    expect(result.escalated).toBe(false);
    expect(result.signal.category).toBe('doubt');
  });

  it('doubt without prior turn does not escalate', () => {
    const result = applyFollowupEscalation('balanced', '这个不对', false);
    expect(result.effective).toBe('balanced');
    expect(result.escalated).toBe(false);
    expect(result.signal.category).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// applyFollowupEscalationToOptions — integration with KodaXOptions
// ---------------------------------------------------------------------------

const BASE_OPTIONS: KodaXOptions = {
  provider: 'anthropic',
  reasoningMode: 'balanced',
};

const PRIOR_ASSISTANT: KodaXMessage = {
  role: 'assistant',
  content: 'Here is the answer.',
};
const PRIOR_USER: KodaXMessage = {
  role: 'user',
  content: 'Tell me about X.',
};

describe('applyFollowupEscalationToOptions', () => {
  it('returns the input options reference when no signal fires', () => {
    const result = applyFollowupEscalationToOptions(BASE_OPTIONS, 'add a test');
    // Identity-preserving when no escalation — callers can rely on
    // `result.options === input` to skip downstream re-resolution.
    expect(result.options).toBe(BASE_OPTIONS);
    expect(result.escalation.escalated).toBe(false);
  });

  it('bumps reasoningMode + returns fresh options on doubt with prior assistant turn', () => {
    const opts: KodaXOptions = {
      ...BASE_OPTIONS,
      session: {
        initialMessages: [PRIOR_USER, PRIOR_ASSISTANT, PRIOR_USER],
      },
    };
    const result = applyFollowupEscalationToOptions(opts, '这个不对吧');
    expect(result.options).not.toBe(opts);
    expect(result.options.reasoningMode).toBe('deep');
    expect(result.escalation.escalated).toBe(true);
    expect(result.escalation.signal.category).toBe('doubt');
  });

  it('does not escalate doubt without prior assistant turn', () => {
    const opts: KodaXOptions = {
      ...BASE_OPTIONS,
      session: {
        initialMessages: [PRIOR_USER],
      },
    };
    const result = applyFollowupEscalationToOptions(opts, '这个不对');
    expect(result.options).toBe(opts);
    expect(result.escalation.escalated).toBe(false);
  });

  it('escalates deepen marker even on first turn (no prior history)', () => {
    const result = applyFollowupEscalationToOptions(BASE_OPTIONS, '请仔细分析');
    expect(result.options).not.toBe(BASE_OPTIONS);
    expect(result.options.reasoningMode).toBe('deep');
    expect(result.escalation.signal.category).toBe('deepen');
  });

  it('honours off kill switch even when signal present', () => {
    const opts: KodaXOptions = {
      provider: 'anthropic',
      reasoningMode: 'off',
      session: { initialMessages: [PRIOR_USER, PRIOR_ASSISTANT] },
    };
    const result = applyFollowupEscalationToOptions(opts, '这个不对');
    expect(result.options).toBe(opts); // no escalation → identity
    expect(result.options.reasoningMode).toBe('off');
    expect(result.escalation.escalated).toBe(false);
  });
});
